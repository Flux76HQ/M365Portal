// The canonical form of an audit entry and its detail (data-model 7.2, FR-A-070, FR-A-073, I-10).
//
// Canonical JSON is what is hashed, so it is written by hand here instead of by a library that might
// change its mind about key order or escaping:
//   - keys sorted by UTF-16 code unit (what `Array#sort` without a comparator does to strings)
//   - no insignificant white space
//   - strings exactly as `JSON.stringify` writes them
//   - numbers only as safe integers; anything else is a `TypeError`, not a rounded number
//
// The hashed object has exactly twelve keys, in snake case as the columns are named; absent values
// are `null`. `detail` is embedded as its STORED TEXT (a JSON string value, not a parsed object), so a
// change of a single byte of the stored text, white space included, changes the hash.
//
// The detail is built from an allow-list of keys and types (the action vocabulary of data-model 7.4),
// so a request body or a secret cannot reach the audit table by accident: an unknown key is refused,
// strings are cut at 256 bytes on a code-point boundary, and a detail of more than 4,096 bytes is
// replaced by the list of its keys.
import { SIGNIN_CHECKS, STEPUP_CHECKS } from '@m365portal/shared/auth/signin-errors';
import { LIMITS } from '@m365portal/shared/limits';
import { IsoTimestampSchema } from '@m365portal/shared/schemas/common';
import { SETUP_MODES, SETUP_STATES, STEPS, STEP_KEYS } from '@m365portal/shared/setup/steps';

// ---------------------------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------------------------

export type CanonicalValue = string | number | null;

function canonicalValue(value: CanonicalValue): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TypeError('canonical JSON writes numbers only as safe integers');
  }
  return JSON.stringify(value);
}

/** One flat object as canonical JSON: keys sorted, no white space. */
export function canonicalJson(fields: Readonly<Record<string, CanonicalValue>>): string {
  const body = Object.keys(fields)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(fields[key] ?? null)}`)
    .join(',');
  return `{${body}}`;
}

/** The columns of an entry that are hashed: everything but the two hashes. */
export interface StoredAuditFields {
  readonly seq: number;
  readonly ts: string;
  readonly actorKind: string;
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly outcome: string;
  readonly reasonCode: string | null;
  readonly clientIp: string | null;
  readonly requestId: string | null;
  /** The stored text of `detail`, byte for byte. */
  readonly detail: string;
}

/** The canonical JSON text of an entry, which `prev_hash` is hashed together with. */
export function canonicalEntry(entry: StoredAuditFields): string {
  return canonicalJson({
    seq: entry.seq,
    ts: entry.ts,
    actor_kind: entry.actorKind,
    actor_id: entry.actorId,
    action: entry.action,
    target_type: entry.targetType,
    target_id: entry.targetId,
    outcome: entry.outcome,
    reason_code: entry.reasonCode,
    client_ip: entry.clientIp,
    request_id: entry.requestId,
    detail: entry.detail,
  });
}

// ---------------------------------------------------------------------------------------------
// The detail allow-list
// ---------------------------------------------------------------------------------------------

/**
 * The type of a detail value. Phase A has four. Phase B refines them (spec 6.9.6 rule 2, data-model
 * section 10): `guid` (lower-case canonical), `sha1` (40 lower-case hex), `keyId` (16 lower-case
 * hex, an id and not a key), `instant` (UTC with milliseconds), `enum` (a value of a registry, see
 * `ENUMERATIONS`, or the shape of one), `codes` (at most 16 strings of at most 64 bytes, DM-02) and
 * `name` (NFC, no control characters). The refinement is additive: a value that passes a refined
 * kind also has the basic type of its family (string, or array of strings).
 */
export type DetailKind =
  | 'string'
  | 'integer'
  | 'boolean'
  | 'strings'
  | 'guid'
  | 'sha1'
  | 'keyId'
  | 'instant'
  | 'enum'
  | 'codes'
  | 'name';

/**
 * Every key a detail may hold and the type of its value. The vocabulary is data-model 7.4:
 * `branding.init` and `branding.export` (`revision`, `bytes`), `branding.asset.stage` (`slot`,
 * `bytes`, `sha256`, `created`, `warnings`), `branding.apply` (revisions, old and new name and
 * accent, the hash of each asset role), `branding.reset`, `branding.import` (`dryRun`,
 * `schemaVersion`, `bytes`, the hash of each image slot, `warnings`) and a denied write
 * (`permission`, `method`, `route`). Images appear by hash and size only (FR-A-073).
 *
 * A key that is not here is refused. To record something new, add the key here with its type, in
 * the same change that writes it: that is the review point.
 */
export const AUDIT_DETAIL_KEYS = {
  revision: 'integer',
  fromRevision: 'integer',
  toRevision: 'integer',
  bytes: 'integer',
  schemaVersion: 'integer',
  created: 'boolean',
  dryRun: 'boolean',
  slot: 'string',
  sha256: 'string',
  orgNameOld: 'string',
  orgNameNew: 'string',
  accentOld: 'string',
  accentNew: 'string',
  // The hash of each asset role of a branding, and of each slot of an import.
  logoLight: 'string',
  logoDark: 'string',
  logoCompact: 'string',
  compact: 'string',
  iconFavicon32: 'string',
  iconApple180: 'string',
  iconPwa192: 'string',
  iconPwa512: 'string',
  iconMaskable512: 'string',
  warnings: 'strings',
  // A denied write: what was needed and where.
  permission: 'string',
  method: 'string',
  route: 'string',

  // Phase B (T-B-013, spec 6.9.6): the 38 keys of the 19 actions in `actions.ts`.
  // A setup step or sub-action ran: which, with what result.
  step: 'enum',
  subAction: 'enum',
  status: 'enum',
  attempt: 'integer',
  codes: 'codes',
  mode: 'enum',
  // A tenant object was created, adopted or changed (ids are GUIDs only; grants and directory role
  // assignments have none, so `objectId` is then omitted and `kind` and `name` identify the object).
  kind: 'enum',
  op: 'enum',
  objectId: 'guid',
  appId: 'guid',
  name: 'name',
  confirmed: 'boolean',
  tid: 'guid',
  fromState: 'enum',
  drift: 'codes',
  checks: 'codes',
  // A certificate and the sealing key (key ids, never keys).
  thumbprintSha1: 'sha1',
  notAfter: 'instant',
  rows: 'integer',
  fromKeyId: 'keyId',
  toKeyId: 'keyId',
  // Sign-in, sessions, break-glass.
  reason: 'enum',
  check: 'enum',
  mfa: 'boolean',
  groupsResolved: 'boolean',
  purpose: 'enum',
  scope: 'enum',
  sessions: 'integer',
  // Assignments.
  principalType: 'enum',
  principalId: 'guid',
  role: 'enum',
  scopeTargets: 'codes',
  scopeItems: 'integer',
  expiresAt: 'instant',
  source: 'enum',
  assignmentId: 'guid',
  graphChecked: 'boolean',
  lockScope: 'enum',
} as const satisfies Readonly<Record<string, DetailKind>>;

export type AuditDetailKey = keyof typeof AUDIT_DETAIL_KEYS;

type DetailValueOf<Key extends AuditDetailKey> = (typeof AUDIT_DETAIL_KEYS)[Key] extends
  'string' | 'guid' | 'sha1' | 'keyId' | 'instant' | 'enum' | 'name'
  ? string
  : (typeof AUDIT_DETAIL_KEYS)[Key] extends 'integer'
    ? number
    : (typeof AUDIT_DETAIL_KEYS)[Key] extends 'boolean'
      ? boolean
      : readonly string[];

/** The detail a caller passes: a flat map of allowed keys. `undefined` means absent. */
export type AuditDetail = { readonly [Key in AuditDetailKey]?: DetailValueOf<Key> | undefined };

/** One string value is cut at this many bytes. */
export const DETAIL_STRING_BYTES = 256;
/** A string array keeps this many items. */
export const DETAIL_ARRAY_ITEMS = 16;
/** The items of a `strings` array are cut at this many bytes (Phase A, `warnings`). */
export const DETAIL_ARRAY_ITEM_BYTES = 256;
/** The items of a `codes` array are cut at this many bytes (DM-02). */
export const DETAIL_CODE_BYTES = 64;

/** The shape of an enumeration value that has no closed registry (yet): lower-case snake case. */
const ENUM_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The enumerations that have a closed registry in `@m365portal/shared`: the value must be one of
 * its members. The other enumeration keys (`status`, `kind`, `op`, `reason`, `purpose`, `scope`,
 * `lockScope`, `role`) are checked by shape only: their values come from several registries (the
 * sign-in reasons, the setup result codes, the roles of Phase D) that this module must not freeze
 * ahead of the streams that own them; `audit-b-coverage.test.ts` (T-B-391) is where a stray value
 * is caught.
 */
export const ENUMERATIONS: Readonly<Partial<Record<AuditDetailKey, readonly string[]>>> =
  Object.freeze({
    step: STEP_KEYS,
    subAction: Object.values(STEPS).flatMap((definition) => [...definition.subActions]),
    mode: SETUP_MODES,
    fromState: SETUP_STATES,
    check: [...SIGNIN_CHECKS, ...STEPUP_CHECKS],
    principalType: ['user', 'group'],
    source: ['wizard', 'api', 'break_glass'],
  });

/** A key named like a secret is refused even when someone adds it to the allow-list by mistake. */
const SECRET_LIKE_KEY = /secret|token|key|password|assertion|pem|credential/i;
/** The two key-id keys are ids, not keys (FR-B-104), and are on the allow-list by exact name. */
const KEY_ID_KEYS: ReadonlySet<string> = new Set(['fromKeyId', 'toKeyId']);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export class AuditDetailError extends Error {
  readonly key: string;

  constructor(key: string, problem: string) {
    super(`audit detail key "${key}" ${problem}`);
    this.name = 'AuditDetailError';
    this.key = key;
  }
}

/**
 * Cut `text` to at most `maxBytes` bytes of UTF-8 without splitting a code point. A surrogate pair
 * stays whole or goes whole; a lone surrogate counts as the three bytes it is written with.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let kept = '';
  let bytes = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint);
    if (bytes + size > maxBytes) break;
    kept += codePoint;
    bytes += size;
  }
  return kept;
}

function isAllowedKey(key: string): key is AuditDetailKey {
  return Object.hasOwn(AUDIT_DETAIL_KEYS, key);
}

function detailValue(
  key: AuditDetailKey,
  value: unknown,
): string | number | boolean | readonly string[] {
  const kind: DetailKind = AUDIT_DETAIL_KEYS[key];
  switch (kind) {
    case 'string':
      if (typeof value !== 'string') throw new AuditDetailError(key, 'takes a string');
      return truncateUtf8(value, DETAIL_STRING_BYTES);
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new AuditDetailError(key, 'takes a safe integer');
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw new AuditDetailError(key, 'takes a boolean');
      return value;
    case 'strings':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new AuditDetailError(key, 'takes an array of strings');
      }
      return (value as string[])
        .slice(0, DETAIL_ARRAY_ITEMS)
        .map((item) => truncateUtf8(item, DETAIL_ARRAY_ITEM_BYTES));
    case 'codes':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new AuditDetailError(key, 'takes an array of strings');
      }
      return (value as string[])
        .slice(0, DETAIL_ARRAY_ITEMS)
        .map((item) => truncateUtf8(item, DETAIL_CODE_BYTES));
    case 'guid':
      return matching(key, value, GUID, 'takes a lower-case GUID');
    case 'sha1':
      return matching(key, value, SHA1, 'takes 40 lower-case hexadecimal characters');
    case 'keyId':
      return matching(key, value, KEY_ID, 'takes 16 lower-case hexadecimal characters');
    case 'instant':
      if (typeof value !== 'string' || !IsoTimestampSchema.safeParse(value).success) {
        throw new AuditDetailError(key, 'takes a UTC instant with milliseconds');
      }
      return value;
    case 'enum': {
      const text = matching(key, value, ENUM_SHAPE, 'takes a lower-case identifier');
      const members = ENUMERATIONS[key];
      if (members !== undefined && !members.includes(text)) {
        throw new AuditDetailError(key, 'takes a value of its registry');
      }
      return text;
    }
    case 'name':
      if (typeof value !== 'string') throw new AuditDetailError(key, 'takes a string');
      if (value.normalize('NFC') !== value || CONTROL_CHARACTERS.test(value)) {
        throw new AuditDetailError(key, 'takes NFC text without control characters');
      }
      return truncateUtf8(value, DETAIL_STRING_BYTES);
  }
}

/** `value` when it is a string that matches `pattern`; else an error that never repeats it. */
function matching(key: AuditDetailKey, value: unknown, pattern: RegExp, problem: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new AuditDetailError(key, problem);
  return value;
}

/** Canonical JSON for the detail's values, which may also be booleans and arrays of strings. */
function serialise(entries: readonly [string, unknown][]): string {
  const body = [...entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(',');
  return `{${body}}`;
}

/**
 * The stored text of a detail: canonical JSON of the allowed keys that are present. Refuses a key
 * that is not on the allow-list or a value of the wrong type (a bug in the caller, found by its
 * test, and the message never contains the value). A detail over `LIMITS.auditDetailBytes` is
 * replaced by `{"keys":[...],"truncated":true}`.
 */
export function buildDetail(detail: AuditDetail | undefined): string {
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries<unknown>(detail ?? {})) {
    if (value === undefined) continue;
    if (SECRET_LIKE_KEY.test(key) && !KEY_ID_KEYS.has(key)) {
      throw new AuditDetailError(key, 'is named like a secret and is refused');
    }
    if (!isAllowedKey(key)) throw new AuditDetailError(key, 'is not on the allow-list');
    entries.push([key, detailValue(key, value)]);
  }

  const text = serialise(entries);
  if (Buffer.byteLength(text) <= LIMITS.auditDetailBytes) return text;
  return serialise([
    ['keys', entries.map(([key]) => key).sort()],
    ['truncated', true],
  ]);
}
