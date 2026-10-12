// The live-log message keys of the wizard (tasks T-B-120, CB13, TB-13; plan Appendix A, FR-B-211).
//
// A `setup_log` row is `{seq, ts, step, level, messageKey, params}`. The row carries a key and
// scalar parameters, never translated text and never a secret; every key has an `nl` and an `en`
// text in the `setup` fragments (S-B6; `message-keys.test.ts`). `LOG_KEYS` maps each key to the
// parameter names it may carry, so the writer, the wire schema and the catalogue check agree.
//
// Beyond plan Appendix A (the seed) two keys were added because a requirement asks for a log line
// the seed does not name: `role_fixture_mismatch` (FR-B-302, "a difference between lookup and
// fixture is a warning in the log") and `drift_found` (FR-B-220 and FR-B-307, "extra roles are
// reported"). `setup-registry.test.ts` lists them as the only additions.
//
// FROZEN at gate GB1 (TB-13).

function params<const T extends readonly string[]>(...names: T): T {
  return Object.freeze([...names]) as unknown as T;
}

/** Key to the parameter names it carries (all scalar: string, number or boolean). */
export const LOG_KEYS = Object.freeze({
  'setup.log.run_started': params('mode', 'steps'),
  'setup.log.step_started': params('step'),
  'setup.log.sub_started': params('step', 'sub'),
  'setup.log.read': params('what'),
  'setup.log.found': params('kind', 'name'),
  'setup.log.created': params('kind', 'name'),
  'setup.log.adopted': params('kind', 'name'),
  'setup.log.unchanged': params('kind'),
  'setup.log.waiting_replication': params('attempt', 'max', 'seconds'),
  'setup.log.retry_transient': params('attempt', 'max', 'seconds'),
  'setup.log.permanent_error': params('code'),
  'setup.log.bootstrap_waiting': params('seconds'),
  'setup.log.bootstrap_signed_in': params(),
  'setup.log.bootstrap_discarded': params(),
  'setup.log.certificate_generated': params('thumbprint8'),
  'setup.log.certificate_uploaded': params(),
  'setup.log.token_acquired': params('resource'),
  'setup.log.verified': params('check', 'status'),
  'setup.log.tenant_pinned': params(),
  'setup.log.exchange_skipped': params(),
  'setup.log.manual_checked': params(),
  'setup.log.run_finished': params('status'),
  'setup.log.run_cancelled': params(),
  'setup.log.run_crashed': params('code'),
  // Additions beyond plan Appendix A (see the header).
  'setup.log.role_fixture_mismatch': params('role'),
  'setup.log.drift_found': params('kind'),
} as const);

export type LogKey = keyof typeof LOG_KEYS;

/** Every log key, in registry order, as a tuple for `z.enum`. */
export const LOG_KEY_LIST = Object.freeze(Object.keys(LOG_KEYS)) as unknown as readonly [
  LogKey,
  ...LogKey[],
];

export function isLogKey(value: unknown): value is LogKey {
  return typeof value === 'string' && Object.hasOwn(LOG_KEYS, value);
}

/** Every parameter name any log key may carry: the closed list `LogParamsSchema` accepts. */
export const LOG_PARAM_NAMES: readonly string[] = Object.freeze(
  [...new Set(Object.values(LOG_KEYS).flat())].sort(),
);

/**
 * Server log events (FR-B-715): structured events of the process log, not wizard log keys. They are
 * listed here because plan Appendix A names them with the wizard keys; the logger of the server
 * emits them and `server/logging-events.test.ts` checks each one.
 */
export const SERVER_LOG_EVENTS = Object.freeze([
  'setup_unlock_locked',
  'setup_step',
  'signin_ok',
  'signin_denied',
  'session_revoked',
  'break_glass_signin',
  'membership_refresh_failed',
  'preview_mode_removed',
  'setup_token_after_complete',
  'app_key_previous_in_use',
  'cookie_duplicate',
  'jwks_refresh_failed',
  'builtin_roles_mismatch',
] as const);
export type ServerLogEvent = (typeof SERVER_LOG_EVENTS)[number];
