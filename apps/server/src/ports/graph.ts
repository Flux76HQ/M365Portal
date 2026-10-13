// The app-only Microsoft Graph client as services see it (plan 8.1, FR-B-311). Phase B has no write
// method here; Phase C adds six read methods behind the same contract suite (and still no write method). Implementations:
// `HttpGraphClient` (integrations/graph) and `FakeGraphClient` (test/fakes).
//
// Every DTO is a Zod-parsed allow-list in the implementation: unknown fields are dropped, strings
// are capped at 256 bytes, and a property a call did not return is `null`, never invented (U36).

/** A lower-case GUID. The implementation validates it before it reaches a path or a body. */
export type Guid = string;

export interface CallOptions {
  /** `x-ms-throttle-priority`: `high` for a user waiting, `low` for background work. */
  priority?: 'high' | 'low';
  /** `interactive` (20 s) or `wizard` (60 s, no retries: the runner owns every wait). */
  budget?: 'interactive' | 'wizard';
  signal?: AbortSignal;
}

export interface OrganizationInfo {
  readonly id: Guid;
  readonly displayName: string | null;
  /** The verified domain with `isInitial` (the `.onmicrosoft.com` one). */
  readonly initialDomain: string | null;
  /** The verified domain with `isDefault`. */
  readonly defaultDomain: string | null;
}

export interface DirectoryUser {
  readonly id: Guid;
  readonly displayName: string | null;
  readonly userPrincipalName: string | null;
  readonly mail: string | null;
  readonly department: string | null;
  readonly accountEnabled: boolean | null;
  // Phase C (FR-C-104). `userType` is Graph's text (`Member`, `Guest`, or anything else); the mapper
  // decides what the wire says. `createdDateTime` is Graph's timestamp as received (no milliseconds).
  readonly givenName: string | null;
  readonly surname: string | null;
  readonly jobTitle: string | null;
  readonly officeLocation: string | null;
  readonly userType: string | null;
  readonly onPremisesSyncEnabled: boolean | null;
  readonly createdDateTime: string | null;
}

export interface DirectoryGroup {
  readonly id: Guid;
  readonly displayName: string | null;
  readonly mail: string | null;
  readonly mailNickname: string | null;
  readonly groupTypes: readonly string[] | null;
  readonly membershipRule: string | null;
  readonly onPremisesSyncEnabled: boolean | null;
  readonly securityEnabled: boolean | null;
  readonly mailEnabled: boolean | null;
  // Phase C (FR-C-104): `visibility` is Graph's text (`Private`, `Public`, `HiddenMembership`).
  readonly visibility: string | null;
  readonly description: string | null;
  readonly createdDateTime: string | null;
}

/**
 * A member, an owner or a manager as Graph returns it (FR-C-104). `kind` comes from `@odata.type`; a
 * property Graph did not return (limited information, R-C-05) is `null`. `department` and
 * `mailNickname` are not on the wire: the scope of the actor is matched on them (FR-C-307).
 */
export interface DirectoryRef {
  readonly id: Guid;
  readonly kind: 'user' | 'group' | 'other';
  readonly displayName: string | null;
  readonly mail: string | null;
  readonly userPrincipalName: string | null;
  readonly department: string | null;
  readonly mailNickname: string | null;
}

declare const pageTokenBrand: unique symbol;

/**
 * Where the next page of a list starts: opaque to everything but the client that made it (for
 * `HttpGraphClient` the validated `@odata.nextLink`). It lives in the cursor store of the server and
 * never reaches a browser (FR-C-103). Only an implementation of `GraphClient` makes one.
 */
export type PageToken = string & { readonly [pageTokenBrand]: true };

/** One page of a list and the token of the next one (`null` at the end). */
export interface DirectoryPage<T> {
  readonly items: readonly T[];
  readonly next: PageToken | null;
}

/** A request for one page: how many rows, and where to start (`null`: the first page). */
export interface PageRequest {
  /** 1 to 999 (R-C-01). */
  readonly top: number;
  readonly after?: PageToken | null;
}

export interface UserListParams extends PageRequest {
  /** The prefix search text (already validated by the route); `undefined`: no search. */
  readonly q?: string;
  /** Search the user principal name as well. Default true; false for an actor who sees only `basic` rows. */
  readonly searchPrincipalName?: boolean;
  readonly enabled: 'all' | 'true' | 'false';
  readonly type: 'all' | 'member' | 'guest';
  readonly order: 'asc' | 'desc';
}

export interface GroupListParams extends PageRequest {
  readonly q?: string;
  readonly kind: 'all' | 'm365' | 'security' | 'mailsecurity' | 'distribution';
  readonly order: 'asc' | 'desc';
}

/** The manager of a user (FR-C-107): best effort, never an error. */
export type ManagerResult =
  | { readonly state: 'present'; readonly manager: DirectoryRef }
  | { readonly state: 'none' }
  | { readonly state: 'unavailable' };

export interface GraphClient {
  getOrganization(): Promise<OrganizationInfo>;
  /** `GET /users?$top=1&$select=id`: proves the application can read users. */
  probeUsers(): Promise<void>;
  /** `null` on 404. */
  getUser(idOrUpn: string, o?: CallOptions): Promise<DirectoryUser | null>;
  /**
   * The subset of `groupIds` the user is a member of (transitively), through
   * `POST /users/{id}/checkMemberGroups`.
   */
  checkMemberGroups(
    userId: Guid,
    groupIds: readonly Guid[],
    o?: CallOptions,
  ): Promise<ReadonlySet<Guid>>;
  searchGroups(prefix: string, top: number): Promise<DirectoryGroup[]>;
  /** `null` on 404. */
  getGroup(id: Guid): Promise<DirectoryGroup | null>;

  // ---- Phase C: the read methods of the users and groups pages (FR-C-101). No write method. ----

  /** `GET /users` with the advanced query pair; one page. */
  listUsers(params: UserListParams, o?: CallOptions): Promise<DirectoryPage<DirectoryUser>>;
  /** `GET /users/{id}/manager`: 404 is `none`, a refusal or an unexpected answer is `unavailable`. */
  getUserManager(userId: Guid, o?: CallOptions): Promise<ManagerResult>;
  /** `GET /users/{id}/transitiveMemberOf/microsoft.graph.group`; one page. */
  listUserGroups(
    userId: Guid,
    page: PageRequest,
    o?: CallOptions,
  ): Promise<DirectoryPage<DirectoryGroup>>;
  /** `GET /groups` with the advanced query pair; one page. */
  listGroups(params: GroupListParams, o?: CallOptions): Promise<DirectoryPage<DirectoryGroup>>;
  /** `GET /groups/{id}/members`; one page of direct members. */
  listGroupMembers(
    groupId: Guid,
    page: PageRequest,
    o?: CallOptions,
  ): Promise<DirectoryPage<DirectoryRef>>;
  /** `GET /groups/{id}/owners`; one page. */
  listGroupOwners(
    groupId: Guid,
    page: PageRequest,
    o?: CallOptions,
  ): Promise<DirectoryPage<DirectoryRef>>;
}
