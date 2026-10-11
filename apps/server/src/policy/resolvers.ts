// The actor resolvers (plan 8.8, FR-A-032, FR-A-035, FR-A-036): which of the two actors a request
// acts as. Exactly two resolvers exist and nothing else can produce an actor:
//
//   anonymous  the configuration without preview mode. Every request. `Host` is not read.
//   preview    only with PREVIEW_MODE=true, and then only for the requests below.
//
// FR-A-036. The configuration guard of FR-A-035 checks the name in `PUBLIC_BASE_URL`, and the default
// name (`http://localhost:<PORT>`) is loopback even when the port is published to a network or a
// reverse proxy forwards to it, so the name proves nothing about the request that arrives. Unless
// PREVIEW_MODE_ALLOW_REMOTE=true, a request is the preview actor only if
//   - its `Host` names a loopback host (`localhost`, `127.0.0.0/8`, `[::1]`), read through the one
//     host normaliser the HSTS rule uses (`requestHost`), and
//   - it carries none of the headers that say "a proxy or CDN sent this": `Forwarded`, `X-Forwarded`,
//     `X-Forwarded-*`, `X-Real-IP`, `Via`, `CF-Connecting-IP`, `True-Client-IP`, `X-Client-IP`,
//     `X-Envoy-External-Address`, `Fastly-Client-IP`, `X-Original-Forwarded-For`: a request that
//     went through a proxy was not typed into a browser on this machine, whatever `Host` says.
// Every other request is anonymous. The rule can lower an actor and never raise one; no header,
// query parameter or cookie names an actor. It prevents accidental exposure and is not a security
// boundary: a client that is not a browser can write any `Host`. The boundary is publishing the port
// on loopback only (`-p 127.0.0.1:<port>:<port>`).
import type { AppConfig } from '../config/env.js';
import { isLoopbackHost } from '../config/env.js';
import { requestHost } from '../http/trust-proxy.js';
import { ANONYMOUS_ACTOR, PREVIEW_ACTOR, type Actor } from './actor.js';

/** What the resolvers read of the configuration. `AppConfig` fits. */
export type ActorConfig = Pick<AppConfig, 'previewMode' | 'previewModeAllowRemote'>;

/** The names of the request headers that say "a proxy sent this to us" (FR-A-036). */
const PROXY_HEADERS: ReadonlySet<string> = new Set([
  'forwarded',
  'x-forwarded',
  'x-real-ip',
  'via',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
  'x-envoy-external-address',
  'fastly-client-ip',
  'x-original-forwarded-for',
]);

function isForwardingHeader(name: string): boolean {
  return PROXY_HEADERS.has(name) || name.startsWith('x-forwarded-');
}

/** Does the request carry any header that says it was forwarded? Presence counts; the value does not. */
export function carriesForwardingHeader(headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (isForwardingHeader(name)) return true;
  }
  return false;
}

/** The anonymous resolver: nobody, with no permission. */
function resolveAnonymous(): Actor {
  return ANONYMOUS_ACTOR;
}

/** The preview resolver: reached only when PREVIEW_MODE=true. */
function resolvePreview(config: ActorConfig, request: Request): Actor {
  if (config.previewModeAllowRemote) return PREVIEW_ACTOR;
  const host = requestHost(request);
  if (host === undefined || !isLoopbackHost(host)) return resolveAnonymous();
  return carriesForwardingHeader(request.headers) ? resolveAnonymous() : PREVIEW_ACTOR;
}

/** The actor of a request. Pure: the same configuration and request give the same actor. */
export function resolveActor(config: ActorConfig, request: Request): Actor {
  return config.previewMode ? resolvePreview(config, request) : resolveAnonymous();
}

/** `resolveActor` with the configuration fixed, for the pipeline to call once per request. */
export function createActorResolver(config: ActorConfig): (request: Request) => Actor {
  const { previewMode, previewModeAllowRemote } = config;
  return (request) => resolveActor({ previewMode, previewModeAllowRemote }, request);
}

// ---------------------------------------------------------------------------------------------
// The warning at start (FR-A-032)
// ---------------------------------------------------------------------------------------------

/** The wording of the start warning, for each mode. English: it is read by an operator, not a user. */
export const PREVIEW_WARNING = {
  'loopback-only':
    'WARNING: PREVIEW_MODE is on. Requests whose Host is loopback (localhost, 127.0.0.0/8, ::1) and ' +
    'that carry no Forwarded, X-Forwarded-*, X-Real-IP, Via, CF-Connecting-IP, True-Client-IP, ' +
    'X-Client-IP, X-Envoy-External-Address, Fastly-Client-IP or X-Original-Forwarded-For header ' +
    'are treated as an administrator ' +
    'with all permissions, without any sign-in. Every other request, including one with a ' +
    'non-loopback Host or a forwarding header, is treated as anonymous. This stops accidental ' +
    'exposure and is not a security boundary (the Host header and these headers are written by the ' +
    'client; any client that can reach the port can omit them): publish the port on loopback only ' +
    '(-p 127.0.0.1:<port>:<port>). Preview mode goes away in Phase B.',
  'any-host':
    'WARNING: PREVIEW_MODE is on and PREVIEW_MODE_ALLOW_REMOTE is true. Every request that reaches ' +
    'this server, whatever its Host and headers, is treated as an administrator with all ' +
    'permissions, without any sign-in. Anyone who can reach the port can change the settings. Do ' +
    'not expose this instance. Preview mode goes away in Phase B.',
} as const;

export interface PreviewAnnouncement {
  readonly log: { warn(fields: Readonly<Record<string, unknown>>, message: string): void };
  readonly stderr: { write(text: string): unknown };
}

/**
 * Plan 7.1 step 2: when preview mode is on, say so on the log and on stderr (the log may go
 * nowhere an operator looks). Writes nothing when it is off.
 */
export function announcePreviewMode(config: ActorConfig, sinks: PreviewAnnouncement): void {
  if (!config.previewMode) return;
  const mode = config.previewModeAllowRemote ? 'any-host' : 'loopback-only';
  const warning = PREVIEW_WARNING[mode];
  sinks.log.warn({ event: 'preview_mode', mode }, warning);
  try {
    sinks.stderr.write(`${warning}\n`);
  } catch {
    // A closed stderr must not stop the server from starting; the log line is written.
  }
}
