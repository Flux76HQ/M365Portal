// The ports of the e2e topology, in one place (FR-A-016, FR-B-708, CB17). `playwright.config.ts` sets
// the default of `E2E_PORT` before anything else runs (the one file where a literal port may appear);
// every other file asks this module, so no literal port or `+ 1` lives anywhere else.
//
//   instance A  E2E_PORT      configured by global-setup through the real wizard (SHOWCASE=true)
//   instance B  E2E_PORT + 1  empty data directory: the wizard and the setup specs run here
//   fake tenant E2E_PORT + 2  the fake Entra / Graph / Exchange over local HTTP (two tenants, A and B)
//   fake (TLS)  E2E_PORT + 3  the same fake over HTTPS, which the browser reaches under the three
//                             Microsoft host names (host-resolver rules, `microsoft-hosts.ts`)
//   spare       E2E_PORT + 4  a short-lived third instance for the specs that need one beside A
export type InstanceName = 'a' | 'b';
export const INSTANCE_NAMES: readonly InstanceName[] = ['a', 'b'];

const OFFSETS = { a: 0, b: 1, fake: 2, fakeTls: 3, spare: 4 } as const;
export type PortName = keyof typeof OFFSETS;

/** E2E_PORT, 1024 to 65531. `playwright.config.ts` sets the default; anything else throws. */
export function e2ePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.E2E_PORT ?? '';
  const port = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || port < 1024 || port > 65531) {
    throw new Error(
      'E2E_PORT must be an integer between 1024 and 65531 (E2E_PORT + 1 to + 4 are used too)',
    );
  }
  return port;
}

export function portOf(name: PortName, env: NodeJS.ProcessEnv = process.env): number {
  return e2ePort(env) + OFFSETS[name];
}

/**
 * The origin the browser uses for an instance. `localhost` and not 127.0.0.1: PUBLIC_BASE_URL must
 * equal it (writes are only accepted from that origin, A-31, and an http base URL must be localhost).
 */
export function originOf(
  name: InstanceName | 'spare',
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `http://localhost:${String(portOf(name, env))}`;
}

/** Where a process of the test run reaches the fake tenant (loopback, so the no-egress guard allows it). */
export function fakeOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${String(portOf('fake', env))}`;
}
