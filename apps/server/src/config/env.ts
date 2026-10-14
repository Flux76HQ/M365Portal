// The configuration schema (FR-A-010, FR-A-016, FR-A-035): the environment variables of the server,
// parsed and validated by one Zod schema, and nothing else reads `process.env`.
//
// Rules this file keeps:
//   - An unset variable takes its default; a variable that is set must be valid, and an empty value
//     is invalid for every variable (an empty PORT is not "the default": FR-A-016).
//   - Every message names the variable and is a fixed text. No message carries the value: a
//     configuration error is logged, and a value may be a secret or a mistyped credential.
//   - Phase B adds secret variables (`APP_KEY`, `SETUP_TOKEN`, ...). They are carried as `SecretText`
//     and the report never repeats them, which the rule above already says for every variable.
//   - `PREVIEW_MODE` and `PREVIEW_MODE_ALLOW_REMOTE` are gone (FR-B-102): they are not read, and
//     `removedVariablesIn` only names them so the start can warn once.
//   - `HOST_PORT` is a Compose-only variable (the port published on the Docker host) and is not
//     in this list: the application never reads it (FR-A-016, A-63).
import { isIP, isIPv4, isIPv6 } from 'node:net';
import { isAbsolute } from 'node:path';
import { parsePublicBaseUrl } from '@m365portal/shared/auth/redirect-uri';
import { parseScryptHash } from '@m365portal/shared/auth/scrypt-hash';
import { DEFAULT_PORT, LIMITS } from '@m365portal/shared/limits';
import { z } from 'zod';
import { parseAppKey } from '../secrets/app-key.js';
import {
  deriveDurations,
  deriveRedirects,
  type DerivedDurations,
  type DerivedRedirects,
} from './derived.js';
import { SecretText } from './secret-text.js';

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
  readonly showcase: boolean;
  readonly logLevel: LogLevel;
  readonly hsts: {
    readonly maxAgeSeconds: number;
    readonly includeSubDomains: boolean;
    readonly preload: boolean;
  };
  /** The redirect URIs, derived from `PUBLIC_BASE_URL` by the one shared module (FR-B-103). */
  readonly redirectUris: DerivedRedirects['redirectUris'];
  readonly authorizeRedirectUri: string;
  readonly postLogoutRedirectUri: string;
  /** `APP_KEY` or the file that holds it (FR-B-104). The file is read at start, not here. */
  readonly appKey: KeySource;
  /** `APP_KEY_PREVIOUS` or its file; set only while the key is rotated (FR-B-109). */
  readonly appKeyPrevious: KeySource;
  /** `SETUP_TOKEN`; unset means the token file is used (FR-B-203). */
  readonly setupToken: SecretText | undefined;
  /** The public client of the device-code bootstrap, lower case (FR-B-214). */
  readonly bootstrapClientId: string;
  /** The durations, in milliseconds (`derived.ts`). */
  readonly setup: DerivedDurations['setup'];
  readonly session: DerivedDurations['session'];
  readonly rbac: DerivedDurations['rbac'];
  /** The sign-in policy (FR-B-405). */
  readonly auth: {
    readonly requireMfa: boolean;
    readonly mfaAmrValues: readonly string[];
  };
  /** The optional break-glass account (FR-B-521): both variables, or none. */
  readonly breakGlass: { readonly username: string; readonly passwordHash: SecretText } | undefined;
}

/** Where an `APP_KEY` comes from: nothing, the variable, or a file read at start. */
export type KeySource =
  | { readonly source: 'none' }
  | { readonly source: 'env'; readonly value: SecretText }
  | { readonly source: 'file'; readonly path: string };

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
 * trailing dot, an IPv6 literal kept in brackets (`[::1]:9090` gives `[::1]`). Returns `undefined`
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
  /** The text as given, for the shared redirect-URI module. */
  readonly text: string;
}

function parsePublicBase(raw: string): PublicBase | undefined {
  if (!BASE_URL_SHAPE.test(raw)) return undefined;
  // Phase B: only a base URL the application registration can hold (FR-B-103): https, or http with
  // the host exactly `localhost`. The shared module is the one place that decides.
  if (!parsePublicBaseUrl(raw).ok) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = normalizeHost(url.host);
  if (host === undefined) return undefined;
  return { origin: url.origin, host, https: url.protocol === 'https:', text: raw };
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

// Phase B ----------------------------------------------------------------------------------------

const WHOLE_NUMBER = /^[1-9]\d{0,5}$/;
const SETUP_TOKEN_SHAPE = /^[A-Za-z0-9._~-]{24,128}$/;
const MIN_SETUP_TOKEN_DISTINCT = 12;
const GUID_ANY_CASE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const AMR_VALUE = /^[a-z0-9]{2,32}$/;
const SINGLE_FACTOR_AMR = ['pwd', 'wia', 'x509'] as const;
const MAX_AMR_VALUES = 8;
const BREAK_GLASS_USERNAME_SHAPE = /^[A-Za-z0-9._-]{3,64}$/;

/** A whole number in `[min, max]`, written without sign, leading zero, whitespace or exponent. */
function parseWholeNumber(min: number, max: number): (raw: string) => number | undefined {
  return (raw) => {
    if (!WHOLE_NUMBER.test(raw)) return undefined;
    const value = Number(raw);
    return value >= min && value <= max ? value : undefined;
  };
}

function parseAppKeyVariable(raw: string): SecretText | undefined {
  return parseAppKey(raw).ok ? new SecretText(raw) : undefined;
}

/** An absolute path of a key file. Whether it can be read is found out at start (FR-B-108). */
function parseKeyFilePath(raw: string): string | undefined {
  return parseDataDir(raw);
}

function parseSetupToken(raw: string): SecretText | undefined {
  if (!SETUP_TOKEN_SHAPE.test(raw)) return undefined;
  return new Set(raw).size >= MIN_SETUP_TOKEN_DISTINCT ? new SecretText(raw) : undefined;
}

function parseGuidLowerCased(raw: string): string | undefined {
  return GUID_ANY_CASE.test(raw) ? raw.toLowerCase() : undefined;
}

function parseAmrValues(raw: string): readonly string[] | undefined {
  const values = raw.split(',');
  if (values.length > MAX_AMR_VALUES || new Set(values).size !== values.length) return undefined;
  const allowed = values.every(
    (value) => AMR_VALUE.test(value) && !(SINGLE_FACTOR_AMR as readonly string[]).includes(value),
  );
  return allowed ? values : undefined;
}

function parseBreakGlassUsername(raw: string): string | undefined {
  return BREAK_GLASS_USERNAME_SHAPE.test(raw) ? raw : undefined;
}

function parseBreakGlassHash(raw: string): SecretText | undefined {
  return parseScryptHash(raw).ok ? new SecretText(raw) : undefined;
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
  'SHOWCASE',
  'LOG_LEVEL',
  'HSTS_MAX_AGE',
  'HSTS_INCLUDE_SUBDOMAINS',
  'HSTS_PRELOAD',
  // Phase B (spec 6.9.1), in the order of the table.
  'APP_KEY',
  'APP_KEY_FILE',
  'APP_KEY_PREVIOUS',
  'APP_KEY_PREVIOUS_FILE',
  'SETUP_TOKEN',
  'BOOTSTRAP_CLIENT_ID',
  'SETUP_PROPAGATION_TIMEOUT_SECONDS',
  'SESSION_IDLE_TIMEOUT_MINUTES',
  'SESSION_ABSOLUTE_TIMEOUT_HOURS',
  'GROUP_CACHE_TTL_SECONDS',
  'AUTH_REQUIRE_MFA',
  'AUTH_MFA_AMR_VALUES',
  'BREAK_GLASS_USERNAME',
  'BREAK_GLASS_PASSWORD_HASH',
] as const;
export type EnvName = (typeof ENV_VARIABLE_NAMES)[number];

/**
 * The variables Phase B removed (FR-B-102). They are not read; a start that finds one in the
 * environment says so once (`removedVariablesIn`) and carries on exactly as without it.
 */
export const REMOVED_VARIABLE_NAMES = ['PREVIEW_MODE', 'PREVIEW_MODE_ALLOW_REMOTE'] as const;

/** The names of the removed variables that `env` still sets, in the order above. */
export function removedVariablesIn(env: Readonly<Record<string, string | undefined>>): string[] {
  return REMOVED_VARIABLE_NAMES.filter((name) => Object.hasOwn(env, name));
}

export interface EnvVariable {
  readonly name: EnvName;
  /**
   * The default as the spec writes it (FR-A-010, 6.9.1); `PUBLIC_BASE_URL` depends on `PORT`. A
   * variable with no default is `unset`: the application behaves as documented without it.
   */
  readonly defaultText: string;
  /** True for a variable whose value is a secret (never logged, never echoed). */
  readonly secret?: boolean;
}

/** The default of a variable that has none (spec 6.9.1: `unset`). */
const UNSET = 'unset';

/** The public client id of the device-code bootstrap (FR-B-214, spec 6.9.1). */
const DEFAULT_BOOTSTRAP_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';

/**
 * Every variable with its default, in the order of FR-A-010 (Phase A) and the table of 6.9.1. `server/deploy-files.test.ts` compares
 * `.env.example` and the Compose file with this list (TA-06), and `config.test.ts` compares it with
 * the FR-A-010 row of the spec.
 */
export const ENV_VARIABLES: readonly EnvVariable[] = [
  { name: 'PORT', defaultText: String(DEFAULT_PORT) },
  { name: 'HOST', defaultText: '0.0.0.0' },
  { name: 'DATA_DIR', defaultText: '/data' },
  { name: 'PUBLIC_BASE_URL', defaultText: 'http://localhost:<PORT>' },
  { name: 'TRUST_PROXY', defaultText: 'none' },
  { name: 'SHOWCASE', defaultText: 'false' },
  { name: 'LOG_LEVEL', defaultText: 'info' },
  { name: 'HSTS_MAX_AGE', defaultText: String(LIMITS.hstsMaxAgeSeconds) },
  { name: 'HSTS_INCLUDE_SUBDOMAINS', defaultText: 'false' },
  { name: 'HSTS_PRELOAD', defaultText: 'false' },
  // Phase B, spec 6.9.1.
  { name: 'APP_KEY', defaultText: UNSET, secret: true },
  { name: 'APP_KEY_FILE', defaultText: UNSET },
  { name: 'APP_KEY_PREVIOUS', defaultText: UNSET, secret: true },
  { name: 'APP_KEY_PREVIOUS_FILE', defaultText: UNSET },
  { name: 'SETUP_TOKEN', defaultText: UNSET, secret: true },
  { name: 'BOOTSTRAP_CLIENT_ID', defaultText: DEFAULT_BOOTSTRAP_CLIENT_ID },
  {
    name: 'SETUP_PROPAGATION_TIMEOUT_SECONDS',
    defaultText: String(LIMITS.setup.propagationTimeoutSeconds.default),
  },
  {
    name: 'SESSION_IDLE_TIMEOUT_MINUTES',
    defaultText: String(LIMITS.session.idleTimeoutMinutes.default),
  },
  {
    name: 'SESSION_ABSOLUTE_TIMEOUT_HOURS',
    defaultText: String(LIMITS.session.absoluteTimeoutHours.default),
  },
  {
    name: 'GROUP_CACHE_TTL_SECONDS',
    defaultText: String(LIMITS.rbac.groupCacheTtlSeconds.default),
  },
  { name: 'AUTH_REQUIRE_MFA', defaultText: 'true' },
  { name: 'AUTH_MFA_AMR_VALUES', defaultText: 'mfa,multipleauthn' },
  { name: 'BREAK_GLASS_USERNAME', defaultText: UNSET },
  { name: 'BREAK_GLASS_PASSWORD_HASH', defaultText: UNSET, secret: true },
];

const BOOLEAN_TEXT = (name: string): string => `${name} must be true or false`;

const rangeText = (name: string, range: { readonly min: number; readonly max: number }): string =>
  `${name} must be an integer between ${String(range.min)} and ${String(range.max)}`;

/** The messages. Fixed texts: none of them can carry a value (see the header of this file). */
export const ENV_MESSAGES: Readonly<Record<EnvName, string>> = {
  PORT: `PORT must be an integer between ${String(MIN_PORT)} and ${String(MAX_PORT)}`,
  HOST: 'HOST must be a host name or an IP address',
  DATA_DIR: 'DATA_DIR must be an absolute path',
  PUBLIC_BASE_URL:
    'PUBLIC_BASE_URL must be https, or http with the host localhost, as an origin without path, query, fragment or credentials',
  TRUST_PROXY: `TRUST_PROXY must be none, a number of proxies from 1 to ${String(MAX_TRUSTED_HOPS)}, or a comma-separated list of at most ${String(MAX_TRUSTED_ENTRIES)} IP addresses or CIDR ranges`,
  SHOWCASE: BOOLEAN_TEXT('SHOWCASE'),
  LOG_LEVEL: `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`,
  HSTS_MAX_AGE: `HSTS_MAX_AGE must be an integer between 0 and ${String(MAX_HSTS_MAX_AGE)}`,
  HSTS_INCLUDE_SUBDOMAINS: BOOLEAN_TEXT('HSTS_INCLUDE_SUBDOMAINS'),
  HSTS_PRELOAD: BOOLEAN_TEXT('HSTS_PRELOAD'),
  APP_KEY:
    'APP_KEY must be 32 bytes written as base64, base64url or 64 hexadecimal characters, with at least 16 distinct byte values',
  APP_KEY_FILE: 'APP_KEY_FILE must be an absolute path',
  APP_KEY_PREVIOUS:
    'APP_KEY_PREVIOUS must be 32 bytes written as base64, base64url or 64 hexadecimal characters, with at least 16 distinct byte values',
  APP_KEY_PREVIOUS_FILE: 'APP_KEY_PREVIOUS_FILE must be an absolute path',
  SETUP_TOKEN:
    'SETUP_TOKEN must be 24 to 128 characters from A-Z a-z 0-9 - _ . ~ with at least 12 distinct characters',
  BOOTSTRAP_CLIENT_ID: 'BOOTSTRAP_CLIENT_ID must be a GUID',
  SETUP_PROPAGATION_TIMEOUT_SECONDS: rangeText(
    'SETUP_PROPAGATION_TIMEOUT_SECONDS',
    LIMITS.setup.propagationTimeoutSeconds,
  ),
  SESSION_IDLE_TIMEOUT_MINUTES: rangeText(
    'SESSION_IDLE_TIMEOUT_MINUTES',
    LIMITS.session.idleTimeoutMinutes,
  ),
  SESSION_ABSOLUTE_TIMEOUT_HOURS: rangeText(
    'SESSION_ABSOLUTE_TIMEOUT_HOURS',
    LIMITS.session.absoluteTimeoutHours,
  ),
  GROUP_CACHE_TTL_SECONDS: rangeText('GROUP_CACHE_TTL_SECONDS', LIMITS.rbac.groupCacheTtlSeconds),
  AUTH_REQUIRE_MFA: BOOLEAN_TEXT('AUTH_REQUIRE_MFA'),
  AUTH_MFA_AMR_VALUES:
    'AUTH_MFA_AMR_VALUES must be 1 to 8 distinct comma-separated values of 2 to 32 characters from a-z 0-9, and must not include pwd, wia or x509',
  BREAK_GLASS_USERNAME: 'BREAK_GLASS_USERNAME must be 3 to 64 characters from A-Z a-z 0-9 . _ -',
  BREAK_GLASS_PASSWORD_HASH:
    'BREAK_GLASS_PASSWORD_HASH must be a scrypt: hash with N from 16384 to 131072, r 8 to 16, p 1 to 4 and 128 * N * r of at most 134217728',
};

/** Cross-variable messages, also fixed texts. */
export const CROSS_MESSAGES = {
  hstsPreload: `HSTS_PRELOAD=true requires HSTS_INCLUDE_SUBDOMAINS=true and HSTS_MAX_AGE of at least ${String(LIMITS.hstsMaxAgeSeconds)}`,
  appKeyExclusive: 'APP_KEY and APP_KEY_FILE are mutually exclusive: set only one of them',
  appKeyPreviousExclusive:
    'APP_KEY_PREVIOUS and APP_KEY_PREVIOUS_FILE are mutually exclusive: set only one of them',
  breakGlassPair:
    'BREAK_GLASS_USERNAME and BREAK_GLASS_PASSWORD_HASH must be set together or not at all',
  sessionOrder:
    'SESSION_ABSOLUTE_TIMEOUT_HOURS multiplied by 60 must be greater than SESSION_IDLE_TIMEOUT_MINUTES',
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
 * The environment as the application reads it. The input is an object with the keys of
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
    SHOWCASE: variable('SHOWCASE', fallbackOf('SHOWCASE'), parseBoolean),
    LOG_LEVEL: variable('LOG_LEVEL', fallbackOf('LOG_LEVEL'), parseLogLevel),
    HSTS_MAX_AGE: variable('HSTS_MAX_AGE', fallbackOf('HSTS_MAX_AGE'), parseMaxAge),
    HSTS_INCLUDE_SUBDOMAINS: variable(
      'HSTS_INCLUDE_SUBDOMAINS',
      fallbackOf('HSTS_INCLUDE_SUBDOMAINS'),
      parseBoolean,
    ),
    HSTS_PRELOAD: variable('HSTS_PRELOAD', fallbackOf('HSTS_PRELOAD'), parseBoolean),
    // Phase B. A variable with no default stays `undefined` when it is not set.
    APP_KEY: variable('APP_KEY', undefined, parseAppKeyVariable),
    APP_KEY_FILE: variable('APP_KEY_FILE', undefined, parseKeyFilePath),
    APP_KEY_PREVIOUS: variable('APP_KEY_PREVIOUS', undefined, parseAppKeyVariable),
    APP_KEY_PREVIOUS_FILE: variable('APP_KEY_PREVIOUS_FILE', undefined, parseKeyFilePath),
    SETUP_TOKEN: variable('SETUP_TOKEN', undefined, parseSetupToken),
    BOOTSTRAP_CLIENT_ID: variable(
      'BOOTSTRAP_CLIENT_ID',
      fallbackOf('BOOTSTRAP_CLIENT_ID'),
      parseGuidLowerCased,
    ),
    SETUP_PROPAGATION_TIMEOUT_SECONDS: variable(
      'SETUP_PROPAGATION_TIMEOUT_SECONDS',
      fallbackOf('SETUP_PROPAGATION_TIMEOUT_SECONDS'),
      parseWholeNumber(
        LIMITS.setup.propagationTimeoutSeconds.min,
        LIMITS.setup.propagationTimeoutSeconds.max,
      ),
    ),
    SESSION_IDLE_TIMEOUT_MINUTES: variable(
      'SESSION_IDLE_TIMEOUT_MINUTES',
      fallbackOf('SESSION_IDLE_TIMEOUT_MINUTES'),
      parseWholeNumber(
        LIMITS.session.idleTimeoutMinutes.min,
        LIMITS.session.idleTimeoutMinutes.max,
      ),
    ),
    SESSION_ABSOLUTE_TIMEOUT_HOURS: variable(
      'SESSION_ABSOLUTE_TIMEOUT_HOURS',
      fallbackOf('SESSION_ABSOLUTE_TIMEOUT_HOURS'),
      parseWholeNumber(
        LIMITS.session.absoluteTimeoutHours.min,
        LIMITS.session.absoluteTimeoutHours.max,
      ),
    ),
    GROUP_CACHE_TTL_SECONDS: variable(
      'GROUP_CACHE_TTL_SECONDS',
      fallbackOf('GROUP_CACHE_TTL_SECONDS'),
      parseWholeNumber(LIMITS.rbac.groupCacheTtlSeconds.min, LIMITS.rbac.groupCacheTtlSeconds.max),
    ),
    AUTH_REQUIRE_MFA: variable('AUTH_REQUIRE_MFA', fallbackOf('AUTH_REQUIRE_MFA'), parseBoolean),
    AUTH_MFA_AMR_VALUES: variable(
      'AUTH_MFA_AMR_VALUES',
      fallbackOf('AUTH_MFA_AMR_VALUES'),
      parseAmrValues,
    ),
    BREAK_GLASS_USERNAME: variable('BREAK_GLASS_USERNAME', undefined, parseBreakGlassUsername),
    BREAK_GLASS_PASSWORD_HASH: variable(
      'BREAK_GLASS_PASSWORD_HASH',
      undefined,
      parseBreakGlassHash,
    ),
  })
  .transform((values, context): AppConfig => {
    // Every default above is a valid value, so a field is only undefined when it has no default.
    const port = values.PORT ?? DEFAULT_PORT;
    // The default base URL is the browser's view of the default setup (A-63): this machine.
    const base: PublicBase = values.PUBLIC_BASE_URL ?? {
      origin: `http://localhost:${String(port)}`,
      host: 'localhost',
      https: false,
      text: `http://localhost:${String(port)}`,
    };
    const hsts = {
      maxAgeSeconds: values.HSTS_MAX_AGE ?? LIMITS.hstsMaxAgeSeconds,
      includeSubDomains: values.HSTS_INCLUDE_SUBDOMAINS ?? false,
      preload: values.HSTS_PRELOAD ?? false,
    };
    const issue = (message: string, path: EnvName): void => {
      context.issues.push({ code: 'custom', message, input: undefined, path: [path] });
    };

    // Baseline section 13: a preload promise needs includeSubDomains and at least a year.
    if (
      hsts.preload &&
      (!hsts.includeSubDomains || hsts.maxAgeSeconds < LIMITS.hstsMaxAgeSeconds)
    ) {
      issue(CROSS_MESSAGES.hstsPreload, 'HSTS_PRELOAD');
    }
    // FR-B-104, FR-B-109: one source for the key, one for the previous key.
    if (values.APP_KEY !== undefined && values.APP_KEY_FILE !== undefined) {
      issue(CROSS_MESSAGES.appKeyExclusive, 'APP_KEY');
    }
    if (values.APP_KEY_PREVIOUS !== undefined && values.APP_KEY_PREVIOUS_FILE !== undefined) {
      issue(CROSS_MESSAGES.appKeyPreviousExclusive, 'APP_KEY_PREVIOUS');
    }
    // FR-B-521: the break-glass account is both variables or none.
    if (
      (values.BREAK_GLASS_USERNAME === undefined) !==
      (values.BREAK_GLASS_PASSWORD_HASH === undefined)
    ) {
      issue(
        CROSS_MESSAGES.breakGlassPair,
        values.BREAK_GLASS_USERNAME === undefined
          ? 'BREAK_GLASS_USERNAME'
          : 'BREAK_GLASS_PASSWORD_HASH',
      );
    }
    // FR-B-407: the absolute lifetime must exceed the idle one.
    const idleMinutes =
      values.SESSION_IDLE_TIMEOUT_MINUTES ?? LIMITS.session.idleTimeoutMinutes.default;
    const absoluteHours =
      values.SESSION_ABSOLUTE_TIMEOUT_HOURS ?? LIMITS.session.absoluteTimeoutHours.default;
    if (absoluteHours * 60 <= idleMinutes) {
      issue(CROSS_MESSAGES.sessionOrder, 'SESSION_ABSOLUTE_TIMEOUT_HOURS');
    }

    const durations = deriveDurations({
      setupPropagationTimeoutSeconds:
        values.SETUP_PROPAGATION_TIMEOUT_SECONDS ?? LIMITS.setup.propagationTimeoutSeconds.default,
      sessionIdleTimeoutMinutes: idleMinutes,
      sessionAbsoluteTimeoutHours: absoluteHours,
      groupCacheTtlSeconds:
        values.GROUP_CACHE_TTL_SECONDS ?? LIMITS.rbac.groupCacheTtlSeconds.default,
    });
    const keySource = (value: SecretText | undefined, file: string | undefined): KeySource => {
      if (value !== undefined) return { source: 'env', value };
      return file === undefined ? { source: 'none' } : { source: 'file', path: file };
    };

    return deepFreeze({
      port,
      host: values.HOST ?? fallbackOf('HOST'),
      dataDir: values.DATA_DIR ?? fallbackOf('DATA_DIR'),
      publicOrigin: base.origin,
      publicHost: base.host,
      publicIsHttps: base.https,
      trustProxy: values.TRUST_PROXY ?? { mode: 'none' as const },
      showcase: values.SHOWCASE ?? false,
      logLevel: values.LOG_LEVEL ?? 'info',
      hsts,
      ...deriveRedirects(base.text),
      appKey: keySource(values.APP_KEY, values.APP_KEY_FILE),
      appKeyPrevious: keySource(values.APP_KEY_PREVIOUS, values.APP_KEY_PREVIOUS_FILE),
      setupToken: values.SETUP_TOKEN,
      bootstrapClientId: values.BOOTSTRAP_CLIENT_ID ?? DEFAULT_BOOTSTRAP_CLIENT_ID,
      ...durations,
      auth: {
        requireMfa: values.AUTH_REQUIRE_MFA ?? true,
        mfaAmrValues: values.AUTH_MFA_AMR_VALUES ?? ['mfa', 'multipleauthn'],
      },
      breakGlass:
        values.BREAK_GLASS_USERNAME !== undefined && values.BREAK_GLASS_PASSWORD_HASH !== undefined
          ? {
              username: values.BREAK_GLASS_USERNAME,
              passwordHash: values.BREAK_GLASS_PASSWORD_HASH,
            }
          : undefined,
    });
  });

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
