// The setup step registry (tasks T-B-120, CB13, TB-13; spec 6.2.1 and FR-B-210, plan 9.4).
//
// One place names the five wizard steps, their sub-actions (the keys of the `setup_step` rows), the
// states and statuses, the one function that derives a step status from its sub-actions, the closed
// list of keys a step `detail` may carry, the rollback-hint catalogue keys and the rule for the
// device-code verification link. The server, the wizard UI and the catalogue check import these;
// nothing else spells a step or a sub-action.
//
// FROZEN at gate GB1 (TB-13). A key added later goes through S-B6, who owns the fragment text.
//
// Catalogue keys: `setup.step.<step>` names a step, `setup.sub.<sub-action>` a sub-action (the
// sub-action keys are unique across steps, which `setup-registry.test.ts` asserts). The keys are
// derived here so that `message-keys.test.ts` has one source for them.

/** The wizard steps in registry order (spec 6.2.1). */
export const STEP_KEYS = Object.freeze([
  'environment',
  'connect',
  'configure',
  'verify',
  'finish',
] as const);
export type StepKey = (typeof STEP_KEYS)[number];

/** Status of a step or a sub-action (FR-B-210). A step never has `waiting`: it is aggregated. */
export const STEP_STATUSES = Object.freeze([
  'pending',
  'running',
  'waiting',
  'succeeded',
  'warning',
  'failed',
  'skipped',
] as const);
export type StepStatus = (typeof STEP_STATUSES)[number];

/** The persisted setup state; it moves forward only, the CLI is the one way back (FR-B-201). */
export const SETUP_STATES = Object.freeze([
  'unconfigured',
  'in_progress',
  'awaiting_first_signin',
  'completed',
] as const);
export type SetupState = (typeof SETUP_STATES)[number];

/** `tenant_connection` / `setup_state` mode (FR-B-218). */
export const SETUP_MODES = Object.freeze(['automatic', 'manual'] as const);
export type SetupMode = (typeof SETUP_MODES)[number];

export interface StepDefinition {
  readonly key: StepKey;
  /** 1-based position in the wizard. */
  readonly order: number;
  /**
   * The sub-action keys. For `connect` they are alternatives: `device_code` in automatic mode,
   * `manual_inputs` in manual mode (`subActionsOf` picks one).
   */
  readonly subActions: readonly string[];
  /** True when only one of the sub-actions exists in a given mode. */
  readonly alternatives: boolean;
}

function step(
  key: StepKey,
  order: number,
  subActions: readonly string[],
  alternatives = false,
): StepDefinition {
  return Object.freeze({ key, order, subActions: Object.freeze([...subActions]), alternatives });
}

/** Spec 6.2.1: the steps and the sub-actions that become `setup_step` rows. */
export const STEPS: Readonly<Record<StepKey, StepDefinition>> = Object.freeze({
  environment: step('environment', 1, [
    'public_base_url',
    'data_dir',
    'app_key',
    'node_version',
    'network',
    'time_skew',
  ]),
  connect: step('connect', 2, ['device_code', 'manual_inputs'], true),
  configure: step('configure', 3, [
    'application',
    'service_principal',
    'certificate',
    'application_settings',
    'graph_permissions',
    'exchange_permissions',
    'exchange_role',
  ]),
  verify: step('verify', 4, [
    'audit_reads',
    'app_token',
    'organization',
    'users',
    'exchange_probe',
  ]),
  finish: step('finish', 5, ['branding', 'owner', 'beheerder_group', 'language', 'handover']),
});

/** Every sub-action key of every step, in registry order. */
export const SUB_ACTION_KEYS: readonly string[] = Object.freeze(
  STEP_KEYS.flatMap((key) => STEPS[key].subActions),
);

/**
 * The sub-actions that exist for a step in a mode: all of them, except that `connect` has
 * `device_code` in automatic mode and `manual_inputs` in manual mode.
 */
export function subActionsOf(stepKey: StepKey, mode: SetupMode): readonly string[] {
  const definition = STEPS[stepKey];
  if (!definition.alternatives) return definition.subActions;
  const wanted = mode === 'manual' ? 'manual_inputs' : 'device_code';
  return definition.subActions.filter((key) => key === wanted);
}

/** The step a sub-action key belongs to, or `undefined` for a key that is not registered. */
export function stepOfSubAction(subAction: string): StepKey | undefined {
  return STEP_KEYS.find((key) => STEPS[key].subActions.includes(subAction));
}

/**
 * The two Exchange sub-actions. When the tenant has no Exchange service principal they are written
 * `skipped` and make the step `warning` instead of `succeeded` (EB-08, plan 9.4).
 */
export const EXCHANGE_SUB_ACTIONS: readonly string[] = Object.freeze([
  'exchange_permissions',
  'exchange_role',
]);

/** A sub-action as `aggregate` reads it. */
export interface SubActionStatus {
  readonly status: StepStatus;
  /** A `skipped` sub-action that must still colour the step `warning` (EB-08). */
  readonly warning?: boolean;
}

/**
 * The one derivation of a step status (plan 9.4): any `failed` gives `failed`; else any `running`
 * or `waiting` gives `running`; else any `pending` gives `pending`; else any `warning`, or a
 * `skipped` flagged as a warning, gives `warning`; else `succeeded`. Manual mode writes the
 * `configure` sub-actions `skipped` without the flag, so they count as succeeded. A step without
 * sub-actions has not started and is `pending`.
 */
export function aggregate(subs: readonly (StepStatus | SubActionStatus)[]): StepStatus {
  if (subs.length === 0) return 'pending';
  const items = subs.map((sub) => (typeof sub === 'string' ? { status: sub } : sub));
  const has = (...wanted: StepStatus[]): boolean =>
    items.some((item) => wanted.includes(item.status));
  if (has('failed')) return 'failed';
  if (has('running', 'waiting')) return 'running';
  if (has('pending')) return 'pending';
  if (items.some((item) => item.status === 'warning' || item.warning === true)) return 'warning';
  return 'succeeded';
}

/**
 * Key names that are never accepted in a step `detail`, a log parameter or an audit detail
 * (FR-B-210): they look like a secret. The pattern is matched case-insensitively against the name
 * of every key at every depth.
 */
export const SECRET_KEY_PATTERN = /secret|token|key|password|assertion|pem|credential/i;

/** True when a key name looks like a secret (`secret`, `token`, `key`, `password`, ...). */
export function isSecretLookingKey(name: string): boolean {
  return SECRET_KEY_PATTERN.test(name);
}

/**
 * The closed list of keys a `setup_step.detail` may carry (FR-B-210, plan 9.4). Values are strings
 * of at most 256 bytes, numbers or booleans; `objectId`, `appId` and `tenantId` are GUIDs. No name
 * on this list looks like a secret (`setup-registry.test.ts`).
 */
export const SETUP_STEP_DETAIL: readonly string[] = Object.freeze([
  'manual',
  'exchangeEnabled',
  'attempt',
  'max',
  'nextAttemptAt',
  'elapsedSeconds',
  'code',
  'aadsts',
  'graphErrorCode',
  'host',
  'kind',
  'name',
  'objectId',
  'appId',
  'tenantId',
  'thumbprint8',
  'skewSeconds',
  'count',
]);

/** The most a `setup_step.detail` serialises to (plan 9.4; the database enforces the same number). */
export const SETUP_STEP_DETAIL_MAX_BYTES = 4_096;

/** The kinds of `setup_object` rows (plan 9.5): what the wizard created or adopted. */
export const SETUP_OBJECT_KINDS = Object.freeze([
  'application',
  'service_principal',
  'app_role_assignment',
  'directory_role_assignment',
] as const);
export type SetupObjectKind = (typeof SETUP_OBJECT_KINDS)[number];

/** The detail keys whose value must be a GUID. */
export const SETUP_STEP_DETAIL_GUID_KEYS: readonly string[] = Object.freeze([
  'objectId',
  'appId',
  'tenantId',
]);

/**
 * Rollback hints (plan 9.13): catalogue keys with named parameters. No automatic rollback exists.
 * `setup.hint.bootstrap_consent` is shown on the finish page.
 */
export const ROLLBACK_HINT_KEYS = Object.freeze([
  'setup.hint.application',
  'setup.hint.service_principal',
  'setup.hint.certificate',
  'setup.hint.grants',
  'setup.hint.exchange_role',
  'setup.hint.bootstrap_consent',
] as const);
export type RollbackHintKey = (typeof ROLLBACK_HINT_KEYS)[number];

/** Catalogue key of a step title. */
export function stepMessageKey(stepKey: StepKey): string {
  return `setup.step.${stepKey}`;
}

/** Catalogue key of a sub-action title. */
export function subActionMessageKey(subAction: string): string {
  return `setup.sub.${subAction}`;
}

/**
 * Hosts a device-code verification link may point at (FR-B-214, U43): the link is rendered only
 * for these, with `rel="noopener noreferrer"`; otherwise the UI shows the code and the
 * instruction without a link.
 */
export const VERIFICATION_URI_HOSTS: readonly string[] = Object.freeze([
  'microsoft.com',
  'www.microsoft.com',
  'login.microsoft.com',
  'login.microsoftonline.com',
]);

const VERIFICATION_URI_MAX_CHARS = 2048;

/**
 * True only for an `https` URI, plain printable ASCII, without credentials, with the default port
 * and a host that is exactly one of `VERIFICATION_URI_HOSTS`. `javascript:`, `http:`, userinfo,
 * other ports, trailing-dot hosts and look-alikes such as `login.microsoft.com.evil.test` are
 * refused. Any value that is not a string is refused.
 */
export function isAllowedVerificationUri(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > VERIFICATION_URI_MAX_CHARS) return false;
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes('\\')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    VERIFICATION_URI_HOSTS.includes(url.hostname)
  );
}
