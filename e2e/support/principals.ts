// The people of the e2e tenant (CB17, T-B-370). Pure data, no imports: the fake tenant process, the
// global setup and the specs all read it.
//
// Every principal is a user of the fake directory with a fixed object id, so a spec can name one in
// an API call. `role` is what global-setup gives them through the real API (with a step-up):
//
//   owner               the designated Owner: the one who finishes the wizard on instance A
//   administrator ...   the other built-in roles
//   norole              a Global Administrator without a panel role: no session (OV-15); the fake
//                       adds `wids` claims to the ID token, which the product must ignore
//   expired-assignment  signs in with an assignment that expires; global-setup then moves the expiry
//                       into the past directly in the database, because the API refuses a past
//                       expiry. The session stays, the rights are gone (the self-test documents it)
//   group-member        holds a role only through membership of an Entra group
//   leaver, deputy      disposable: given a role like the others but with NO storage state, so that a
//                       spec may sign them in, out and out everywhere, or step them up (which rotates
//                       the session), without touching the session the other specs share
export const PRINCIPAL_NAMES = [
  'owner',
  'administrator',
  'operator',
  'helpdesk',
  'reader',
  'norole',
  'expired-assignment',
  'group-member',
  'leaver',
  'deputy',
] as const;
export type PrincipalName = (typeof PRINCIPAL_NAMES)[number];

/** The principals nobody shares: no storage state is written for them. */
export const DISPOSABLE_NAMES = ['leaver', 'deputy'] as const;
export type DisposableName = (typeof DISPOSABLE_NAMES)[number];

/** The principals that start a test signed in (a storage state each; `norole` has an empty one). */
export type StoredPrincipalName = Exclude<PrincipalName, DisposableName>;
export const STORED_PRINCIPAL_NAMES: readonly StoredPrincipalName[] = PRINCIPAL_NAMES.filter(
  (name): name is StoredPrincipalName => !(DISPOSABLE_NAMES as readonly string[]).includes(name),
);

/** The built-in role keys of the panel. */
export type RoleKey = 'owner' | 'admin' | 'operator' | 'helpdesk' | 'reader';

export interface Principal {
  readonly name: PrincipalName;
  /** Object id in the fake directory (lower case GUID). */
  readonly oid: string;
  readonly upn: string;
  readonly displayName: string;
  /** The role given directly; `null` for none. */
  readonly role: RoleKey | null;
  /** True when the role comes from the group below instead of a direct assignment. */
  readonly viaGroup?: boolean;
  /** True when the fake adds `wids` (Entra role template ids) to the ID token. */
  readonly widsGlobalAdministrator?: boolean;
}

function guid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

export const PRINCIPALS: Readonly<Record<PrincipalName, Principal>> = {
  owner: {
    name: 'owner',
    oid: guid(101),
    upn: 'olivia.owner@contoso-fake.example',
    displayName: 'Olivia Owner',
    role: 'owner',
    widsGlobalAdministrator: true,
  },
  administrator: {
    name: 'administrator',
    oid: guid(102),
    upn: 'adam.administrator@contoso-fake.example',
    displayName: 'Adam Administrator',
    role: 'admin',
  },
  operator: {
    name: 'operator',
    oid: guid(103),
    upn: 'oscar.operator@contoso-fake.example',
    displayName: 'Oscar Operator',
    role: 'operator',
  },
  helpdesk: {
    name: 'helpdesk',
    oid: guid(104),
    upn: 'hanna.helpdesk@contoso-fake.example',
    displayName: 'Hanna Helpdesk',
    role: 'helpdesk',
  },
  reader: {
    name: 'reader',
    oid: guid(105),
    upn: 'rita.reader@contoso-fake.example',
    displayName: 'Rita Reader',
    role: 'reader',
  },
  norole: {
    name: 'norole',
    oid: guid(106),
    upn: 'nick.norole@contoso-fake.example',
    displayName: 'Nick Norole',
    role: null,
    widsGlobalAdministrator: true,
  },
  'expired-assignment': {
    name: 'expired-assignment',
    oid: guid(107),
    upn: 'ellen.expired@contoso-fake.example',
    displayName: 'Ellen Expired',
    role: 'reader',
  },
  leaver: {
    name: 'leaver',
    oid: guid(109),
    upn: 'lena.leaver@contoso-fake.example',
    displayName: 'Lena Leaver',
    role: 'helpdesk',
  },
  deputy: {
    name: 'deputy',
    oid: guid(110),
    upn: 'dirk.deputy@contoso-fake.example',
    displayName: 'Dirk Deputy',
    role: 'owner',
    widsGlobalAdministrator: true,
  },
  'group-member': {
    name: 'group-member',
    oid: guid(108),
    upn: 'gerrit.groupmember@contoso-fake.example',
    displayName: 'Gerrit Groupmember',
    role: 'helpdesk',
    viaGroup: true,
  },
};

/** The Entra group whose members get the `helpdesk` role (the `group-member` principal). */
export const ROLE_GROUP = {
  oid: guid(201),
  displayName: 'Panel helpdesk',
  role: 'helpdesk',
} as const;

/**
 * The second assignment of `operator`: a role limited to the distribution lists whose name starts with
 * "Marketing", ending in 30 days, so that the access page has a scope and an expiry to say in words.
 */
export const SCOPED_ASSIGNMENT = {
  role: 'reader',
  days: 30,
  scope: [
    {
      target: 'distributionList',
      match: { by: 'prefix', attr: 'displayName', value: 'Marketing' },
    },
  ],
} as const;

/** The Entra role template id of Global Administrator (Microsoft Learn: built-in roles). */
export const GLOBAL_ADMINISTRATOR_TEMPLATE_ID = '62e90394-69f5-4237-9190-012177145e10';

/** The principals that can have a session (everyone but `norole`). */
export const SIGNED_IN_PRINCIPALS: readonly PrincipalName[] = PRINCIPAL_NAMES.filter(
  (name) => name !== 'norole',
);
