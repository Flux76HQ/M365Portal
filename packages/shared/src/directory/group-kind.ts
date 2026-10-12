// The kind of a group (FR-C-303, R-C-04): ONE function, used by the server mapper and by the web, so no
// second derivation exists. A kind comes from exactly three properties of the Graph `group` resource:
//
//   | Kind                  | groupTypes           | mailEnabled | securityEnabled | Via Graph |
//   | Microsoft 365         | contains `Unified`   | true        | true or false   | managed   |
//   | Security              | no `Unified`         | false       | true            | managed   |
//   | Mail-enabled security | no `Unified`         | true        | true            | read-only |
//   | Distribution          | no `Unified`         | true        | false           | read-only |
//
// `Unified` decides Microsoft 365 on its own, exactly like the list filter `groupTypes/any(c:c eq
// 'Unified')` of FR-C-301, so a row the `m365` filter returns is never labelled differently. A group
// whose three properties were not all returned (`null`, U36, EC-C10), or that fits no row (neither
// mail nor security), has the kind `unknown`: the UI shows a dash and never guesses. Dynamic
// distribution groups are not returned by Graph at all (R-C-03).
//
// Pure and platform-neutral: no clock, no I/O, no randomness, no work at import beyond freezing.

/** The kinds, in the order of the filter and of the badges. `unknown` is a state, not a filter value. */
export const GROUP_KINDS = Object.freeze([
  'm365',
  'security',
  'mailsecurity',
  'distribution',
  'unknown',
] as const);
export type GroupKind = (typeof GROUP_KINDS)[number];

/** The kinds that Microsoft Graph lists but cannot change ("read-only in Microsoft Graph", R-C-04). */
export const READ_ONLY_GROUP_KINDS = Object.freeze(['mailsecurity', 'distribution'] as const);

/** The three properties a kind is derived from; `null` is a property Graph did not return. */
export interface GroupKindInput {
  readonly groupTypes: readonly string[] | null;
  readonly mailEnabled: boolean | null;
  readonly securityEnabled: boolean | null;
}

/** Is this a group with a value of the right type? Graph answers are parsed, but this is the last net. */
function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** The kind of a group; `unknown` when a property is `null` (or not what Graph sends) or fits no row. */
export function groupKindOf(group: GroupKindInput): GroupKind {
  const { groupTypes, mailEnabled, securityEnabled } = group;
  if (!isStringList(groupTypes)) return 'unknown';
  if (typeof mailEnabled !== 'boolean' || typeof securityEnabled !== 'boolean') return 'unknown';
  if (groupTypes.includes('Unified')) return 'm365';
  if (mailEnabled) return securityEnabled ? 'mailsecurity' : 'distribution';
  return securityEnabled ? 'security' : 'unknown';
}

/** Is this kind read-only in Microsoft Graph (mail-enabled security and distribution groups)? */
export function isReadOnlyGroupKind(kind: GroupKind): boolean {
  return (READ_ONLY_GROUP_KINDS as readonly GroupKind[]).includes(kind);
}

/** `assigned` or `dynamic` (FR-C-304), from `groupTypes`; `null` when the property was not returned. */
export function membershipTypeOf(
  groupTypes: readonly string[] | null,
): 'assigned' | 'dynamic' | null {
  if (!isStringList(groupTypes)) return null;
  return groupTypes.includes('DynamicMembership') ? 'dynamic' : 'assigned';
}
