import { brand, type Brand } from '@m365portal/shared';
import { DEFAULT_PORT } from '@m365portal/shared/limits';

export type Port = Brand<number, 'Port'>;

export interface ListenOptions {
  readonly port: Port;
  readonly hostname: string;
}

// FR-A-016: the container runs unprivileged with every capability dropped, so a port below 1024
// can never be bound. The default port is defined once, in @m365portal/shared/limits.
const MIN_PORT = 1024;
const MAX_PORT = 65535;
// Four or five digits, no sign, no leading zero, no whitespace, no exponent or hex notation.
const PORT_PATTERN = /^[1-9]\d{3,4}$/;
// Listening on every interface is the container default (FR-A-010): inside the container the
// Docker/Compose port mapping, not this address, decides what is reachable from outside. A local run
// pins HOST=127.0.0.1 instead (the `dev` and `start` scripts of this package do).
const DEFAULT_HOST = '0.0.0.0';

/**
 * Read where to listen from the environment. An invalid PORT is a configuration error (FR-A-016):
 * 0, an empty value, non-numeric input and anything outside 1024 to 65535 are all refused, and the
 * message names the variable but never echoes the value. An unset PORT means the default.
 */
export function readListenOptions(
  env: Readonly<Record<string, string | undefined>>,
): ListenOptions {
  const rawPort = env.PORT;
  let port: number = DEFAULT_PORT;
  if (rawPort !== undefined) {
    port = Number(rawPort);
    if (!PORT_PATTERN.test(rawPort) || port < MIN_PORT || port > MAX_PORT) {
      throw new Error(
        `PORT must be an integer between ${String(MIN_PORT)} and ${String(MAX_PORT)}`,
      );
    }
  }
  const rawHost = env.HOST;
  return {
    port: brand(port),
    hostname: rawHost === undefined || rawHost === '' ? DEFAULT_HOST : rawHost,
  };
}
