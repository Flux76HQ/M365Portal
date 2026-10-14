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
  '/settings/roles',
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
  '/settings/roles',
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

// ---- Phase D, step D1 (T-D-181): distribution lists, contacts and group members ------------------------------------
// The states that axe, the keyboard specs, the responsive specs and the visual specs walk over on
// `/distribution-lists`, `/distribution-lists/$id`, `/contacts`, `/contacts/$id` and `/groups/$id` (member editing),
// as data. The fake Exchange (InvokeCommand on the fake tenant) is seeded per state (`support/exchange-seed.ts`); a path names
// its object by NAME so the ids (which the seed makes, not the spec) are resolved when the state is visited
// (`fixtures/member-states.ts`): `{list:Marketing}`, `{contact:Carol Bakker}`, `{group:m365Group}` (a key of the
// seeded Graph directory). `/distribution-lists/$id` and `/contacts/$id` are known to the route-tree comparison by
// name (`apps/web/test/routes-coverage.test.ts`), so they need no entry in `CLIENT_ROUTES`.

/** What the fake Exchange holds in a state: the standard seed, nothing at all, or 10,001 lists (`narrow_search`). */
export type ExchangeData = 'standard' | 'empty' | 'narrow';

/**
 * What the person does on the page before the picture is taken or the page is scanned:
 *   picker          opens the add dialog and searches
 *   picked          the same, with every result selected
 *   result          the same, and confirms: the result of the change is on the page
 *   remove-confirm  selects the first member and opens the confirmation to remove
 *   form-errors     opens "New contact" and submits it empty
 *   form-edit       opens "Edit contact"
 *   delete-confirm  opens "Delete contact"
 */
export type MemberStep =
  | 'picker'
  | 'picked'
  | 'result'
  | 'remove-confirm'
  | 'form-errors'
  | 'form-edit'
  | 'delete-confirm';

export interface MemberState {
  /** The name of the state in test titles and of the visual baseline (`<slug>-<project>`). */
  readonly slug: string;
  readonly data?: ExchangeData;
  /** The address, with `{list:Name}`, `{contact:Name}` or `{group:key}` for an object. */
  readonly path: string;
  readonly step?: MemberStep;
  /** The contact is first put into two lists, so that its page and its delete dialog have lists to show. */
  readonly contactInLists?: boolean;
  /** The answers (4xx, 5xx) that are the point of the state. */
  readonly expect?: readonly { readonly status: number; readonly url: string }[];
  /** The state has a baseline in `visual.spec.ts` (FR-D-902). */
  readonly visual?: boolean;
}

export const MEMBER_STATES: readonly MemberState[] = [
  // Distribution lists.
  { slug: 'lists-loaded', path: '/distribution-lists', visual: true },
  { slug: 'lists-empty', data: 'empty', path: '/distribution-lists', visual: true },
  { slug: 'lists-no-match', path: '/distribution-lists?q=qqzzxxyy' },
  {
    slug: 'lists-narrow-search',
    data: 'narrow',
    path: '/distribution-lists',
    expect: [{ status: 422, url: '/api/v1/distribution-lists' }],
  },
  { slug: 'lists-synced-filter', path: '/distribution-lists?kind=synced' },
  { slug: 'list-detail', path: '/distribution-lists/{list:Marketing}', visual: true },
  { slug: 'list-detail-empty', path: '/distribution-lists/{list:Archive}' },
  {
    slug: 'list-detail-synced',
    path: '/distribution-lists/{list:Legacy synced}',
    visual: true,
  },
  { slug: 'list-detail-dynamic', path: '/distribution-lists/{list:Everyone dynamic}' },
  {
    slug: 'list-detail-unknown',
    path: '/distribution-lists/00000000-0000-4000-8000-0000000fffff',
    expect: [{ status: 404, url: '/api/v1/distribution-lists/' }],
  },
  {
    slug: 'list-add-picker',
    path: '/distribution-lists/{list:Marketing}',
    step: 'picker',
    visual: true,
  },
  { slug: 'list-add-picked', path: '/distribution-lists/{list:Marketing}', step: 'picked' },
  {
    slug: 'list-add-result',
    path: '/distribution-lists/{list:Marketing}',
    step: 'result',
    visual: true,
  },
  {
    slug: 'list-remove-confirm',
    path: '/distribution-lists/{list:Marketing}',
    step: 'remove-confirm',
    visual: true,
  },
  // Contacts.
  { slug: 'contacts-loaded', path: '/contacts', visual: true },
  { slug: 'contacts-empty', data: 'empty', path: '/contacts' },
  { slug: 'contacts-no-match', path: '/contacts?q=qqzzxxyy' },
  {
    slug: 'contact-detail',
    path: '/contacts/{contact:Carol Bakker}',
    contactInLists: true,
    visual: true,
  },
  { slug: 'contact-detail-no-lists', path: '/contacts/{contact:Dan Visser}' },
  { slug: 'contact-detail-synced', path: '/contacts/{contact:Sam Synced}' },
  {
    slug: 'contact-detail-unknown',
    path: '/contacts/00000000-0000-4000-8000-0000000fffff',
    expect: [{ status: 404, url: '/api/v1/contacts/' }],
  },
  { slug: 'contact-form-errors', path: '/contacts', step: 'form-errors', visual: true },
  { slug: 'contact-form-edit', path: '/contacts/{contact:Dan Visser}', step: 'form-edit' },
  {
    slug: 'contact-delete-confirm',
    path: '/contacts/{contact:Carol Bakker}',
    contactInLists: true,
    step: 'delete-confirm',
    visual: true,
  },
  // Members of groups (the seeded Graph directory of Phase C).
  { slug: 'group-members-editor', path: '/groups/{group:m365Group}', visual: true },
  { slug: 'group-add-picker', path: '/groups/{group:m365Group}', step: 'picker' },
  { slug: 'group-add-result', path: '/groups/{group:m365Group}', step: 'result' },
  { slug: 'group-remove-confirm', path: '/groups/{group:m365Group}', step: 'remove-confirm' },
  { slug: 'group-members-readonly', path: '/groups/{group:dynamicGroup}', visual: true },
  { slug: 'group-members-readonly-synced', path: '/groups/{group:syncedGroup}' },
  { slug: 'group-members-readonly-exchange', path: '/groups/{group:distributionGroup}' },
];
