// The configuration schema (FR-A-010, FR-A-016, FR-A-035): the environment variables of the server,
// parsed and validated by one Zod schema, and nothing else reads `process.env`.
//
// Rules this file keeps:
//   - An unset variable takes its default; a variable that is set must be valid, and an empty value
//     is invalid for every variable (an empty PORT is not "the default": FR-A-016).
//   - Every message names the variable and is a fixed text. No message carries the value: a
//     configuration error is logged, and a value may be a secret or a mistyped credential.
//   - Phase A has no secret variable, but the rule is the same for Phase B, which adds some.
//   - `HOST_PORT` is a Compose-only variable (the port published on the Docker host) and is not
//     in this list: the application never reads it (FR-A-016, A-63).
import { isIP, isIPv4, isIPv6 } from 'node:net';
import { isAbsolute } from 'node:path';
import { DEFAULT_PORT, LIMITS } from '@m365portal/shared/limits';
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** One entry of a `TRUST_PROXY` list: an address or a range, already checked for syntax. */
export interface TrustedNetwork {
  readonly family: 4 | 6;
  /** The address as written (an IPv6 address in lower case). A bare address has the full prefix. */
  readonly address: string;
  /** 0 to 32 for IPv4 and 0 to 128 for IPv6. */
  readonly prefix: number;
}

/** How `X-Forwarded-For` and `X-Forwarded-Proto` are read (FR-A-046, plan 8.4). */
export type TrustProxySetting =
  | { readonly mode: 'none' }
  | { readonly mode: 'hops'; readonly hops: number }
  | { readonly mode: 'list'; readonly networks: readonly TrustedNetwork[] };

/** The effective configuration. Frozen: one consumer cannot change what another reads. */
export interface AppConfig {
  /** The port the process listens on, inside the container (FR-A-016). */
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  /** The serialised origin of `PUBLIC_BASE_URL`: scheme, host and a non-default port. */
  readonly publicOrigin: string;
  /**
   * The host of `PUBLIC_BASE_URL` in the form `normalizeHost` gives (lower case, no port, no
   * trailing dot, IPv6 in brackets): the one host the operator declared and therefore owns. It is
   * compared with the `Host` header by the HSTS rule (FR-A-043) and nothing else.
   */
  readonly publicHost: string;
  readonly publicIsHttps: boolean;
  readonly trustProxy: TrustProxySetting;
  readonly previewMode: boolean;
  readonly previewModeAllowRemote: boolean;
  readonly showcase: boolean;
  readonly logLevel: LogLevel;
  readonly hsts: {
    readonly maxAgeSeconds: number;
    readonly includeSubDomains: boolean;
    readonly preload: boolean;
  };
}

// ---------------------------------------------------------------------------------------------
// Hosts: the one normaliser (used by the configuration, the HSTS rule and the preview rule)
// ---------------------------------------------------------------------------------------------

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const PORT_SUFFIX = /^:\d{1,5}$/;

function isDnsName(name: string): boolean {
  if (name === '' || name.length > 253) return false;
  return name.split('.').every((label) => label.length <= 63 && DNS_LABEL.test(label));
}

/**
 * The host of a `Host` header or of a URL, in one form: lower case, without the port, without one
 * trailing dot, an IPv6 literal kept in brackets (`[::1]:8080` gives `[::1]`). Returns `undefined`
 * for anything that is not a plausible host: empty, whitespace, a path, userinfo, a second colon
 * outside brackets, an empty label, a character outside printable ASCII (an internationalised name
 * arrives as punycode).
 *
 * This is the only host normaliser: the HSTS rule compares `normalizeHost(Host)` with
 * `config.publicHost`, and the preview rule asks `isLoopbackHost` about it. Two normalisers would
 * give two answers for `localhost.` or `LOCALHOST:80`, which is how a flag ends up on a host it was
 * never meant for.
 */
export function normalizeHost(value: string): string | undefined {
  if (!PRINTABLE_ASCII.test(value)) return undefined;
  const lower = value.toLowerCase();

  if (lower.startsWith('[')) {
    const close = lower.indexOf(']');
    if (close < 0) return undefined;
    const literal = lower.slice(1, close);
    const rest = lower.slice(close + 1);
    if (rest !== '' && !PORT_SUFFIX.test(rest)) return undefined;
    if (!isIPv6(literal) || literal.includes('%')) return undefined;
    return `[${literal}]`;
  }

  const colon = lower.indexOf(':');
  let name = lower;
  if (colon >= 0) {
    if (!PORT_SUFFIX.test(lower.slice(colon))) return undefined;
    name = lower.slice(0, colon);
  }
  if (name.endsWith('.')) name = name.slice(0, -1);
  return isDnsName(name) ? name : undefined;
}

/**
 * Is this host the loopback interface: `localhost`, an address of `127.0.0.0/8` or `::1`? The
 * argument is a host in the form of `normalizeHost` (an IPv6 literal with or without brackets is
 * accepted). Nothing else counts: `0.0.0.0`, `localhost.attacker.example`, `127.0.0.1.nip.io` and
 * `127.1` are not loopback, because the answer decides whether an unauthenticated preview actor is
 * handed out (FR-A-035, FR-A-036).
 */
export function isLoopbackHost(host: string): boolean {
  if (!PRINTABLE_ASCII.test(host)) return false;
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '[::1]' || lower === '::1') return true;
  return isIPv4(lower) && lower.startsWith('127.');
}

// ---------------------------------------------------------------------------------------------
// Parsers: a raw text in, a value or `undefined` out
// ---------------------------------------------------------------------------------------------

const MIN_PORT = 1024;
const MAX_PORT = 65_535;
const MAX_HSTS_MAX_AGE = 63_072_000;
const MAX_TRUSTED_HOPS = 8;
const MAX_TRUSTED_ENTRIES = 32;

// Four or five digits, no sign, no leading zero, no whitespace, no exponent or hex notation.
const PORT_PATTERN = /^[1-9]\d{3,4}$/;
const MAX_AGE_PATTERN = /^(?:0|[1-9]\d{0,8})$/;
const HOP_PATTERN = new RegExp(`^[1-${String(MAX_TRUSTED_HOPS)}]$`);
const CIDR_PREFIX = /^(?:0|[1-9]\d{0,2})$/;
// Scheme, then host and optional port. No userinfo, path, query or fragment: those would have to be
// thrown away silently, and a base URL with a path is a mistake the operator should hear about.
const BASE_URL_SHAPE = /^https?:\/\/[^\s\\/?#@]+\/?$/i;

function parsePort(raw: string): number | undefined {
  if (!PORT_PATTERN.test(raw)) return undefined;
  const port = Number(raw);
  return port >= MIN_PORT && port <= MAX_PORT ? port : undefined;
}

function parseHost(raw: string): string | undefined {
  if (!PRINTABLE_ASCII.test(raw)) return undefined;
  return isIP(raw) !== 0 || isDnsName(raw.toLowerCase()) ? raw : undefined;
}

function parseDataDir(raw: string): string | undefined {
  return raw !== '' && !raw.includes('\0') && isAbsolute(raw) ? raw : undefined;
}

interface PublicBase {
  readonly origin: string;
  readonly host: string;
  readonly https: boolean;
}

function parsePublicBase(raw: string): PublicBase | undefined {
  if (!BASE_URL_SHAPE.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = normalizeHost(url.host);
  if (host === undefined) return undefined;
  return { origin: url.origin, host, https: url.protocol === 'https:' };
}

function parseNetwork(entry: string): TrustedNetwork | undefined {
  const slash = entry.indexOf('/');
  const address = slash < 0 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  if (family === 0 || address.includes('%')) return undefined;
  const maxPrefix = family === 4 ? 32 : 128;
  let prefix = maxPrefix;
  if (slash >= 0) {
    const text = entry.slice(slash + 1);
    if (!CIDR_PREFIX.test(text)) return undefined;
    prefix = Number(text);
    if (prefix > maxPrefix) return undefined;
  }
  return {
    family: family === 4 ? 4 : 6,
    address: family === 4 ? address : address.toLowerCase(),
    prefix,
  };
}

function parseTrustProxy(raw: string): TrustProxySetting | undefined {
  if (raw === 'none') return { mode: 'none' };
  if (HOP_PATTERN.test(raw)) return { mode: 'hops', hops: Number(raw) };
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_TRUSTED_ENTRIES) return undefined;
  const networks: TrustedNetwork[] = [];
  for (const entry of entries) {
    const network = parseNetwork(entry);
    if (network === undefined) return undefined;
    networks.push(network);
  }
  return { mode: 'list', networks };
}

function parseBoolean(raw: string): boolean | undefined {
  if (raw === 'true') return true;
  return raw === 'false' ? false : undefined;
}

function parseLogLevel(raw: string): LogLevel | undefined {
  return LOG_LEVELS.find((level) => level === raw);
}

function parseMaxAge(raw: string): number | undefined {
  if (!MAX_AGE_PATTERN.test(raw)) return undefined;
  const seconds = Number(raw);
  return seconds <= MAX_HSTS_MAX_AGE ? seconds : undefined;
}

// ---------------------------------------------------------------------------------------------
// The variable list
// ---------------------------------------------------------------------------------------------

export const ENV_VARIABLE_NAMES = [
  'PORT',
  'HOST',
  'DATA_DIR',
  'PUBLIC_BASE_URL',
  'TRUST_PROXY',
  'PREVIEW_MODE',
  'PREVIEW_MODE_ALLOW_REMOTE',
  'SHOWCASE',
  'LOG_LEVEL',
  'HSTS_MAX_AGE',
  'HSTS_INCLUDE_SUBDOMAINS',
  'HSTS_PRELOAD',
] as const;
export type EnvName = (typeof ENV_VARIABLE_NAMES)[number];

export interface EnvVariable {
  readonly name: EnvName;
  /** The default as the spec writes it (FR-A-010); `PUBLIC_BASE_URL` depends on `PORT`. */
  readonly defaultText: string;
}

/**
 * Every variable with its default, in the order of FR-A-010. `server/deploy-files.test.ts` compares
 * `.env.example` and the Compose file with this list (TA-06), and `config.test.ts` compares it with
 * the FR-A-010 row of the spec.
 */
export const ENV_VARIABLES: readonly EnvVariable[] = [
  { name: 'PORT', defaultText: String(DEFAULT_PORT) },
  { name: 'HOST', defaultText: '0.0.0.0' },
  { name: 'DATA_DIR', defaultText: '/data' },
  { name: 'PUBLIC_BASE_URL', defaultText: 'http://localhost:<PORT>' },
  { name: 'TRUST_PROXY', defaultText: 'none' },
  { name: 'PREVIEW_MODE', defaultText: 'false' },
  { name: 'PREVIEW_MODE_ALLOW_REMOTE', defaultText: 'false' },
  { name: 'SHOWCASE', defaultText: 'false' },
  { name: 'LOG_LEVEL', defaultText: 'info' },
  { name: 'HSTS_MAX_AGE', defaultText: String(LIMITS.hstsMaxAgeSeconds) },
  { name: 'HSTS_INCLUDE_SUBDOMAINS', defaultText: 'false' },
  { name: 'HSTS_PRELOAD', defaultText: 'false' },
];

const BOOLEAN_TEXT = (name: string): string => `${name} must be true or false`;

/** The messages. Fixed texts: none of them can carry a value (see the header of this file). */
export const ENV_MESSAGES: Readonly<Record<EnvName, string>> = {
  PORT: `PORT must be an integer between ${String(MIN_PORT)} and ${String(MAX_PORT)}`,
  HOST: 'HOST must be a host name or an IP address',
  DATA_DIR: 'DATA_DIR must be an absolute path',
  PUBLIC_BASE_URL:
    'PUBLIC_BASE_URL must be an http or https origin without path, query, fragment or credentials',
  TRUST_PROXY: `TRUST_PROXY must be none, a number of proxies from 1 to ${String(MAX_TRUSTED_HOPS)}, or a comma-separated list of at most ${String(MAX_TRUSTED_ENTRIES)} IP addresses or CIDR ranges`,
  PREVIEW_MODE: BOOLEAN_TEXT('PREVIEW_MODE'),
  PREVIEW_MODE_ALLOW_REMOTE: BOOLEAN_TEXT('PREVIEW_MODE_ALLOW_REMOTE'),
  SHOWCASE: BOOLEAN_TEXT('SHOWCASE'),
  LOG_LEVEL: `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`,
  HSTS_MAX_AGE: `HSTS_MAX_AGE must be an integer between 0 and ${String(MAX_HSTS_MAX_AGE)}`,
  HSTS_INCLUDE_SUBDOMAINS: BOOLEAN_TEXT('HSTS_INCLUDE_SUBDOMAINS'),
  HSTS_PRELOAD: BOOLEAN_TEXT('HSTS_PRELOAD'),
};

/** Cross-variable messages, also fixed texts. */
export const CROSS_MESSAGES = {
  previewRemote:
    'PREVIEW_MODE=true requires a loopback PUBLIC_BASE_URL (localhost, 127.0.0.0/8 or ::1) unless PREVIEW_MODE_ALLOW_REMOTE=true',
  hstsPreload: `HSTS_PRELOAD=true requires HSTS_INCLUDE_SUBDOMAINS=true and HSTS_MAX_AGE of at least ${String(LIMITS.hstsMaxAgeSeconds)}`,
} as const;

// ---------------------------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------------------------

/**
 * One variable: unset takes the default (when there is one), a set value must parse. The message
 * of a refusal is the fixed text of the variable; the value goes nowhere.
 */
function variable<Value>(
  name: EnvName,
  fallback: string | undefined,
  parse: (raw: string) => Value | undefined,
) {
  return z
    .string()
    .optional()
    .transform((raw, context): Value | undefined => {
      const text = raw ?? fallback;
      if (text === undefined) return undefined;
      const value = parse(text);
      if (value === undefined) {
        context.issues.push({ code: 'custom', message: ENV_MESSAGES[name], input: undefined });
        return z.NEVER;
      }
      return value;
    });
}

const fallbackOf = (name: EnvName): string => {
  const found = ENV_VARIABLES.find((entry) => entry.name === name);
  return found?.defaultText ?? '';
};

/**
 * The environment as the application reads it. The input is an object with the twelve keys of
 * `ENV_VARIABLE_NAMES` (values may be `undefined`); the output is the frozen `AppConfig`.
 */
export const EnvSchema = z
  .object({
    PORT: variable('PORT', fallbackOf('PORT'), parsePort),
    HOST: variable('HOST', fallbackOf('HOST'), parseHost),
    DATA_DIR: variable('DATA_DIR', fallbackOf('DATA_DIR'), parseDataDir),
    // The default depends on PORT, so it is filled in below.
    PUBLIC_BASE_URL: variable('PUBLIC_BASE_URL', undefined, parsePublicBase),
    TRUST_PROXY: variable('TRUST_PROXY', fallbackOf('TRUST_PROXY'), parseTrustProxy),
    PREVIEW_MODE: variable('PREVIEW_MODE', fallbackOf('PREVIEW_MODE'), parseBoolean),
    PREVIEW_MODE_ALLOW_REMOTE: variable(
      'PREVIEW_MODE_ALLOW_REMOTE',
      fallbackOf('PREVIEW_MODE_ALLOW_REMOTE'),
      parseBoolean,
    ),
    SHOWCASE: variable('SHOWCASE', fallbackOf('SHOWCASE'), parseBoolean),
    LOG_LEVEL: variable('LOG_LEVEL', fallbackOf('LOG_LEVEL'), parseLogLevel),
    HSTS_MAX_AGE: variable('HSTS_MAX_AGE', fallbackOf('HSTS_MAX_AGE'), parseMaxAge),
    HSTS_INCLUDE_SUBDOMAINS: variable(
      'HSTS_INCLUDE_SUBDOMAINS',
      fallbackOf('HSTS_INCLUDE_SUBDOMAINS'),
      parseBoolean,
    ),
    HSTS_PRELOAD: variable('HSTS_PRELOAD', fallbackOf('HSTS_PRELOAD'), parseBoolean),
  })
  .transform((values, context): AppConfig => {
    // Every default above is a valid value, so a field is only undefined when it is the base URL.
    const port = values.PORT ?? DEFAULT_PORT;
    // The default base URL is the browser's view of the default setup (A-63): this machine.
    const base: PublicBase = values.PUBLIC_BASE_URL ?? {
      origin: `http://localhost:${String(port)}`,
      host: 'localhost',
      https: false,
    };
    const previewMode = values.PREVIEW_MODE ?? false;
    const previewModeAllowRemote = values.PREVIEW_MODE_ALLOW_REMOTE ?? false;
    const hsts = {
      maxAgeSeconds: values.HSTS_MAX_AGE ?? LIMITS.hstsMaxAgeSeconds,
      includeSubDomains: values.HSTS_INCLUDE_SUBDOMAINS ?? false,
      preload: values.HSTS_PRELOAD ?? false,
    };

    // FR-A-035, E-17: preview mode is unauthenticated administration, so it may only be configured
    // for a name that points at this machine, unless the operator says otherwise in so many words.
    if (previewMode && !previewModeAllowRemote && !isLoopbackHost(base.host)) {
      context.issues.push({
        code: 'custom',
        message: CROSS_MESSAGES.previewRemote,
        input: undefined,
        path: ['PREVIEW_MODE'],
      });
    }
    // Baseline section 13: a preload promise needs includeSubDomains and at least a year.
    if (
      hsts.preload &&
      (!hsts.includeSubDomains || hsts.maxAgeSeconds < LIMITS.hstsMaxAgeSeconds)
    ) {
      context.issues.push({
        code: 'custom',
        message: CROSS_MESSAGES.hstsPreload,
        input: undefined,
        path: ['HSTS_PRELOAD'],
      });
    }

    return deepFreeze({
      port,
      host: values.HOST ?? fallbackOf('HOST'),
      dataDir: values.DATA_DIR ?? fallbackOf('DATA_DIR'),
      publicOrigin: base.origin,
      publicHost: base.host,
      publicIsHttps: base.https,
      trustProxy: values.TRUST_PROXY ?? { mode: 'none' as const },
      previewMode,
      previewModeAllowRemote,
      showcase: values.SHOWCASE ?? false,
      logLevel: values.LOG_LEVEL ?? 'info',
      hsts,
    });
  });

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
