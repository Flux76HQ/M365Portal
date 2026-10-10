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
 * The port the process listens on inside the container (FR-A-016). The literal `8080` is defined
 * here once for source files; the `Dockerfile`, `.env.example` and `docker-compose.yml` each define
 * it once for their own kind.
 */
export const DEFAULT_PORT = 8080;

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

  /** Image size ceiling of the `image` CI job: 400 MB uncompressed, recalibrated after the first build. */
  imageSizeCeilingMegabytes: 400,
} as const);

/** The names of the rate limit classes: `read`, `write` and `upload`. */
export type RateLimitClass = keyof typeof LIMITS.rateLimit;

/** Tokens earned per second by a rate class, the figure spec 6.5 states (2, 0.5 and 0.1). */
export function refillPerSecond(rateClass: RateLimitClass): number {
  return 1000 / LIMITS.rateLimit[rateClass].refillIntervalMs;
}
