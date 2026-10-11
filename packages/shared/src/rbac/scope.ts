// Scope items: the matrix, the normaliser, the canonical key and the matcher (T-B-232, FR-B-513, B-11,
// BCB-09, SB-07). ONE module for all four, so the server's assignment service, the policy layer and
// the Phase D "view as" screen cannot spell a scope in different ways (FR-B-504, baseline section 10).
//
// A scope item is `{target, match}`: `target` is a resource type; `match` is `{by: 'id', id}`,
// `{by: 'prefix', attr, value}` or `{by: 'department', value}`. `SCOPE_MATRIX` says which combinations
// exist; the SQL CHECK of `rbac_assignment_scope` says the same, and `shared/rbac-scope.test.ts`
// proves in both directions that the two cannot disagree.
//
// Comparison is by `fold`: NFC, lower case, and the final sigma mapped to the medial one (the single
// context-dependent case mapping of `toLowerCase`, which would otherwise make a Greek word that ends
// in a capital sigma a prefix of nothing that continues it). A resource attribute that is missing
// never matches (fail closed).
//
// Pure and platform-neutral: no clock, no I/O, no randomness, no work at import beyond freezing.
import { LIMITS } from '../limits.js';
import type { Guid, ResourceAttrs, ResourceType } from './resources.js';

/** At most this many scope items on one assignment (FR-B-513, spec 6.9.2 `SCOPE_ITEMS_PER_ASSIGNMENT_MAX`). */
export const SCOPE_ITEMS_MAX = LIMITS.rbac.scopeItemsPerAssignmentMax;

/** A prefix or department value has 1 to this many code points (FR-B-513, `SCOPE_VALUE_MAX_CHARS`). */
export const SCOPE_VALUE_MAX_CODE_POINTS = LIMITS.rbac.scopeValueMaxChars;

/** The attributes a prefix item can name. */
export type PrefixAttribute = 'displayName' | 'alias' | 'mail';

/** How a scope item selects resources. */
export type ScopeMatch =
  | { readonly by: 'id'; readonly id: Guid }
  | { readonly by: 'prefix'; readonly attr: PrefixAttribute; readonly value: string }
  | { readonly by: 'department'; readonly value: string };

/** One scope item: it restricts the permissions of its `target` type to the resources it selects. */
export interface ScopeItem {
  readonly target: ResourceType;
  readonly match: ScopeMatch;
}

/** Which match kinds a target accepts. */
export interface ScopeMatrixRow {
  readonly id: boolean;
  readonly prefix: readonly PrefixAttribute[];
  readonly department: boolean;
}

/**
 * The scope matrix (plan 11.3, SB-07). A user has no id scope and no alias; groups and lists have no
 * department; a contact has everything. The normaliser, the matcher, the wire schema and the SQL CHECK
 * all follow this table.
 */
export const SCOPE_MATRIX: Readonly<Record<ResourceType, ScopeMatrixRow>> = Object.freeze({
  user: Object.freeze({
    id: false,
    prefix: Object.freeze(['displayName', 'mail'] as const),
    department: true,
  }),
  group: Object.freeze({
    id: true,
    prefix: Object.freeze(['displayName', 'alias', 'mail'] as const),
    department: false,
  }),
  distributionList: Object.freeze({
    id: true,
    prefix: Object.freeze(['displayName', 'alias', 'mail'] as const),
    department: false,
  }),
  contact: Object.freeze({
    id: true,
    prefix: Object.freeze(['displayName', 'alias', 'mail'] as const),
    department: true,
  }),
});

/**
 * The comparison form of a text: NFC, lower case, final sigma to sigma. `toLowerCase` maps a capital
 * sigma at the end of a word to the final form, so a Greek word and the same word followed by more
 * letters would not share a prefix after it; replacing the final form by the medial one removes the
 * only context-dependent case mapping.
 */
export function fold(text: string): string {
  return text.normalize('NFC').toLowerCase().replaceAll('\u{3c2}', '\u{3c3}');
}

/** Why a scope item (or a list of them) was refused. Not shown to a person; for tests and `errors[]`. */
export type ScopeProblem =
  | 'not_an_object'
  | 'unknown_target'
  | 'unknown_match'
  | 'match_not_allowed'
  | 'attribute_not_allowed'
  | 'unexpected_key'
  | 'invalid_id'
  | 'value_type'
  | 'value_length'
  | 'forbidden_character';

/** The outcome of `normalizeScopeItem`. */
export type ScopeItemResult =
  | { readonly ok: true; readonly item: ScopeItem }
  | { readonly ok: false; readonly reason: ScopeProblem };

/** The outcome of `normalizeScopeItems`; `index` is the position of the first bad item, or null. */
export type ScopeItemsResult =
  | { readonly ok: true; readonly items: readonly ScopeItem[] }
  | {
      readonly ok: false;
      readonly reason: ScopeProblem | 'too_many_items' | 'not_an_array';
      readonly index: number | null;
    };

const refuse = (reason: ScopeProblem): ScopeItemResult => ({ ok: false, reason });

// The organisation-name rejection set (FR-A-081; `branding/org-name.ts`): controls, the line and
// paragraph separators, every Default_Ignorable_Code_Point except the joiners and the variation
// selectors (this covers the bidi controls, the zero-width characters, the soft hyphen, the Hangul
// fillers and the tag characters), the blank Braille pattern and unpaired surrogates. The `u` flag
// makes a lone surrogate one code point.
const UNPAIRED_SURROGATE = /\p{Cs}/u;
const CONTROL_OR_SEPARATOR = /[\p{Cc}\u{2028}\u{2029}]/u;
const INVISIBLE_CHARACTER =
  /(?!\u{200C}|\u{200D}|[\u{FE00}-\u{FE0F}]|[\u{E0100}-\u{E01EF}])\p{Default_Ignorable_Code_Point}|\u{2800}/u;
const GUID_TEXT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A text longer than this can only be long because of spaces to trim; it is refused unread. */
const VALUE_READ_LIMIT = 512;

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return hasOwn(record, key) ? record[key] : undefined;
}

function normalizeValue(
  raw: unknown,
): { ok: true; value: string } | { ok: false; reason: ScopeProblem } {
  if (typeof raw !== 'string') return { ok: false, reason: 'value_type' };
  if (raw.length > VALUE_READ_LIMIT) return { ok: false, reason: 'value_length' };
  if (UNPAIRED_SURROGATE.test(raw)) return { ok: false, reason: 'forbidden_character' };
  const composed = raw.normalize('NFC');
  // Refused wherever they stand and before trimming, so a byte order mark at the start is a refusal.
  if (CONTROL_OR_SEPARATOR.test(composed) || INVISIBLE_CHARACTER.test(composed))
    return { ok: false, reason: 'forbidden_character' };
  const value = composed.trim();
  const length = Array.from(value).length;
  if (length < 1 || length > SCOPE_VALUE_MAX_CODE_POINTS)
    return { ok: false, reason: 'value_length' };
  return { ok: true, value };
}

const KEYS_BY_KIND = {
  id: ['by', 'id'],
  prefix: ['by', 'attr', 'value'],
  department: ['by', 'value'],
} as const;

function normalizeUnsafe(raw: unknown): ScopeItemResult {
  if (!isRecord(raw)) return refuse('not_an_object');
  const target = own(raw, 'target');
  if (typeof target !== 'string' || !hasOwn(SCOPE_MATRIX, target)) return refuse('unknown_target');
  const row = SCOPE_MATRIX[target as ResourceType];
  const match = own(raw, 'match');
  if (!isRecord(match)) return refuse('unknown_match');
  const by = own(match, 'by');
  if (by !== 'id' && by !== 'prefix' && by !== 'department') return refuse('unknown_match');

  if (by === 'id' && !row.id) return refuse('match_not_allowed');
  if (by === 'department' && !row.department) return refuse('match_not_allowed');
  const attr = own(match, 'attr');
  if (
    by === 'prefix' &&
    !(typeof attr === 'string' && (row.prefix as readonly string[]).includes(attr))
  )
    return refuse('attribute_not_allowed');

  const allowedItemKeys = ['target', 'match'];
  const allowedMatchKeys: readonly string[] = KEYS_BY_KIND[by];
  if (
    Object.keys(raw).some((key) => !allowedItemKeys.includes(key)) ||
    Object.keys(match).some((key) => !allowedMatchKeys.includes(key))
  )
    return refuse('unexpected_key');

  const targetType = target as ResourceType;
  if (by === 'id') {
    const id = own(match, 'id');
    if (typeof id !== 'string' || !GUID_TEXT.test(id)) return refuse('invalid_id');
    return { ok: true, item: { target: targetType, match: { by, id: id.toLowerCase() } } };
  }
  const value = normalizeValue(own(match, 'value'));
  if (!value.ok) return refuse(value.reason);
  return by === 'prefix'
    ? {
        ok: true,
        item: {
          target: targetType,
          match: { by, attr: attr as PrefixAttribute, value: value.value },
        },
      }
    : { ok: true, item: { target: targetType, match: { by, value: value.value } } };
}

/**
 * Validates `raw` against `SCOPE_MATRIX` and returns the canonical item, or a typed reason (FR-B-513):
 * GUIDs lower-cased; values NFC-normalised and trimmed, 1 to 64 code points, with none of the
 * organisation-name rejection set; an attribute or match kind the target does not take is refused;
 * unknown keys are refused. Never throws, and reads own properties only.
 */
export function normalizeScopeItem(raw: unknown): ScopeItemResult {
  try {
    return normalizeUnsafe(raw);
  } catch {
    // A getter or a proxy that throws is not an item.
    return refuse('not_an_object');
  }
}

/**
 * The comparison key of one item: `[target, by, attr, text]` as JSON, where `text` is the lower-case id
 * or the folded value. Two spellings of one item (case, Unicode form) have one key, so a duplicate
 * cannot hide behind them; the stored text keeps the case that was typed.
 */
export function scopeItemKey(item: ScopeItem): string {
  const { match } = item;
  switch (match.by) {
    case 'id':
      return JSON.stringify([item.target, 'id', '', match.id.toLowerCase()]);
    case 'prefix':
      return JSON.stringify([item.target, 'prefix', match.attr, fold(match.value)]);
    case 'department':
      return JSON.stringify([item.target, 'department', '', fold(match.value)]);
  }
}

/**
 * The canonical key of a scope: the keys of the distinct items in code-unit order, as a JSON-like
 * array. Stable under order and duplicates; `[]` for no scope. The server hashes it with SHA-256 into
 * `rbac_assignment.scope_hash` (FR-B-508 uniqueness).
 */
export function canonicalScopeKey(items: readonly ScopeItem[]): string {
  return `[${[...new Set(items.map(scopeItemKey))].sort().join(',')}]`;
}

/**
 * The distinct items of a list in canonical order (by `scopeItemKey`). Two spellings of one item (case,
 * Unicode form) are one item; the spelling kept is the smaller one by code units, so the result does
 * not depend on the order of the input. Never changes its argument.
 */
export function dedupeScopeItems(items: readonly ScopeItem[]): ScopeItem[] {
  const byKey = new Map<string, { readonly item: ScopeItem; readonly text: string }>();
  for (const item of items) {
    const key = scopeItemKey(item);
    const text = JSON.stringify(item);
    const kept = byKey.get(key);
    if (kept === undefined || text < kept.text) byKey.set(key, { item, text });
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { item }]) => item);
}

/**
 * Normalises a whole scope: at most 50 items, each through `normalizeScopeItem`, duplicates (whatever
 * their spelling) dropped, the rest in canonical order. The limit counts the items as sent.
 */
export function normalizeScopeItems(raw: unknown): ScopeItemsResult {
  if (!Array.isArray(raw)) return { ok: false, reason: 'not_an_array', index: null };
  if (raw.length > SCOPE_ITEMS_MAX) return { ok: false, reason: 'too_many_items', index: null };
  const items: ScopeItem[] = [];
  for (const [index, entry] of (raw as unknown[]).entries()) {
    const result = normalizeScopeItem(entry);
    if (!result.ok) return { ok: false, reason: result.reason, index };
    items.push(result.item);
  }
  return { ok: true, items: dedupeScopeItems(items) };
}

function matchesUnsafe(item: ScopeItem, resource: ResourceAttrs): boolean {
  if (!hasOwn(SCOPE_MATRIX, item.target) || item.target !== resource.type) return false;
  const row = SCOPE_MATRIX[item.target];
  const { match } = item;
  switch (match.by) {
    case 'id': {
      // Never matches a resource without an id, so it cannot match an object that is about to be created.
      if (!row.id || typeof match.id !== 'string' || match.id === '') return false;
      return (
        typeof resource.id === 'string' &&
        resource.id !== '' &&
        resource.id.toLowerCase() === match.id.toLowerCase()
      );
    }
    case 'prefix': {
      if (typeof match.attr !== 'string' || !(row.prefix as readonly string[]).includes(match.attr))
        return false;
      if (typeof match.value !== 'string') return false;
      const wanted = fold(match.value);
      if (wanted === '') return false;
      const actual = resource[match.attr];
      return typeof actual === 'string' && fold(actual).startsWith(wanted);
    }
    case 'department': {
      if (!row.department || typeof match.value !== 'string') return false;
      const wanted = fold(match.value);
      const actual = resource.department;
      return wanted !== '' && typeof actual === 'string' && fold(actual) === wanted;
    }
    default:
      return false;
  }
}

/**
 * Does `item` select `resource`? The item's target must equal the resource type; `id` compares
 * lower-case GUIDs and never matches a resource without an id; `prefix` is `fold(attribute)
 * .startsWith(fold(value))`; `department` is `fold` equality. A missing, null or empty attribute, an
 * empty value, a combination the matrix does not allow and a malformed item never match (fail closed).
 * Never throws.
 */
export function matchScope(item: ScopeItem, resource: ResourceAttrs): boolean {
  try {
    return matchesUnsafe(item, resource);
  } catch {
    return false;
  }
}
