// The `errors[]` detail codes that have a message of their own (FR-B-603, T-B-292): a problem body
// carries `errors[]` entries of `{pointer, code}`, and for these codes the UI shows the message below
// instead of (or next to) the message of the problem. They are not problem codes (CD-05) and not
// wizard result codes, except `owner_changed`, which is both: its message is the result code's.
//
// The keys live in the namespace the screen that meets the code loads: `access` (the assignment
// screen), `breakglass` (restore access), `setup` (the finish step) and `users` (the users and groups
// pages, which both load it).

/** The detail codes of `errors[]` with a catalogue message, and the key of that message. */
export const ERROR_DETAIL_MESSAGE_KEYS = Object.freeze({
  privileged_role_group: 'access.error.privileged_role_group',
  principal_disabled: 'breakglass.restore.disabled',
  owner_changed: 'setup.result.owner_changed',
  // Phase C (EC-C14): a Graph 403 for the panel's own application on a users or groups read. The page
  // points to Settings, Connection (repair). Both directory pages load the `users` namespace for it.
  graph_permission_missing: 'users.error.graph_permission_missing',
  // Phase D (spec 6.11.3, EC-D1, EC-D2): detail codes of `exchange_unavailable`. The keys are in the
  // `distributionLists` namespace; the contacts pages load that namespace too for them.
  exchange_role_pending: 'distributionLists.error.exchange_role_pending',
  exchange_timeout: 'distributionLists.error.exchange_timeout',
} as const);

export type ErrorDetailCode = keyof typeof ERROR_DETAIL_MESSAGE_KEYS;

/** Every detail code with a message, in registry order. */
export const ERROR_DETAIL_CODES: readonly ErrorDetailCode[] = Object.freeze(
  Object.keys(ERROR_DETAIL_MESSAGE_KEYS) as ErrorDetailCode[],
);

/** The message key of a detail code, or `undefined` for a code the UI has no text for. */
export function errorDetailMessageKey(code: string): string | undefined {
  return Object.hasOwn(ERROR_DETAIL_MESSAGE_KEYS, code)
    ? ERROR_DETAIL_MESSAGE_KEYS[code as ErrorDetailCode]
    : undefined;
}
