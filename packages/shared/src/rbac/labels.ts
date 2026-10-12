// The words for access (T-B-254, FR-B-716, FR-B-713, baseline section 10, AN-05): role, permission,
// qualifier, resource type, scope item, origin and principal, in ONE module. The server sends facts
// (keys, ids, parameters), never translated text; the web app turns the message references below into
// text with its translator. `MeResponse`, `MyAccessResponse`, the scope text component, the persona menu
// and the finish page call these functions only: nothing builds a `role.` or `permission.` key by hand.
//
// A built-in role and a permission are shown through a catalogue key. A CUSTOM role (Phase D) and an
// unknown permission are shown as typed: they have no catalogue entry, and inventing one would be
// wrong. Grouping by role is by KEY, never by the label, so two spellings of a role cannot make two
// buckets and the buckets always add up to the list.
//
// Pure and platform-neutral: no clock, no I/O, no randomness, no work at import beyond building the key list.
import { PERMISSIONS } from '../permissions.js';
import { RESOURCE_TYPES, type Qualifier, type ResourceType } from './resources.js';
import { BUILTIN_ROLE_KEYS } from './roles.js';
import { normalizeScopeItem, type ScopeItem } from './scope.js';

/** A catalogue key with its parameters, or text that has no catalogue entry and is shown as typed. */
export type Label =
  | { readonly kind: 'message'; readonly key: string }
  | { readonly kind: 'text'; readonly text: string };

/** A catalogue key with the parameters of its message. */
export interface ParamLabel {
  readonly kind: 'message';
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
}

const BUILTIN: ReadonlySet<string> = new Set(BUILTIN_ROLE_KEYS);
const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

/** `role.<key>` for the five built-in roles; a custom role as typed. */
export function roleLabelKey(role: string): Label {
  return BUILTIN.has(role)
    ? { kind: 'message', key: `role.${role}` }
    : { kind: 'text', text: role };
}

/** `permission.<permission>` for the 15 permissions; anything else as typed. */
export function permissionLabelKey(permission: string): Label {
  return PERMISSION_SET.has(permission)
    ? { kind: 'message', key: `permission.${permission}` }
    : { kind: 'text', text: permission };
}

/** `qualifier.full` or `qualifier.basic`. */
export function qualifierLabelKey(qualifier: Qualifier): Label {
  return { kind: 'message', key: qualifier === 'basic' ? 'qualifier.basic' : 'qualifier.full' };
}

/** `resource.<type>` for the four resource types a scope item can name. */
export function resourceLabelKey(type: ResourceType): Label {
  return { kind: 'message', key: `resource.${type}` };
}

/**
 * One message for a scope item: `scope.id` (parameters `target`, `id`), `scope.prefix.<attribute>` and
 * `scope.department` (parameters `target`, `value`). The item is canonicalised first (GUID lower case,
 * text NFC and trimmed), so one canonical item has one text whatever its spelling. An item the scope
 * matrix does not allow is `scope.invalid`; this function never throws.
 */
export function scopeItemText(item: ScopeItem): ParamLabel {
  const result = normalizeScopeItem(item);
  if (!result.ok) return { kind: 'message', key: 'scope.invalid', params: {} };
  const { target, match } = result.item;
  switch (match.by) {
    case 'id':
      return { kind: 'message', key: 'scope.id', params: { target, id: match.id } };
    case 'prefix':
      return {
        kind: 'message',
        key: `scope.prefix.${match.attr}`,
        params: { target, value: match.value },
      };
    case 'department':
      return {
        kind: 'message',
        key: 'scope.department',
        params: { target, value: match.value },
      };
  }
}

/** Where an assignment came from, as the API sends it. */
export type AssignmentOrigin =
  | { readonly type: 'direct' }
  | { readonly type: 'group'; readonly groupId: string; readonly groupName: string | null };

/** `origin.direct`, `origin.group` (parameter `group`), or `origin.groupUnnamed` when Graph gave no name. */
export function originText(origin: AssignmentOrigin): ParamLabel {
  if (origin.type === 'direct') return { kind: 'message', key: 'origin.direct', params: {} };
  const name = origin.groupName?.trim() ?? '';
  return name === ''
    ? { kind: 'message', key: 'origin.groupUnnamed', params: {} }
    : { kind: 'message', key: 'origin.group', params: { group: name } };
}

/** A person's label: the display name, else the user principal name, else the empty string. */
export function principalLabel(user: {
  readonly displayName?: string | null | undefined;
  readonly userPrincipalName?: string | null | undefined;
}): string {
  const name = user.displayName?.trim() ?? '';
  if (name !== '') return name;
  return user.userPrincipalName?.trim() ?? '';
}

export interface RoleBucket<T> {
  readonly roleKey: string;
  readonly items: readonly T[];
}

/**
 * Groups items by their role KEY (trimmed, lower case), in order of first appearance. Never by a
 * label: the total of the buckets is the length of the list.
 */
export function groupByRole<T extends { readonly role: { readonly key: string } }>(
  items: readonly T[],
): RoleBucket<T>[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = item.role.key.trim().toLowerCase();
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [item]);
    else bucket.push(item);
  }
  return [...buckets].map(([roleKey, bucketItems]) => ({ roleKey, items: bucketItems }));
}

/** Every catalogue key these functions can produce, once, for the catalogue check (`message-keys`). */
export const ALL_LABEL_KEYS: readonly string[] = Object.freeze([
  ...BUILTIN_ROLE_KEYS.map((key) => `role.${key}`),
  ...PERMISSIONS.map((permission) => `permission.${permission}`),
  'qualifier.full',
  'qualifier.basic',
  ...RESOURCE_TYPES.map((type) => `resource.${type}`),
  'scope.id',
  'scope.prefix.displayName',
  'scope.prefix.alias',
  'scope.prefix.mail',
  'scope.department',
  'scope.invalid',
  'origin.direct',
  'origin.group',
  'origin.groupUnnamed',
]);
