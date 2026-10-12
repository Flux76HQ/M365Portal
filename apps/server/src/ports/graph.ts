// The app-only Microsoft Graph client as services see it (plan 8.1, FR-B-311). Phase B has no write
// method here; Phase C adds methods behind the same contract suite. Implementations:
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
}

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
}
