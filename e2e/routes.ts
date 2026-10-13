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

// ---- Phase C (T-C-063, T-C-064): the states of the users and groups pages ---------------------------------------
// What axe, the keyboard specs and the visual specs walk over on `/users`, `/users/$id`, `/groups` and
// `/groups/$id`, as data. A state names the person who looks (`actor`, see `fixtures/directory.ts`), the page
// and, for a detail page, the seeded row it is about (`seeded`: a key of `seedDirectory`'s `ids`, or one of the
// rows the fake tenant picks for the scoped actor). The ids differ from run to run in a way the spec resolves
// at run time; this list is only data. `/users/$id` and `/groups/$id` are known to the route-tree comparison
// by name (`apps/web/test/routes-coverage.test.ts`), so they need no entry in `CLIENT_ROUTES`.

export type DirectoryActorKey = 'full' | 'scoped' | 'basic';

export interface DirectoryState {
  /** The name of the state in test titles and of the visual baseline (`<slug>-<project>`). */
  readonly slug: string;
  readonly actor: DirectoryActorKey;
  /** The page of a list or an empty state, with its query. */
  readonly path?: string;
  /** The page of one object: `/users/$id` or `/groups/$id`. */
  readonly route?: '/users/$id' | '/groups/$id';
  /** The seeded row the detail page is about. */
  readonly seeded?: string;
  /** The server stand-in for a failing list or detail page (a browser-level answer, no server state). */
  readonly mock?: 'users-unavailable';
  /** U66: the manager call works for the panel's application in this state (default: refused). */
  readonly managerForApps?: 'allowed';
  /** The state has a baseline in `visual.spec.ts` (FR-C-507). */
  readonly visual?: boolean;
}

export const DIRECTORY_STATES: readonly DirectoryState[] = [
  { slug: 'users-loaded', actor: 'full', path: '/users', visual: true },
  { slug: 'users-empty', actor: 'full', path: '/users?q=qqzzxxyy', visual: true },
  { slug: 'users-filtered', actor: 'full', path: '/users?enabled=false&type=guest' },
  { slug: 'users-descending', actor: 'full', path: '/users?order=desc' },
  { slug: 'users-basic', actor: 'basic', path: '/users' },
  { slug: 'users-error', actor: 'full', path: '/users', mock: 'users-unavailable' },
  {
    slug: 'user-detail',
    actor: 'full',
    route: '/users/$id',
    seeded: 'userWithManager',
    managerForApps: 'allowed',
    visual: true,
  },
  {
    slug: 'user-detail-manager-unavailable',
    actor: 'full',
    route: '/users/$id',
    seeded: 'quoteUser',
  },
  {
    slug: 'user-detail-no-manager',
    actor: 'full',
    route: '/users/$id',
    seeded: 'noManagerUser',
    managerForApps: 'allowed',
  },
  { slug: 'user-detail-guest', actor: 'full', route: '/users/$id', seeded: 'guest' },
  { slug: 'user-detail-basic', actor: 'basic', route: '/users/$id', seeded: 'quoteUser' },
  {
    slug: 'user-detail-restricted-manager',
    actor: 'scoped',
    route: '/users/$id',
    seeded: 'financeUserWithOutsideManager',
    managerForApps: 'allowed',
  },
  {
    slug: 'user-detail-outside-scope',
    actor: 'scoped',
    route: '/users/$id',
    seeded: 'outsideUser',
  },
  { slug: 'user-detail-unknown', actor: 'full', route: '/users/$id', seeded: 'unknownId' },
  { slug: 'groups-loaded', actor: 'full', path: '/groups', visual: true },
  { slug: 'groups-empty', actor: 'full', path: '/groups?q=qqzzxxyy' },
  { slug: 'groups-distribution', actor: 'full', path: '/groups?kind=distribution' },
  { slug: 'group-detail', actor: 'full', route: '/groups/$id', seeded: 'm365Group' },
  {
    slug: 'group-detail-hidden',
    actor: 'full',
    route: '/groups/$id',
    seeded: 'hiddenGroup',
    visual: true,
  },
  {
    slug: 'group-detail-distribution',
    actor: 'full',
    route: '/groups/$id',
    seeded: 'distributionGroup',
  },
  { slug: 'group-detail-dynamic', actor: 'full', route: '/groups/$id', seeded: 'dynamicGroup' },
  { slug: 'group-detail-mixed', actor: 'full', route: '/groups/$id', seeded: 'mixedGroup' },
  { slug: 'group-detail-restricted', actor: 'scoped', route: '/groups/$id', seeded: 'bigGroup' },
  { slug: 'group-detail-basic', actor: 'basic', route: '/groups/$id', seeded: 'bigGroup' },
  { slug: 'group-detail-unknown', actor: 'full', route: '/groups/$id', seeded: 'unknownId' },
];
