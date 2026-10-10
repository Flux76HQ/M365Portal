import { brand, type Brand } from '@m365portal/shared';

export type Port = Brand<number, 'Port'>;

export interface ListenOptions {
  readonly port: Port;
  readonly hostname: string;
}

const DEFAULT_PORT = 8080;
// Listening on every interface is the container default (FR-A-010): inside the container the
// Docker/Compose port mapping, not this address, decides what is reachable from outside. A local run
// pins HOST=127.0.0.1 instead (the `dev` and `start` scripts of this package do).
const DEFAULT_HOST = '0.0.0.0';

/**
 * Read where to listen from the environment. An invalid PORT is a configuration error: the message
 * names the variable but never echoes the value.
 */
export function readListenOptions(
  env: Readonly<Record<string, string | undefined>>,
): ListenOptions {
  const rawPort = env.PORT;
  let port = DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) {
      throw new Error('PORT must be an integer between 0 and 65535');
    }
    port = Number(rawPort);
  }
  const rawHost = env.HOST;
  return {
    port: brand(port),
    hostname: rawHost === undefined || rawHost === '' ? DEFAULT_HOST : rawHost,
  };
}
