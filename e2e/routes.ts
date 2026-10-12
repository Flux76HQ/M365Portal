// The client paths of the application, as the end-to-end tests see them (contract C14, FR-A-151).
// One list for axe, visual regression and Lighthouse. `apps/web/test/routes-coverage.test.ts`
// compares it with the router's route tree in both directions, so a page that is added to the app
// without being added here (or the other way round) fails a unit test, not a missed audit.
//
// Pure data and no imports: the web package reads this file from a Vitest test.

/** Every page the router knows, in navigation order. */
export const CLIENT_ROUTES = [
  '/',
  '/users',
  '/groups',
  '/distribution-lists',
  '/contacts',
  '/audit',
  '/settings',
  '/settings/appearance',
  '/settings/connection',
  '/settings/access',
  '/settings/restore-access',
  '/no-access',
  '/signin',
  '/setup',
  '/break-glass',
  '/design',
] as const;

/** A path no route matches: the Not-found page. The route-tree comparison skips it on purpose. */
export const UNKNOWN_ROUTE = '/this-page-does-not-exist';

/** What axe, the visual specs and Lighthouse walk over. */
export const ROUTES: readonly string[] = [...CLIENT_ROUTES, UNKNOWN_ROUTE];

// ---- Phase B states (T-B-378, T-B-379, T-B-380) --------------------------------------------------------
// The states of the new pages that axe, the keyboard specs and the visual specs walk over, as data. The
// wizard states are the `status` values of a step (`StepStatus`): each one is reached on the empty
// instance B by a toggle of the fake tenant (`support/wizard-states.ts` says how).

/** The `?error=` values of `/signin`: every code of spec 6.9.5. */
export const SIGNIN_ERROR_STATES = [
  'signin_failed',
  'cookies_missing_or_expired',
  'access_denied',
  'interaction_required',
  'consent_required',
  'admin_approval_required',
  'assignment_required',
  'conditional_access_blocked',
  'temporarily_unavailable',
  'mfa_required',
  'amr_missing',
  'stepup_failed',
  'secrets_unavailable',
  'setup_required',
  'session_expired',
] as const;

/** The `?reason=` values of `/no-access`. */
export const NO_ACCESS_STATES = ['no_role', 'graph_unavailable'] as const;

/** `/setup` and the wizard, in the order a person meets them. */
export const WIZARD_STATES = [
  'token',
  'token-locked',
  'environment',
  'running',
  'waiting',
  'succeeded',
  'warning',
  'failed',
  'skipped',
  'manual',
  'finish',
] as const;
export type WizardState = (typeof WIZARD_STATES)[number];

/** The pages of the signed-in application that Phase B added, for the owner. */
export const SETTINGS_STATES = [
  '/settings/connection',
  '/settings/access',
  '/settings/restore-access',
] as const;
