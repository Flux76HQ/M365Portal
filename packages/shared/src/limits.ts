// Every limit of the application, once (contract C3, spec section 6.5, FR-A-025, FR-A-045).
//
// This file is the single source for the server (body limits, Node server options, rate limiter,
// image pipeline, retention, shutdown), for the tests, and for `docs/operations.md`, which
// `server/limits-doc.test.ts` compares with these constants (FR-A-182). A number that appears in the
// spec's limits table must not be typed anywhere else in the code.
//
// The repository ships no reverse proxy, CDN or ingress, so it has no limits of its own outside the
// app. Whatever the operator puts in front of the app must allow a request body of at least
// `LIMITS.body.importRequestBytes` (9,437,184 bytes, the branding import, the largest request).
//
// Conventions: every value is a safe integer and its unit is in its name (`Bytes`, `Ms`, `Seconds`,
// `Px`, `Megabytes`). A rate that is a fraction per second (0.5 and 0.1) is therefore stored as the
// time to refill one token; `refillPerSecond` gives the per-second figure the spec states.

/**
 * The port the process listens on inside the container (FR-A-016). The literal `9300` is defined
 * here once for source files; the `Dockerfile`, `.env.example` and `docker-compose.yml` each define
 * it once for their own kind.
 */
export const DEFAULT_PORT = 9300;

/**
 * The one Trusted Types policy of the web app (plan 8.2, FR-A-042). The server lists it in the
 * `trusted-types` directive of the shell's Content-Security-Policy; the web module that registers
 * the service worker creates the policy under this name and no other module creates one.
 */
export const TRUSTED_TYPES_POLICY_NAME = 'm365portal-sw';

/** Freeze an object and everything below it, so a limit cannot be changed by one consumer. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const LIMITS = deepFreeze({
  /** Request body sizes, enforced by the app while the body streams (413 `payload_too_large`). */
  body: {
    /** JSON request body, all JSON routes except import: 256 KiB. */
    jsonBytes: 262_144,
    /** One logo file: 2 MiB. */
    logoFileBytes: 2_097_152,
    /** Logo upload request body: the logo plus a 64 KiB multipart envelope. */
    uploadRequestBytes: 2_162_688,
    /**
     * Branding import request body: the largest request the app accepts, 9 MiB. Derivation (A-36):
     * three images of 2,097,152 bytes are 2,796,204 base64 characters each, 8,388,612 in total;
     * plus 65,536 bytes of JSON that is 8,454,148, rounded up to 9 MiB. Whatever sits in front of
     * the app must allow at least this many bytes.
     */
    importRequestBytes: 9_437_184,
    /**
     * The small auth bodies (`unlock`, `logout`, `logout-all`, `break-glass`): 4,096 bytes
     * (`AUTH_BODY_MAX_BYTES`, FR-B-703). Phase B adds no request larger than the import above.
     */
    authBytes: 4_096,
  },

  /** The image pipeline (upload and import). */
  image: {
    /** Input pixels per image: 4096 by 4096 (sharp `limitInputPixels`, decompression bombs). */
    inputPixels: 16_777_216,
    /** SVG element count after parsing (`svg_too_complex`). */
    svgElements: 10_000,
    /** SVG nesting depth (`svg_too_complex`). */
    svgDepth: 64,
    /**
     * SVG expanded element instances: `use`, gradient, clip-path and mask references counted
     * transitively (`svg_too_complex`).
     */
    svgExpandedInstances: 100_000,
    /** Stored size of the logo master: 512 by 512. */
    logoMasterPx: 512,
    /** Stored size of the compact master: 128 by 128. */
    compactMasterPx: 128,
    /** Image jobs that run at the same time. */
    concurrentJobs: 2,
    /** Image jobs that wait; one more is refused with 429 `image_processing_busy`. */
    queuedJobs: 4,
    /** Time budget of one image job; the child process is killed with SIGKILL (422 `image_processing_timeout`). */
    jobTimeBudgetMs: 10_000,
  },

  /** Staged assets: uploaded but not referenced by the applied branding. */
  staging: {
    /** At most this many unreferenced files (409 `staging_quota_exceeded`). */
    quotaFiles: 32,
    /** At most this many bytes of unreferenced files: 32 MiB. */
    quotaBytes: 33_554_432,
    /** An unreferenced asset is deleted after 24 hours. */
    retentionMs: 86_400_000,
  },

  /** Node server options, set explicitly (FR-A-025). Any proxy in front may be stricter. */
  http: {
    /** `maxHeaderSize`. The app sets no cookies in Phase A. */
    headerBytes: 16_384,
    /** `headersTimeout`: 15 s. */
    headersTimeoutMs: 15_000,
    /** `requestTimeout`: 60 s. */
    requestTimeoutMs: 60_000,
    /** `keepAliveTimeout`: 65 s, so that it exceeds the 60 s idle timeout of a proxy in front. */
    keepAliveTimeoutMs: 65_000,
  },

  /**
   * Token buckets per client address (FR-A-045). `refillIntervalMs` is the time to earn one token:
   * 500 ms is 2 per second, 2000 ms is 0.5 per second, 10,000 ms is 0.1 per second.
   */
  rateLimit: {
    /** All GET and HEAD routes: capacity 120, refill 2 per second. */
    read: { capacity: 120, refillIntervalMs: 500 },
    /** All other methods under `/api/v1`: capacity 10, refill 0.5 per second. */
    write: { capacity: 10, refillIntervalMs: 2_000 },
    /** Asset upload and branding import: capacity 3, refill 0.1 per second. */
    upload: { capacity: 3, refillIntervalMs: 10_000 },
    /** Sign-in routes under `/auth` and `/api/v1/auth` (`RATE_AUTH`): capacity 10, refill 0.2 per second (SB-28). */
    auth: { capacity: 10, refillIntervalMs: 5_000 },
    /** Setup routes (`RATE_SETUP`): capacity 10, refill 0.2 per second (SB-28). */
    setup: { capacity: 10, refillIntervalMs: 5_000 },
    /** CSV exports (Phase D, ODD-07): 6 a minute, capacity 6, refill 0.1 per second. */
    export: { capacity: 6, refillIntervalMs: 10_000 },
  },

  // ------------------------------------------------------------------------------------------
  // Phase B (spec 6.9.2). The name of the spec's constant is in the comment of each entry; the
  // unit is in the key. A setting that is also an environment variable (6.9.1) has the three
  // numbers `default`, `min` and `max`, which configuration reads from here and nowhere else.
  // ------------------------------------------------------------------------------------------

  /** The setup wizard (FR-B-201 to FR-B-223). */
  setup: {
    /** `SETUP_UNLOCK_FAILS_PER_CLIENT`: failures per client address ... */
    unlockFailsPerClient: 5,
    /** ... within this window; the address is then locked for `lockMinutes` (FR-B-204). */
    unlockFailsPerClientWindowMinutes: 15,
    /** `SETUP_UNLOCK_FAILS_GLOBAL`: failures from everyone ... */
    unlockFailsGlobal: 30,
    /** ... within this window lock unlocking for everyone for `lockMinutes`. */
    unlockFailsGlobalWindowMinutes: 60,
    /** `SETUP_LOCK_MINUTES`; `Retry-After` is the remaining seconds. */
    lockMinutes: 15,
    /** `SETUP_SESSION_IDLE_MINUTES`: in memory, a restart ends the session (FR-B-205). */
    sessionIdleMinutes: 60,
    /** `SETUP_SESSION_ABSOLUTE_HOURS`. */
    sessionAbsoluteHours: 8,
    /** `SETUP_SESSIONS_MAX`: live setup sessions, the oldest is evicted. */
    sessionsMax: 5,
    /** `SETUP_MIN_WAIT_MS`: floor of every computed wait (FR-B-212, SB-06). */
    minWaitMs: 500,
    /** `SETUP_TOKEN_BYTES`: generated token, base64url, mode 0600. */
    tokenBytes: 32,
    /** `SETUP_LEASE_HEARTBEAT_SECONDS`: runner lease (FR-B-209). */
    leaseHeartbeatSeconds: 15,
    /** `SETUP_LEASE_EXPIRY_SECONDS`. */
    leaseExpirySeconds: 120,
    /** `SETUP_LOG_RETAINED`: rows kept in the setup log (FR-B-211). */
    logRetained: 1_000,
    /** `SETUP_LOG_PAGE_MAX`: rows per page of the log. */
    logPageMax: 200,
    /** `SETUP_DETAIL_STRING_MAX_BYTES`: step detail strings (FR-B-210). */
    detailStringMaxBytes: 256,
    /** `SETUP_VERIFY_RESULT_MAX_BYTES`: the stored proof list (FR-B-309). */
    verifyResultMaxBytes: 51_200,
    /** `SETUP_TRANSIENT_BACKOFF`: doubling from 1 s to 30 s, full jitter, at most 6 tries (FR-B-212). */
    transientBackoff: { initialMs: 1_000, maxMs: 30_000, maxTries: 6 },
    /** `SETUP_REPLICATION_BACKOFF`: doubling from 2 s to 60 s, full jitter. */
    replicationBackoff: { initialMs: 2_000, maxMs: 60_000 },
    /** `SETUP_OBJECT_CHAIN_WINDOW_SECONDS`: the replication window for object chains. */
    objectChainWindowSeconds: 300,
    /** `SETUP_PROPAGATION_TIMEOUT_SECONDS` (setting): role-to-token propagation window. */
    propagationTimeoutSeconds: { default: 900, min: 60, max: 3_600 },
    /** `SETUP_SKEW_WARN_SECONDS` (our threshold, U35). */
    skewWarnSeconds: 60,
    /** `SETUP_SKEW_FAIL_SECONDS`. */
    skewFailSeconds: 300,
    /** `SETUP_MUTATING_CALLS_CLEAN_RUN`: informative; the fault-injection test derives its points from the fake tenant. */
    mutatingCallsCleanRun: 11,
  },

  /** The application certificate (FR-B-106, FR-B-111). */
  certificate: {
    /** `CERT_RSA_BITS`. */
    rsaBits: 2_048,
    /** `CERT_VALIDITY_DAYS`: Learn allows at most one year from the start date. */
    validityDays: 360,
    /** `CERT_BACKDATE_MINUTES`: `notBefore` is this far in the past. */
    backdateMinutes: 5,
    /** `CERT_WARN_DAYS`: warning banner level. */
    warnDays: 60,
    /** `CERT_CRITICAL_DAYS`: critical banner level. */
    criticalDays: 14,
  },

  /** Secrets at rest (FR-B-104, FR-B-105). */
  secrets: {
    /** `APP_KEY_BYTES`. */
    appKeyBytes: 32,
    /** `SECRET_NONCE_BYTES`: XChaCha20-Poly1305. */
    nonceBytes: 24,
    /** `KEY_ID_BYTES`. */
    keyIdBytes: 8,
    /** `APP_KEY_FILE_MAX_BYTES`. */
    appKeyFileMaxBytes: 1_024,
  },

  /** The Microsoft clients (FR-B-311 to FR-B-316, FR-B-403, FR-B-404). */
  microsoft: {
    /** `CLIENT_ASSERTION_LIFETIME_SECONDS`: Learn allows at most 10 minutes after `nbf`. */
    clientAssertionLifetimeSeconds: 300,
    /** `TOKEN_ENDPOINT_TIMEOUT_SECONDS`. */
    tokenEndpointTimeoutSeconds: 10,
    /** `ID_TOKEN_MAX_BYTES`. */
    idTokenMaxBytes: 8_192,
    /** `CLOCK_TOLERANCE_SECONDS`: `exp`, `nbf`, `iat` (U33). */
    clockToleranceSeconds: 60,
    /** `JWKS_CACHE_HOURS`. */
    jwksCacheHours: 24,
    /** `JWKS_REFRESH_MINUTES`. */
    jwksRefreshMinutes: 60,
    /** `JWKS_UNKNOWN_KID_COOLDOWN_MINUTES`. */
    jwksUnknownKidCooldownMinutes: 5,
    /** `GRAPH_CHECK_MEMBER_GROUPS_MAX_IDS`: Learn allows up to 20 groups per request. */
    graphCheckMemberGroupsMaxIds: 20,
    /** `GRAPH_RETRY_MAX`. */
    graphRetryMax: 4,
    /** `GRAPH_RETRY_AFTER_MAX_WAIT_SECONDS`: a longer wait fails fast as `graph_throttled`. */
    graphRetryAfterMaxWaitSeconds: 60,
    /** `GRAPH_5XX_BACKOFF`: idempotent calls only, full jitter. */
    graph5xxBackoff: { initialMs: 500, maxMs: 10_000, maxRetries: 4 },
    /** `GRAPH_BUDGET_INTERACTIVE_SECONDS`: per call including retries. */
    graphBudgetInteractiveSeconds: 20,
    /** `GRAPH_BUDGET_WIZARD_SECONDS`. */
    graphBudgetWizardSeconds: 60,
    /** `GRAPH_IN_FLIGHT_MAX`. */
    graphInFlightMax: 4,
    /** `GRAPH_CACHE_TTL_SECONDS` (FR-B-313). */
    graphCacheTtlSeconds: { organization: 300, user: 60, group: 60 },
    /** `GRAPH_CACHE_ENTRIES`. */
    graphCacheEntries: 1_000,
    /** `EXCHANGE_RESULT_SIZE_MAX` (FR-B-314). */
    exchangeResultSizeMax: 1_000,
    /** `EXCHANGE_PAGING_WINDOW_SECONDS`: a `nextLink` is valid for 5 to 10 minutes. */
    exchangePagingWindowSeconds: 300,
  },

  /** Sign-in transactions (FR-B-402). The rate classes `auth` and `setup` are in `rateLimit`. */
  signIn: {
    /** `LOGIN_TX_MAX`: the oldest is evicted. */
    loginTxMax: 1_000,
    /** `LOGIN_TX_PER_CLIENT_MAX`. */
    loginTxPerClientMax: 20,
    /** `LOGIN_TX_LIFETIME_SECONDS`. */
    loginTxLifetimeSeconds: 600,
    /** `RETURN_TO_MAX_CHARS`. */
    returnToMaxChars: 256,
  },

  /** Sessions (FR-B-407, FR-B-411, FR-B-416). */
  session: {
    /** `SESSION_IDLE_TIMEOUT_MINUTES` (setting). */
    idleTimeoutMinutes: { default: 30, min: 5, max: 480 },
    /** `SESSION_ABSOLUTE_TIMEOUT_HOURS` (setting); hours x 60 must exceed the idle minutes. */
    absoluteTimeoutHours: { default: 8, min: 1, max: 24 },
    /** `SESSION_WRITE_INTERVAL_SECONDS`. */
    writeIntervalSeconds: 60,
    /** `SESSIONS_PER_PRINCIPAL_MAX`. */
    perPrincipalMax: 10,
    /** `SESSION_PURGE_MINUTES`. */
    purgeMinutes: 60,
    /** `SESSION_IDLE_WARNING_SECONDS`. */
    idleWarningSeconds: 120,
    /** `SESSION_ABSOLUTE_WARNING_MINUTES`. */
    absoluteWarningMinutes: 5,
    /** `STEP_UP_WINDOW_MINUTES`. */
    stepUpWindowMinutes: 10,
    /** `STEP_UP_AUTH_TIME_LEEWAY_SECONDS`. */
    stepUpAuthTimeLeewaySeconds: 60,
    /** `REVALIDATE_RETRY_SECONDS`: after a Graph failure (FR-B-409). */
    revalidateRetrySeconds: 30,
  },

  /** Break-glass (FR-B-110, FR-B-521, FR-B-522). */
  breakGlass: {
    /** `BREAK_GLASS_SESSION_MINUTES`: not sliding. */
    sessionMinutes: 30,
    /** `BREAK_GLASS_FAILS_PER_CLIENT` ... */
    failsPerClient: 5,
    /** ... within this window (429 `break_glass_locked`). */
    failsPerClientWindowMinutes: 15,
    /** `BREAK_GLASS_FAILS_GLOBAL` ... */
    failsGlobal: 20,
    /** ... within this window. */
    failsGlobalWindowMinutes: 60,
    /** The scrypt parameter floors and ceilings; `128 * N * r` is at most `maxMemoryBytes` (SB-04). */
    scrypt: {
      /** `SCRYPT_N_MIN`. */
      nMin: 16_384,
      /** `SCRYPT_N_MAX`; the CLI writes N = 131,072, r = 8, p = 1. */
      nMax: 131_072,
      /** `SCRYPT_MAX_MEMORY_BYTES`. */
      maxMemoryBytes: 134_217_728,
      /** `SCRYPT_SALT_BYTES`, lower bound. */
      saltMinBytes: 16,
      /** `SCRYPT_SALT_BYTES`, upper bound. */
      saltMaxBytes: 64,
      /** `SCRYPT_HASH_BYTES`, lower bound. */
      hashMinBytes: 32,
      /** `SCRYPT_HASH_BYTES`, upper bound. */
      hashMaxBytes: 64,
    },
    /** `BREAK_GLASS_QUEUE_RUNNING`: one verification at a time. */
    queueRunning: 1,
    /** `BREAK_GLASS_QUEUE_WAITING`. */
    queueWaiting: 2,
    /** `BREAK_GLASS_PASSWORD_MIN_CHARS`: the `hash-password` floor. */
    passwordMinChars: 14,
  },

  /** RBAC (FR-B-409, FR-B-507, FR-B-508, FR-B-513). */
  rbac: {
    /** `GROUP_CACHE_TTL_SECONDS` (setting). */
    groupCacheTtlSeconds: { default: 300, min: 30, max: 3_600 },
    /** `GROUPS_BOUND_MAX`: distinct bound Entra groups. */
    groupsBoundMax: 200,
    /** `ASSIGNMENTS_MAX`. */
    assignmentsMax: 5_000,
    /** `ROLES_MAX`: includes the five built-in roles. */
    rolesMax: 100,
    /** `SCOPE_ITEMS_PER_ASSIGNMENT_MAX`. */
    scopeItemsPerAssignmentMax: 50,
    /** `SCOPE_VALUE_MAX_CHARS`. */
    scopeValueMaxChars: 64,
    /** `ASSIGNMENT_EXPIRY_MAX_DAYS`. */
    assignmentExpiryMaxDays: 730,
  },

  /**
   * Users and groups, read only (Phase C spec 6.7.2, FR-C-103, FR-C-203, EC-C1). No request body is
   * added, so the largest accepted request is unchanged.
   */
  directory: {
    /** `q`, the prefix search text: 1 to this many characters (EC-C1). */
    searchMaxChars: 64,
    /** Rows a list answers when `limit` is absent (the Phase B list convention, CD-10). */
    pageLimitDefault: 100,
    /** The ceiling of `limit` (CD-10); the UI asks for 50. */
    pageLimitMax: 200,
    /** `$top` for scope scans: the most Graph returns a page (R-C-01). */
    graphPageSize: 999,
    /** Graph pages read for one request of a scoped list (FR-C-203). */
    scanPagesMax: 5,
    /** How long a list cursor stays valid (FR-C-103). */
    cursorTtlSeconds: 600,
    /** Cursors kept at most; the least recently used goes first (FR-C-103). */
    cursorEntries: 1_000,
  },

  // ------------------------------------------------------------------------------------------
  // Phase D, step D1 (spec 6.11.2, T-D-102). No request body larger than the branding import is
  // added: the largest bulk request is 200 GUIDs, well below `body.jsonBytes`.
  // ------------------------------------------------------------------------------------------

  /** The Exchange client (FR-D-102, FR-D-104, FR-D-105; plan 5.1 and 5.2; the worker numbers date from ADR 0180). */
  exchange: {
    /** The worker is recycled after this many calls (R-D-03: connect and disconnect can leak memory). */
    workerMaxCalls: 500,
    /** ... or after this many seconds of age. */
    workerMaxAgeSeconds: 3_600,
    /** One cmdlet call; the worker is killed at the deadline. Learn's REST timeout is 15 minutes (R-D-02). */
    callDeadlineSeconds: 120,
    /** Rows a list read buffers per cursor (plan 5.2, PD-03); a larger result asks to narrow the search. */
    listBufferMax: 10_000,
    /** One protocol line, in bytes: 1 MiB (the largest answer of one cmdlet call). */
    lineMaxBytes: 1_048_576,
    /** Retries of a throttled or transient failure (FR-D-105); the numbers are ours until U81 is closed. */
    retryMax: 3,
    /** Back-off between those retries, doubling from the first to the second value, full jitter. */
    retryBackoff: { initialMs: 1_000, maxMs: 15_000 },
  },

  /** Distribution list member writes (FR-D-203, FR-D-204). */
  distributionLists: {
    /** Identities in one add or remove request. */
    bulkMax: 200,
    /** Members per chunk: the unit of work between two read-backs. */
    bulkChunk: 50,
    /** A request with more members than this needs a recent step-up. */
    stepUpAbove: 20,
  },

  /** Group member writes through Graph (FR-D-353, FR-D-354). */
  groupMembers: {
    /** Identities in one add or remove request. */
    bulkMax: 200,
    /** Members per chunk; Graph adds at most 20 members in one request (R-D-08). */
    bulkChunk: 20,
    /** A request with more members than this needs a recent step-up. */
    stepUpAbove: 20,
  },

  /** Mail contact fields (FR-D-302; R-D-09: Name 64, DisplayName 256, Alias 64). */
  contacts: {
    /** `-Name` of `New-MailContact`: the unique name, 64 characters. */
    nameMaxChars: 64,
    /** The display name: 1 to 256 characters. */
    displayNameMaxChars: 256,
    /** `-Alias`: 64 characters. */
    aliasMaxChars: 64,
    /** First and last name. */
    personNameMaxChars: 64,
    /** An external address: 254 characters (RFC 5321 path limit). */
    addressMaxChars: 254,
  },

  /** Clients the rate limiter tracks at most (memory bound); idle entries are evicted first. */
  trackedClients: 10_000,

  /** CSRF token lifetime: 8 hours; the client fetches a new token on `csrf_invalid`. */
  csrfTokenLifetimeMs: 28_800_000,

  /** Pre-migration backups of the database that are kept. */
  preMigrationBackupsKept: 3,

  /** Graceful shutdown drain: `docker stop` must allow at least this long. */
  shutdownDrainMs: 10_000,

  /** One audit entry's `detail` text. */
  auditDetailBytes: 4_096,

  /** The organisation name: 64 grapheme clusters and 256 bytes, both. */
  orgName: {
    maxGraphemes: 64,
    maxBytes: 256,
  },

  /** `Strict-Transport-Security` max-age default: one year, in seconds (override: `HSTS_MAX_AGE`). */
  hstsMaxAgeSeconds: 31_536_000,

  /** Image size ceiling of the `image` CI job: 600 MB uncompressed. Owner decision of 2026-10-13 (ODD-10), after CI measured the Ubuntu image at 538.2 MB. */
  imageSizeCeilingMegabytes: 600,
} as const);

/** The names of the rate limit classes: `read`, `write`, `upload`, `auth`, `setup` and `export`. */
export type RateLimitClass = keyof typeof LIMITS.rateLimit;

/** Tokens earned per second by a rate class, the figure spec 6.5 states (2, 0.5 and 0.1). */
export function refillPerSecond(rateClass: RateLimitClass): number {
  return 1000 / LIMITS.rateLimit[rateClass].refillIntervalMs;
}
