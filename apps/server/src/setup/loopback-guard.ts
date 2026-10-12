// The loopback guard (T-B-126, FR-B-206, plan 9.2): accident protection, not a security boundary.
//
// When `PUBLIC_BASE_URL` is http (so `localhost`), the setup routes and the `/setup` pages exist only
// for a request whose `Host` is loopback (`localhost`, an address of `127.0.0.0/8`, or `[::1]`) and
// that carries none of `Forwarded`, `X-Forwarded-For`, `-Host`, `-Proto`, `-Port` and `X-Real-IP`. This
// stops an accidental exposure over plain http (a published port, a reverse proxy in front); a
// non-browser client can forge `Host`, which is why the setup token is the real control and the
// documentation says so. With an https base URL the guard does not apply.
import { isLoopbackHost, normalizeHost } from '../config/env.js';

export const PROXY_HEADERS: readonly string[] = Object.freeze([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
]);

export interface LoopbackInput {
  /** `config.publicIsHttps`. */
  readonly publicIsHttps: boolean;
  readonly headers: Headers;
  /** The host of the request URL, used only when there is no `Host` header. */
  readonly urlHost?: string;
}

/** True when the request may reach setup: https base URL, or loopback `Host` and no proxy header. */
export function loopbackGuardOpen(input: LoopbackInput): boolean {
  if (input.publicIsHttps) return true;
  if (PROXY_HEADERS.some((name) => input.headers.has(name))) return false;
  const raw = input.headers.get('host') ?? input.urlHost;
  if (raw === undefined || raw === '') return false;
  const host = normalizeHost(raw);
  return host !== undefined && isLoopbackHost(host);
}
