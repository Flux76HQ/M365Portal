// The no-egress guard (T-B-062, V-B06, PB-01, PBR-01). Test support: nothing under `src/` imports it,
// `server/no-test-hooks.test.ts` and `scripts/check_image_contents.py` keep it out of the image.
//
// Every TCP and TLS connection of a Node process starts in `net.Socket.prototype.connect`: `fetch`
// (undici), `node:http`, `node:https`, `node:http2` and any SDK that opens a socket by itself. MSW
// intercepts `fetch` and the request classes, but a service that imported `node:https` would still
// reach Microsoft from a green test (V-B05). So the guard sits at the socket: a connection to
// anything but the loopback interface is destroyed with an error whose `code` is `ENOEGRESS`,
// before the host name is resolved and before a single packet is sent.
//
// Allowed: 127.0.0.0/8, ::1, IPv4-mapped loopback, the name `localhost`, and Unix socket paths. Not
// covered, on purpose: UDP and DNS (no code of ours uses them), child processes (they do not inherit
// the patch; the tests that start one pass `NO_EGRESS` themselves), and a process that never loads
// this module. The Vitest setup file `install-no-egress.ts` loads it for every server test file; the
// e2e server process imports `installNoEgress` in its preload (T-B-370).
import net from 'node:net';

export const ENOEGRESS = 'ENOEGRESS';

/** What a connection that left the machine looks like to the code that opened it. */
export class NoEgressError extends Error {
  readonly code = ENOEGRESS;
  readonly syscall = 'connect';
  readonly address: string;
  readonly port: number | undefined;

  constructor(address: string, port: number | undefined) {
    super(
      `connect ${ENOEGRESS} ${address}${port === undefined ? '' : `:${String(port)}`} ` +
        '(blocked by the no-egress guard: tests may only talk to the loopback interface)',
    );
    this.name = 'NoEgressError';
    this.address = address;
    this.port = port;
  }
}

export type ConnectTarget =
  | { readonly kind: 'ipc'; readonly path: string }
  | { readonly kind: 'tcp'; readonly host: string; readonly port: number | undefined };

/** Node's `toNumber`: a non-negative number, or `false`. */
function asPortNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const number = Number(value);
  return number >= 0 ? number : undefined;
}

/**
 * What `socket.connect(...args)` is going to connect to, read the way Node reads its three forms:
 * `connect(options)`, `connect(path)` and `connect(port[, host])`, and the normalised array that
 * `net.connect` passes on. A host that is missing means
 * `localhost`, as in Node; a host that is not a string is read as the empty string, which is not
 * loopback.
 */
export function classifyConnectArguments(args: readonly unknown[], nested = false): ConnectTarget {
  const first = args[0];
  // `net.connect()` and `createConnection()` call `socket.connect(normalized)`, with the already
  // normalised `[options, callback]` array as the one argument. Read what is inside it.
  if (Array.isArray(first) && !nested) return classifyConnectArguments(first as unknown[], true);
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof options.path === 'string') return { kind: 'ipc', path: options.path };
    const host =
      options.host === undefined
        ? 'localhost'
        : typeof options.host === 'string'
          ? options.host
          : '';
    return { kind: 'tcp', host, port: asPortNumber(options.port) };
  }
  if (typeof first === 'string' && asPortNumber(first) === undefined) {
    return { kind: 'ipc', path: first };
  }
  const host = typeof args[1] === 'string' ? args[1] : 'localhost';
  return { kind: 'tcp', host, port: asPortNumber(first) };
}

/** Expands an IPv6 literal into its eight 16-bit groups, or `undefined` when it is not one. */
function ipv6Groups(address: string): number[] | undefined {
  if (!net.isIPv6(address)) return undefined;
  let text = address.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    const hi = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const lo = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const [head = '', rest, extra] = text.split('::');
  if (extra !== undefined) return undefined;
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 0) return undefined;
  const groups = [
    ...left,
    ...Array.from({ length: rest === undefined ? 0 : missing }, () => '0'),
    ...right,
  ];
  const numbers = groups.map((group) => Number.parseInt(group, 16));
  return numbers.length === 8 && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? numbers
    : undefined;
}

/** True for the loopback interface and for nothing else. */
export function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  if (net.isIPv4(host)) return host.startsWith('127.');
  const groups = ipv6Groups(host);
  if (groups === undefined) return false;
  const isZero = (from: number, to: number): boolean =>
    groups.slice(from, to).every((g) => g === 0);
  if (isZero(0, 7) && groups[7] === 1) return true; // ::1
  if (isZero(0, 5) && groups[5] === 0xffff) return (groups[6] ?? 0) >> 8 === 127; // ::ffff:127.x.x.x
  return false;
}

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;

let uninstallGuard: (() => void) | undefined;

/** True while the guard is on `net.Socket.prototype.connect`. */
export function isNoEgressInstalled(): boolean {
  return uninstallGuard !== undefined;
}

/**
 * Patches `net.Socket.prototype.connect`. Idempotent: a second call changes nothing and returns the
 * same function. The function it returns removes the patch (the guard's own test uses it).
 */
export function installNoEgress(): () => void {
  if (uninstallGuard !== undefined) return uninstallGuard;
  const prototype = net.Socket.prototype as unknown as { connect: Connect };
  const original = prototype.connect;

  prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const target = classifyConnectArguments(args);
    if (target.kind === 'tcp' && !isLoopbackHost(target.host)) {
      const error = new NoEgressError(target.host, target.port);
      // Node reports a connection that failed through the 'error' event of the socket, later.
      (this as unknown as { connecting: boolean }).connecting = true;
      process.nextTick(() => {
        this.destroy(error);
      });
      return this;
    }
    return original.apply(this, args);
  };

  uninstallGuard = () => {
    prototype.connect = original;
    uninstallGuard = undefined;
  };
  return uninstallGuard;
}
