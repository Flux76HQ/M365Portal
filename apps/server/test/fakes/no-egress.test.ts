// T-B-062, V-B06, PB-01, PBR-01, XB14: every test process runs behind the no-egress guard.
//
// MSW intercepts `fetch` and `http.ClientRequest`'s mocked paths, but not a socket opened through
// `node:https` or `node:net` (V-B05): a service that imported `node:https` would reach Microsoft for
// real from a green test. The guard sits one layer lower, on `net.Socket.prototype.connect`, which
// every TCP and TLS connection of Node goes through, `fetch` (undici) included. A connection to
// anything but the loopback interface is destroyed with the error code `ENOEGRESS`.
//
// The setup file `test/support/install-no-egress.ts` (vitest.config.ts `setupFiles`, seam XB14)
// installs it for the whole `server` project, so these tests run under the guard they test.
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { expectGuardFails } from '@m365portal/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENOEGRESS,
  NoEgressError,
  classifyConnectArguments,
  installNoEgress,
  isLoopbackHost,
  isNoEgressInstalled,
} from '../support/no-egress.js';

/** Opens a connection and resolves with the error code it failed with (or `connected`). */
async function connectAndReport(...args: Parameters<typeof net.connect>): Promise<string> {
  const socket = net.connect(...args);
  try {
    await once(socket, 'connect');
    return 'connected';
  } catch (failure) {
    return String((failure as { code?: unknown }).code);
  } finally {
    socket.destroy();
  }
}

describe('the guard is active in every test process (XB14)', () => {
  it('is installed by the Vitest setup file, without any per-test code', () => {
    expect(isNoEgressInstalled()).toBe(true);
  });

  it('exports its error code for the e2e preload', () => {
    expect(ENOEGRESS).toBe('ENOEGRESS');
    const error = new NoEgressError('login.microsoftonline.com', 443);
    expect(error.code).toBe('ENOEGRESS');
    expect(error.syscall).toBe('connect');
    expect(error.address).toBe('login.microsoftonline.com');
    expect(error.port).toBe(443);
    expect(error.message).toContain('ENOEGRESS');
  });

  it('is installed once however often it is asked for (no stacking of wrappers)', () => {
    const before = net.Socket.prototype.connect;
    const uninstall = installNoEgress();
    const again = installNoEgress();
    expect(net.Socket.prototype.connect).toBe(before);
    expect(again).toBe(uninstall);
    expect(isNoEgressInstalled()).toBe(true);
  });
});

describe('a real socket to a host outside the machine is destroyed with ENOEGRESS', () => {
  it.each([
    ['a Microsoft sign-in host', { host: 'login.microsoftonline.com', port: 443 }],
    ['Graph', { host: 'graph.microsoft.com', port: 443 }],
    ['Exchange', { host: 'outlook.office365.com', port: 443 }],
    ['a public address', { host: '93.184.216.34', port: 80 }],
    ['the cloud metadata address', { host: '169.254.169.254', port: 80 }],
    ['a private network address', { host: '10.0.0.1', port: 80 }],
    ['an IPv6 address', { host: '2606:4700:4700::1111', port: 443 }],
    ['a name that starts like a loopback address', { host: '127.0.0.1.example.test', port: 80 }],
    ['a name that ends like localhost', { host: 'localhost.example.test', port: 80 }],
  ])('net.connect to %s', async (_name, options) => {
    expect(await connectAndReport(options)).toBe('ENOEGRESS');
  });

  it('net.connect(port, host) with positional arguments', async () => {
    expect(await connectAndReport(443, 'login.microsoftonline.com')).toBe('ENOEGRESS');
  });

  it('a socket created first and connected later', async () => {
    const socket = new net.Socket();
    const failed = once(socket, 'error');
    socket.connect({ host: 'graph.microsoft.com', port: 443 });
    const [error] = (await failed) as [NoEgressError];
    expect(error.code).toBe('ENOEGRESS');
    expect(socket.destroyed).toBe(true);
  });

  it('never reaches the name server: the host is judged before it is resolved', async () => {
    let lookups = 0;
    const socket = net.connect({
      host: 'never-resolved.example.test',
      port: 443,
      lookup: (_hostname, _options, callback) => {
        lookups += 1;
        callback(new Error('lookup must not run'), '', 4);
      },
    });
    const [error] = (await once(socket, 'error')) as [NoEgressError];
    expect(error.code).toBe('ENOEGRESS');
    expect(lookups).toBe(0);
  });
});

describe('the hole MSW leaves (V-B05)', () => {
  it('https.get to a Microsoft host is blocked', async () => {
    const request = https.get('https://graph.microsoft.com/v1.0/organization');
    const [error] = (await once(request, 'error')) as [NodeJS.ErrnoException];
    expect(error.code).toBe('ENOEGRESS');
  });

  it('https.request through a custom agent is blocked', async () => {
    const request = https.request(
      { host: 'login.microsoftonline.com', path: '/', agent: new https.Agent({ keepAlive: true }) },
      () => undefined,
    );
    request.end();
    const [error] = (await once(request, 'error')) as [NodeJS.ErrnoException];
    expect(error.code).toBe('ENOEGRESS');
  });

  it('plain http to a public host is blocked', async () => {
    const request = http.get('http://example.test/');
    const [error] = (await once(request, 'error')) as [NodeJS.ErrnoException];
    expect(error.code).toBe('ENOEGRESS');
  });

  it('global fetch to a Microsoft host is blocked when no handler answers', async () => {
    for (const url of [
      'https://login.microsoftonline.com/common/discovery/v2.0/keys',
      'https://graph.microsoft.com/v1.0/organization',
      'https://outlook.office365.com/adminapi/v2.0/x/OrganizationConfig',
    ]) {
      const failure = await fetch(url).then(
        () => undefined,
        (reason: unknown) => reason as Error & { cause?: { code?: string } },
      );
      expect(failure, url).toBeInstanceOf(TypeError);
      expect(failure?.cause?.code, url).toBe('ENOEGRESS');
    }
  });

  it('the guard is what stops it: a lenient guard would let this probe through (negative)', async () => {
    // A guard that classifies everything as allowed. `assertBlocks` is the check the table above
    // makes; it must fail for this one, or the table proves nothing.
    const lenient = (_host: string): boolean => true;
    expectGuardFails(
      (input: { allows: (host: string) => boolean }) => {
        for (const host of ['graph.microsoft.com', '93.184.216.34', '10.0.0.1']) {
          if (input.allows(host)) throw new Error(`guard allows ${host}`);
        }
      },
      { allows: lenient },
      { reason: 'guard allows graph.microsoft.com' },
    );
    // And the real classification passes the same check.
    expect(['graph.microsoft.com', '93.184.216.34', '10.0.0.1'].some(isLoopbackHost)).toBe(false);
    await Promise.resolve();
  });
});

describe('the loopback interface stays open', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    server.close();
    await once(server, 'close');
  });

  it('connects to 127.0.0.1', async () => {
    expect(await connectAndReport({ host: '127.0.0.1', port })).toBe('connected');
  });

  it('connects to "localhost"', async () => {
    expect(await connectAndReport({ host: 'localhost', port })).toBe('connected');
  });

  it('connects when no host is given (Node defaults to localhost)', async () => {
    expect(await connectAndReport({ port })).toBe('connected');
  });

  it('fetch to 127.0.0.1 works', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('http.get to 127.0.0.1 works', async () => {
    const request = http.get(`http://127.0.0.1:${String(port)}/`);
    const [response] = (await once(request, 'response')) as [http.IncomingMessage];
    expect(response.statusCode).toBe(200);
    response.resume();
  });

  it('a closed port on ::1 fails in the operating system, not in the guard', async () => {
    // IPv6 may be switched off in the sandbox: the code is then EADDRNOTAVAIL or ECONNREFUSED, never ENOEGRESS.
    expect(await connectAndReport({ host: '::1', port: 9 })).not.toBe('ENOEGRESS');
  });

  it('a closed port on 127.0.0.1 is ECONNREFUSED', async () => {
    expect(await connectAndReport({ host: '127.0.0.1', port: 1 })).toBe('ECONNREFUSED');
  });

  it('a Unix socket path is not a network connection', async () => {
    const code = await connectAndReport({ path: '/nonexistent/m365portal-no-egress.sock' });
    expect(code).toBe('ENOENT');
    expect(await connectAndReport('/nonexistent/m365portal-no-egress.sock')).toBe('ENOENT');
  });
});

describe('which hosts count as the loopback interface', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '127.255.255.255',
    '::1',
    '0:0:0:0:0:0:0:1',
    'localhost',
    'LOCALHOST',
    'Localhost',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('allows %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '128.0.0.1',
    '126.255.255.255',
    '10.0.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '8.8.8.8',
    '::',
    '::2',
    'fe80::1',
    '::ffff:10.0.0.1',
    '[::1]',
    'example.test',
    'graph.microsoft.com',
    '127.0.0.1.example.test',
    'localhost.example.test',
    'foo.localhost',
    'localhost.',
    'localhost\u0000.example.test',
    ' localhost',
    '127.0.0.1 ',
    '0x7f.0.0.1',
    '2130706433',
    '',
  ])('refuses %j', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('how the arguments of connect are read', () => {
  it.each([
    [[{ host: 'a.example.test', port: 443 }], { kind: 'tcp', host: 'a.example.test', port: 443 }],
    [[{ port: 80 }], { kind: 'tcp', host: 'localhost', port: 80 }],
    [[{ host: '127.0.0.1', port: '8080' }], { kind: 'tcp', host: '127.0.0.1', port: 8080 }],
    [[443, 'b.example.test'], { kind: 'tcp', host: 'b.example.test', port: 443 }],
    [['443', 'b.example.test'], { kind: 'tcp', host: 'b.example.test', port: 443 }],
    [[443], { kind: 'tcp', host: 'localhost', port: 443 }],
    [[443, () => undefined], { kind: 'tcp', host: 'localhost', port: 443 }],
    [['/tmp/x.sock'], { kind: 'ipc', path: '/tmp/x.sock' }],
    [[{ path: '/tmp/x.sock' }], { kind: 'ipc', path: '/tmp/x.sock' }],
    [[{ path: '/tmp/x.sock', host: 'a.example.test', port: 1 }], { kind: 'ipc', path: '/tmp/x.sock' }],
  ])('%j', (args, expected) => {
    expect(classifyConnectArguments(args)).toEqual(expected);
  });

  it('treats an argument list it cannot read as a network connection to an unknown host', () => {
    expect(classifyConnectArguments([])).toEqual({ kind: 'tcp', host: 'localhost', port: undefined });
    expect(classifyConnectArguments([null])).toEqual({ kind: 'tcp', host: 'localhost', port: undefined });
    expect(classifyConnectArguments([{ host: 7, port: 1 }])).toEqual({
      kind: 'tcp',
      host: '',
      port: 1,
    });
  });
});
