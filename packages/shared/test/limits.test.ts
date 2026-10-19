// T-A-021, contract C3, FR-A-025, FR-A-045, FR-A-182 (source): every number of the limits table of
// spec section 6.5 exists once, in `src/limits.ts`. The server, the tests and `docs/operations.md`
// (compared by `server/limits-doc.test.ts`) all read these constants.
//
// The expected values below are written out again, in the units of the spec (bytes, seconds, hours),
// and compared with the constants by a guard that throws on any difference. The guard is proven
// with negative fixtures (tasks.md section 0.3): a wrong value, a missing value and an extra value.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectGuardFails } from '../src/testing/index.js';
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '../src/schemas/common.js';
import {
  DEFAULT_PORT,
  LIMITS,
  refillPerSecond,
  TRUSTED_TYPES_POLICY_NAME,
  type RateLimitClass,
} from '../src/limits.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const SECOND = 1000;
const HOUR = 3600 * SECOND;

/** Spec 6.5, row by row, as `dotted.path -> value`. The paths are the shape of `LIMITS`. */
const SPEC_6_5: Readonly<Record<string, number>> = {
  // JSON request body (all JSON routes except import): 262,144 bytes (256 KiB)
  'body.jsonBytes': 262_144,
  // Logo file: 2,097,152 bytes (2 MiB)
  'body.logoFileBytes': 2_097_152,
  // Logo upload request body: 2,162,688 bytes (2 MiB plus 64 KiB envelope)
  'body.uploadRequestBytes': 2_162_688,
  // Branding import request body (the largest request): 9,437,184 bytes (9 MiB)
  'body.importRequestBytes': 9_437_184,
  // Input pixels per image: 16,777,216 (4096 by 4096)
  'image.inputPixels': 16_777_216,
  // SVG elements and depth: 10,000 and 64
  'image.svgElements': 10_000,
  'image.svgDepth': 64,
  // SVG expanded element instances: 100,000
  'image.svgExpandedInstances': 100_000,
  // Master sizes: logo 512 by 512, compact 128 by 128
  'image.logoMasterPx': 512,
  'image.compactMasterPx': 128,
  // Concurrent image jobs and queue: 2 and 4
  'image.concurrentJobs': 2,
  'image.queuedJobs': 4,
  // Image job time budget: 10 seconds
  'image.jobTimeBudgetMs': 10 * SECOND,
  // Staging quota (unreferenced assets): 32 files and 33,554,432 bytes (32 MiB)
  'staging.quotaFiles': 32,
  'staging.quotaBytes': 33_554_432,
  // Staged asset retention: 24 hours
  'staging.retentionMs': 24 * HOUR,
  // Request header size: 16,384 bytes
  'http.headerBytes': 16_384,
  // Headers timeout, request timeout, keep-alive timeout: 15 s, 60 s, 65 s
  'http.headersTimeoutMs': 15 * SECOND,
  'http.requestTimeoutMs': 60 * SECOND,
  'http.keepAliveTimeoutMs': 65 * SECOND,
  // Rate limit read: capacity 120, refill 2 per second (one token every 500 ms)
  'rateLimit.read.capacity': 120,
  'rateLimit.read.refillIntervalMs': 500,
  // Rate limit write: capacity 10, refill 0.5 per second (one token every 2 s)
  'rateLimit.write.capacity': 10,
  'rateLimit.write.refillIntervalMs': 2 * SECOND,
  // Rate limit upload: capacity 3, refill 0.1 per second (one token every 10 s)
  'rateLimit.upload.capacity': 3,
  'rateLimit.upload.refillIntervalMs': 10 * SECOND,
  // Tracked clients: 10,000
  trackedClients: 10_000,
  // CSRF token lifetime: 8 hours
  csrfTokenLifetimeMs: 8 * HOUR,
  // Pre-migration backups kept: 3
  preMigrationBackupsKept: 3,
  // Graceful shutdown drain: 10 seconds
  shutdownDrainMs: 10 * SECOND,
  // Audit entry detail: 4,096 bytes
  auditDetailBytes: 4_096,
  // Organisation name: 64 grapheme clusters, 256 bytes
  'orgName.maxGraphemes': 64,
  'orgName.maxBytes': 256,
  // HSTS max-age default: 31,536,000 seconds
  hstsMaxAgeSeconds: 31_536_000,
  // Image size ceiling: 600 MB uncompressed
  imageSizeCeilingMegabytes: 600,
};

/**
 * Spec 6.9.2 (Phase B), row by row: [spec constant, `LIMITS` path, value]. The spec constant is the
 * name of the row in the spec and in `docs/operations.md`; the path is where it lives in `LIMITS`
 * (camel case, the unit in the name). A row of the spec that states several numbers has one entry
 * per number (a window, a floor and a ceiling).
 */
const SPEC_6_9_2: readonly (readonly [constant: string, path: string, value: number])[] = [
  // Setup
  ['SETUP_UNLOCK_FAILS_PER_CLIENT', 'setup.unlockFailsPerClient', 5],
  ['SETUP_UNLOCK_FAILS_PER_CLIENT (window)', 'setup.unlockFailsPerClientWindowMinutes', 15],
  ['SETUP_UNLOCK_FAILS_GLOBAL', 'setup.unlockFailsGlobal', 30],
  ['SETUP_UNLOCK_FAILS_GLOBAL (window)', 'setup.unlockFailsGlobalWindowMinutes', 60],
  ['SETUP_LOCK_MINUTES', 'setup.lockMinutes', 15],
  ['SETUP_SESSION_IDLE_MINUTES', 'setup.sessionIdleMinutes', 60],
  ['SETUP_SESSION_ABSOLUTE_HOURS', 'setup.sessionAbsoluteHours', 8],
  ['SETUP_SESSIONS_MAX', 'setup.sessionsMax', 5],
  ['SETUP_MIN_WAIT_MS', 'setup.minWaitMs', 500],
  ['SETUP_TOKEN_BYTES', 'setup.tokenBytes', 32],
  ['SETUP_LEASE_HEARTBEAT_SECONDS', 'setup.leaseHeartbeatSeconds', 15],
  ['SETUP_LEASE_EXPIRY_SECONDS', 'setup.leaseExpirySeconds', 120],
  ['SETUP_LOG_RETAINED', 'setup.logRetained', 1_000],
  ['SETUP_LOG_PAGE_MAX', 'setup.logPageMax', 200],
  ['SETUP_DETAIL_STRING_MAX_BYTES', 'setup.detailStringMaxBytes', 256],
  ['SETUP_VERIFY_RESULT_MAX_BYTES', 'setup.verifyResultMaxBytes', 51_200],
  ['SETUP_TRANSIENT_BACKOFF (initial)', 'setup.transientBackoff.initialMs', 1_000],
  ['SETUP_TRANSIENT_BACKOFF (ceiling)', 'setup.transientBackoff.maxMs', 30_000],
  ['SETUP_TRANSIENT_BACKOFF (tries)', 'setup.transientBackoff.maxTries', 6],
  ['SETUP_REPLICATION_BACKOFF (initial)', 'setup.replicationBackoff.initialMs', 2_000],
  ['SETUP_REPLICATION_BACKOFF (ceiling)', 'setup.replicationBackoff.maxMs', 60_000],
  ['SETUP_OBJECT_CHAIN_WINDOW_SECONDS', 'setup.objectChainWindowSeconds', 300],
  ['SETUP_PROPAGATION_TIMEOUT_SECONDS (default)', 'setup.propagationTimeoutSeconds.default', 900],
  ['SETUP_PROPAGATION_TIMEOUT_SECONDS (min)', 'setup.propagationTimeoutSeconds.min', 60],
  ['SETUP_PROPAGATION_TIMEOUT_SECONDS (max)', 'setup.propagationTimeoutSeconds.max', 3_600],
  ['SETUP_SKEW_WARN_SECONDS', 'setup.skewWarnSeconds', 60],
  ['SETUP_SKEW_FAIL_SECONDS', 'setup.skewFailSeconds', 300],
  ['SETUP_MUTATING_CALLS_CLEAN_RUN', 'setup.mutatingCallsCleanRun', 11],
  // Certificate
  ['CERT_RSA_BITS', 'certificate.rsaBits', 2_048],
  ['CERT_VALIDITY_DAYS', 'certificate.validityDays', 360],
  ['CERT_BACKDATE_MINUTES', 'certificate.backdateMinutes', 5],
  ['CERT_WARN_DAYS', 'certificate.warnDays', 60],
  ['CERT_CRITICAL_DAYS', 'certificate.criticalDays', 14],
  // Secrets
  ['APP_KEY_BYTES', 'secrets.appKeyBytes', 32],
  ['SECRET_NONCE_BYTES', 'secrets.nonceBytes', 24],
  ['KEY_ID_BYTES', 'secrets.keyIdBytes', 8],
  ['APP_KEY_FILE_MAX_BYTES', 'secrets.appKeyFileMaxBytes', 1_024],
  // Microsoft
  ['CLIENT_ASSERTION_LIFETIME_SECONDS', 'microsoft.clientAssertionLifetimeSeconds', 300],
  ['TOKEN_ENDPOINT_TIMEOUT_SECONDS', 'microsoft.tokenEndpointTimeoutSeconds', 10],
  ['ID_TOKEN_MAX_BYTES', 'microsoft.idTokenMaxBytes', 8_192],
  ['CLOCK_TOLERANCE_SECONDS', 'microsoft.clockToleranceSeconds', 60],
  ['JWKS_CACHE_HOURS', 'microsoft.jwksCacheHours', 24],
  ['JWKS_REFRESH_MINUTES', 'microsoft.jwksRefreshMinutes', 60],
  ['JWKS_UNKNOWN_KID_COOLDOWN_MINUTES', 'microsoft.jwksUnknownKidCooldownMinutes', 5],
  ['GRAPH_CHECK_MEMBER_GROUPS_MAX_IDS', 'microsoft.graphCheckMemberGroupsMaxIds', 20],
  ['GRAPH_RETRY_MAX', 'microsoft.graphRetryMax', 4],
  ['GRAPH_RETRY_AFTER_MAX_WAIT_SECONDS', 'microsoft.graphRetryAfterMaxWaitSeconds', 60],
  ['GRAPH_5XX_BACKOFF (initial)', 'microsoft.graph5xxBackoff.initialMs', 500],
  ['GRAPH_5XX_BACKOFF (ceiling)', 'microsoft.graph5xxBackoff.maxMs', 10_000],
  ['GRAPH_5XX_BACKOFF (retries)', 'microsoft.graph5xxBackoff.maxRetries', 4],
  ['GRAPH_BUDGET_INTERACTIVE_SECONDS', 'microsoft.graphBudgetInteractiveSeconds', 20],
  ['GRAPH_BUDGET_WIZARD_SECONDS', 'microsoft.graphBudgetWizardSeconds', 60],
  ['GRAPH_IN_FLIGHT_MAX', 'microsoft.graphInFlightMax', 4],
  ['GRAPH_CACHE_TTL_SECONDS (organization)', 'microsoft.graphCacheTtlSeconds.organization', 300],
  ['GRAPH_CACHE_TTL_SECONDS (user)', 'microsoft.graphCacheTtlSeconds.user', 60],
  ['GRAPH_CACHE_TTL_SECONDS (group)', 'microsoft.graphCacheTtlSeconds.group', 60],
  ['GRAPH_CACHE_ENTRIES', 'microsoft.graphCacheEntries', 1_000],
  ['EXCHANGE_RESULT_SIZE_MAX', 'microsoft.exchangeResultSizeMax', 1_000],
  ['EXCHANGE_PAGING_WINDOW_SECONDS', 'microsoft.exchangePagingWindowSeconds', 300],
  // Sign-in
  ['LOGIN_TX_MAX', 'signIn.loginTxMax', 1_000],
  ['LOGIN_TX_PER_CLIENT_MAX', 'signIn.loginTxPerClientMax', 20],
  ['LOGIN_TX_LIFETIME_SECONDS', 'signIn.loginTxLifetimeSeconds', 600],
  ['RETURN_TO_MAX_CHARS', 'signIn.returnToMaxChars', 256],
  ['RATE_AUTH (capacity)', 'rateLimit.auth.capacity', 10],
  ['RATE_AUTH (refill interval)', 'rateLimit.auth.refillIntervalMs', 5_000],
  ['RATE_SETUP (capacity)', 'rateLimit.setup.capacity', 10],
  ['RATE_SETUP (refill interval)', 'rateLimit.setup.refillIntervalMs', 5_000],
  // Session
  ['SESSION_IDLE_TIMEOUT_MINUTES (default)', 'session.idleTimeoutMinutes.default', 30],
  ['SESSION_IDLE_TIMEOUT_MINUTES (min)', 'session.idleTimeoutMinutes.min', 5],
  ['SESSION_IDLE_TIMEOUT_MINUTES (max)', 'session.idleTimeoutMinutes.max', 480],
  ['SESSION_ABSOLUTE_TIMEOUT_HOURS (default)', 'session.absoluteTimeoutHours.default', 8],
  ['SESSION_ABSOLUTE_TIMEOUT_HOURS (min)', 'session.absoluteTimeoutHours.min', 1],
  ['SESSION_ABSOLUTE_TIMEOUT_HOURS (max)', 'session.absoluteTimeoutHours.max', 24],
  ['SESSION_WRITE_INTERVAL_SECONDS', 'session.writeIntervalSeconds', 60],
  ['SESSIONS_PER_PRINCIPAL_MAX', 'session.perPrincipalMax', 10],
  ['SESSION_PURGE_MINUTES', 'session.purgeMinutes', 60],
  ['SESSION_IDLE_WARNING_SECONDS', 'session.idleWarningSeconds', 120],
  ['SESSION_ABSOLUTE_WARNING_MINUTES', 'session.absoluteWarningMinutes', 5],
  ['STEP_UP_WINDOW_MINUTES', 'session.stepUpWindowMinutes', 10],
  ['STEP_UP_AUTH_TIME_LEEWAY_SECONDS', 'session.stepUpAuthTimeLeewaySeconds', 60],
  ['REVALIDATE_RETRY_SECONDS', 'session.revalidateRetrySeconds', 30],
  // Break-glass
  ['BREAK_GLASS_SESSION_MINUTES', 'breakGlass.sessionMinutes', 30],
  ['BREAK_GLASS_FAILS_PER_CLIENT', 'breakGlass.failsPerClient', 5],
  ['BREAK_GLASS_FAILS_PER_CLIENT (window)', 'breakGlass.failsPerClientWindowMinutes', 15],
  ['BREAK_GLASS_FAILS_GLOBAL', 'breakGlass.failsGlobal', 20],
  ['BREAK_GLASS_FAILS_GLOBAL (window)', 'breakGlass.failsGlobalWindowMinutes', 60],
  ['SCRYPT_N_MIN', 'breakGlass.scrypt.nMin', 16_384],
  ['SCRYPT_N_MAX', 'breakGlass.scrypt.nMax', 131_072],
  ['SCRYPT_MAX_MEMORY_BYTES', 'breakGlass.scrypt.maxMemoryBytes', 134_217_728],
  ['SCRYPT_SALT_BYTES (min)', 'breakGlass.scrypt.saltMinBytes', 16],
  ['SCRYPT_SALT_BYTES (max)', 'breakGlass.scrypt.saltMaxBytes', 64],
  ['SCRYPT_HASH_BYTES (min)', 'breakGlass.scrypt.hashMinBytes', 32],
  ['SCRYPT_HASH_BYTES (max)', 'breakGlass.scrypt.hashMaxBytes', 64],
  ['BREAK_GLASS_QUEUE_RUNNING', 'breakGlass.queueRunning', 1],
  ['BREAK_GLASS_QUEUE_WAITING', 'breakGlass.queueWaiting', 2],
  ['BREAK_GLASS_PASSWORD_MIN_CHARS', 'breakGlass.passwordMinChars', 14],
  // RBAC
  ['GROUP_CACHE_TTL_SECONDS (default)', 'rbac.groupCacheTtlSeconds.default', 300],
  ['GROUP_CACHE_TTL_SECONDS (min)', 'rbac.groupCacheTtlSeconds.min', 30],
  ['GROUP_CACHE_TTL_SECONDS (max)', 'rbac.groupCacheTtlSeconds.max', 3_600],
  ['GROUPS_BOUND_MAX', 'rbac.groupsBoundMax', 200],
  ['ASSIGNMENTS_MAX', 'rbac.assignmentsMax', 5_000],
  ['ROLES_MAX', 'rbac.rolesMax', 100],
  ['SCOPE_ITEMS_PER_ASSIGNMENT_MAX', 'rbac.scopeItemsPerAssignmentMax', 50],
  ['SCOPE_VALUE_MAX_CHARS', 'rbac.scopeValueMaxChars', 64],
  ['ASSIGNMENT_EXPIRY_MAX_DAYS', 'rbac.assignmentExpiryMaxDays', 730],
  // Request size
  ['AUTH_BODY_MAX_BYTES', 'body.authBytes', 4_096],
];

/**
 * Phase C spec 6.7.2 (T-C-002), row by row: [constant, `LIMITS` path, value]. The key is `directory`;
 * a row that states two numbers has one entry per number.
 */
const SPEC_C_6_7_2: readonly (readonly [constant: string, path: string, value: number])[] = [
  ['searchMaxChars', 'directory.searchMaxChars', 64],
  ['pageLimitDefault', 'directory.pageLimitDefault', 100],
  ['pageLimitMax', 'directory.pageLimitMax', 200],
  ['graphPageSize', 'directory.graphPageSize', 999],
  ['scanPagesMax', 'directory.scanPagesMax', 5],
  ['cursorTtlSeconds', 'directory.cursorTtlSeconds', 600],
  ['cursorEntries', 'directory.cursorEntries', 1_000],
];

/**
 * Phase D spec 6.11.2, step D1 rows (T-D-102): [constant, `LIMITS` path, value]. The spec table states
 * the first eight; the rest are the constants the plan and the contract named without a number
 * (plan 5.1 and 5.2, FR-D-105, FR-D-302, FR-D-353): they are recorded in the gate note GD1-0 and in
 * the amendment of spec 6.11.2. The D2 and D3 rows (`export`, `audit`, `cert`) arrive with their steps.
 */
const SPEC_D_6_11_2: readonly (readonly [constant: string, path: string, value: number])[] = [
  ['exchange.workerMaxCalls', 'exchange.workerMaxCalls', 500],
  ['exchange.workerMaxAgeSeconds', 'exchange.workerMaxAgeSeconds', 3_600],
  ['exchange.callDeadlineSeconds', 'exchange.callDeadlineSeconds', 120],
  ['distributionLists.bulkMax', 'distributionLists.bulkMax', 200],
  ['distributionLists.bulkChunk', 'distributionLists.bulkChunk', 50],
  ['distributionLists.stepUpAbove', 'distributionLists.stepUpAbove', 20],
  ['export.rowsMax', 'export.rowsMax', 100_000],
  ['export.previewRows', 'export.previewRows', 20],
  ['rateLimit.export (capacity)', 'rateLimit.export.capacity', 6],
  ['rateLimit.export (refill)', 'rateLimit.export.refillIntervalMs', 10_000],
  // Named by the plan or the contract, number chosen here:
  ['exchange.listBufferMax', 'exchange.listBufferMax', 10_000],
  ['exchange.lineMaxBytes', 'exchange.lineMaxBytes', 1_048_576],
  ['exchange.retryMax', 'exchange.retryMax', 3],
  ['exchange.retryBackoff (initial)', 'exchange.retryBackoff.initialMs', 1_000],
  ['exchange.retryBackoff (max)', 'exchange.retryBackoff.maxMs', 15_000],
  ['groupMembers.bulkMax', 'groupMembers.bulkMax', 200],
  ['groupMembers.bulkChunk', 'groupMembers.bulkChunk', 20],
  ['groupMembers.stepUpAbove', 'groupMembers.stepUpAbove', 20],
  ['contacts.nameMaxChars', 'contacts.nameMaxChars', 64],
  ['contacts.displayNameMaxChars', 'contacts.displayNameMaxChars', 256],
  ['contacts.aliasMaxChars', 'contacts.aliasMaxChars', 64],
  ['contacts.personNameMaxChars', 'contacts.personNameMaxChars', 64],
  ['contacts.addressMaxChars', 'contacts.addressMaxChars', 254],
];

/** The paths of spec 6.5, 6.9.2, Phase C 6.7.2 and Phase D 6.11.2 (D1) together: the complete shape of `LIMITS`. */
const SPEC_ALL: Readonly<Record<string, number>> = {
  ...SPEC_6_5,
  ...Object.fromEntries(SPEC_6_9_2.map(([, path, value]) => [path, value])),
  ...Object.fromEntries(SPEC_C_6_7_2.map(([, path, value]) => [path, value])),
  ...Object.fromEntries(SPEC_D_6_11_2.map(([, path, value]) => [path, value])),
};

/** Every leaf of a nested object as `dotted.path -> value`. */
function leaves(value: unknown, prefix = ''): Map<string, unknown> {
  const found = new Map<string, unknown>();
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      for (const [leafPath, leaf] of leaves(child, path)) found.set(leafPath, leaf);
    }
  } else {
    found.set(prefix, value);
  }
  return found;
}

/**
 * The guard behind this file: throws unless `candidate` holds exactly the rows of spec 6.5 with
 * exactly their values. Missing, extra and different values are all reported by name.
 */
function assertSpecTable(candidate: unknown): void {
  const actual = leaves(candidate);
  const problems: string[] = [];
  for (const [path, expected] of Object.entries(SPEC_ALL)) {
    if (!actual.has(path)) problems.push(`missing ${path}`);
    else if (actual.get(path) !== expected) {
      problems.push(`${path} is ${String(actual.get(path))}, the spec says ${String(expected)}`);
    }
  }
  for (const path of actual.keys()) {
    if (!(path in SPEC_ALL)) problems.push(`${path} is not a row of spec 6.5 or 6.9.2`);
  }
  if (problems.length > 0)
    throw new Error(`limits differ from spec 6.5 and 6.9.2: ${problems.join('; ')}`);
}

describe('LIMITS: spec sections 6.5 and 6.9.2', () => {
  it('names every spec constant of 6.9.2 once, and every path once', () => {
    const constants = SPEC_6_9_2.map(([constant]) => constant);
    const paths = SPEC_6_9_2.map(([, path]) => path);
    expect(new Set(constants).size).toBe(constants.length);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path in SPEC_6_5, path).toBe(false);
  });

  it('holds every row of the table with its exact value, and nothing else', () => {
    expect(() => {
      assertSpecTable(LIMITS);
    }).not.toThrow();
  });

  it('has the default port of the container, defined here once (FR-A-016)', () => {
    expect(DEFAULT_PORT).toBe(9300);
  });

  it('has only safe integers (a refill rate is an interval in milliseconds, not a fraction)', () => {
    for (const [path, value] of leaves(LIMITS)) {
      expect(Number.isSafeInteger(value), `${path} = ${String(value)}`).toBe(true);
    }
    expect(Number.isSafeInteger(DEFAULT_PORT)).toBe(true);
  });

  it('has only positive values', () => {
    for (const [path, value] of leaves(LIMITS)) {
      expect(value as number, path).toBeGreaterThan(0);
    }
  });

  it('is frozen all the way down: no consumer can change a limit at runtime', () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
    expect(Object.isFrozen(LIMITS.body)).toBe(true);
    expect(Object.isFrozen(LIMITS.rateLimit)).toBe(true);
    expect(Object.isFrozen(LIMITS.rateLimit.read)).toBe(true);
    expect(() => {
      (LIMITS.body as { jsonBytes: number }).jsonBytes = 1;
    }).toThrow(TypeError);
    expect(LIMITS.body.jsonBytes).toBe(262_144);
  });
});

describe('LIMITS.directory: Phase C spec 6.7.2 (T-C-002)', () => {
  it('names every constant and every path once, apart from the earlier tables', () => {
    const paths = SPEC_C_6_7_2.map(([, path]) => path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path in SPEC_6_5, path).toBe(false);
      expect(
        SPEC_6_9_2.some(([, other]) => other === path),
        path,
      ).toBe(false);
    }
  });

  it.each(SPEC_C_6_7_2)('%s is %d at %s', (_constant, path, value) => {
    expect(leaves(LIMITS).get(path)).toBe(value);
  });

  it('keeps the list convention of Phase B (CD-10): the page default and ceiling are the ones the shared list schema uses', () => {
    expect(LIMITS.directory.pageLimitDefault).toBe(PAGE_LIMIT_DEFAULT);
    expect(LIMITS.directory.pageLimitMax).toBe(PAGE_LIMIT_MAX);
  });

  it('asks Graph for at most 999 rows a page (R-C-01) and scans a handful of pages for a scoped list', () => {
    expect(LIMITS.directory.graphPageSize).toBe(999);
    expect(LIMITS.directory.scanPagesMax).toBeLessThanOrEqual(10);
    expect(LIMITS.directory.pageLimitMax).toBeLessThanOrEqual(LIMITS.directory.graphPageSize);
  });

  it('adds no request body, so the largest request of the application is unchanged (spec 6.7.2)', () => {
    expect(LIMITS.body.importRequestBytes).toBe(9_437_184);
  });

  it('is frozen like the rest of LIMITS', () => {
    expect(Object.isFrozen(LIMITS.directory)).toBe(true);
    expect(() => {
      (LIMITS.directory as { scanPagesMax: number }).scanPagesMax = 50;
    }).toThrow(TypeError);
  });

  it('fails the guard when a value differs, is missing or is extra (negative fixtures)', () => {
    expectGuardFails(
      assertSpecTable,
      { ...LIMITS, directory: { ...LIMITS.directory, scanPagesMax: 6 } },
      { reason: 'directory.scanPagesMax is 6' },
    );
    const without = structuredClone(LIMITS);
    Reflect.deleteProperty(without.directory, 'cursorTtlSeconds');
    expectGuardFails(assertSpecTable, without, { reason: 'missing directory.cursorTtlSeconds' });
    expectGuardFails(
      assertSpecTable,
      { ...LIMITS, directory: { ...LIMITS.directory, extra: 1 } },
      { reason: 'directory.extra is not a row' },
    );
  });
});

describe('LIMITS: Phase D step D1 (spec 6.11.2, T-D-102)', () => {
  it('names every path once, apart from the earlier tables', () => {
    const paths = SPEC_D_6_11_2.map(([, path]) => path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path in SPEC_6_5, path).toBe(false);
      expect(
        SPEC_C_6_7_2.some(([, other]) => other === path),
        path,
      ).toBe(false);
    }
  });

  it.each(SPEC_D_6_11_2)('%s is %d at %s', (_constant, path, value) => {
    expect(leaves(LIMITS).get(path)).toBe(value);
  });

  it('states the first eight rows in the spec document as the table gives them', () => {
    const spec = readFileSync(
      fileURLToPath(new URL('../../../specs/004-phase-d/spec.md', import.meta.url)),
      'utf8',
    );
    const section = /^#### 6\.11\.2 Limits([\s\S]*?)^#### 6\.11\.3/m.exec(spec)?.[1] ?? '';
    for (const constant of [
      'exchange.workerMaxCalls',
      'exchange.workerMaxAgeSeconds',
      'exchange.callDeadlineSeconds',
      'distributionLists.bulkMax',
      'bulkChunk',
      'stepUpAbove',
    ]) {
      expect(section, constant).toContain(constant);
    }
    expect(section).toMatch(/500, 3,600/);
    expect(section).toMatch(/\| 120 \|/);
    expect(section).toMatch(/200, 50, 20/);
  });

  it('keeps the numbers consistent with each other and with Learn', () => {
    // One cmdlet call may not outlast the 15 minute REST timeout Learn states (R-D-02).
    expect(LIMITS.exchange.callDeadlineSeconds).toBeLessThan(15 * 60);
    expect(LIMITS.exchange.workerMaxAgeSeconds).toBeGreaterThan(
      LIMITS.exchange.callDeadlineSeconds,
    );
    // A bulk request fits the JSON body limit: 200 GUIDs of 36 characters plus quotes and commas.
    expect(LIMITS.distributionLists.bulkMax * 40).toBeLessThan(LIMITS.body.jsonBytes);
    expect(LIMITS.groupMembers.bulkMax * 40).toBeLessThan(LIMITS.body.jsonBytes);
    // The step-up threshold is below the bulk ceiling, a chunk divides the ceiling.
    expect(LIMITS.distributionLists.stepUpAbove).toBeLessThan(LIMITS.distributionLists.bulkMax);
    expect(LIMITS.distributionLists.bulkMax % LIMITS.distributionLists.bulkChunk).toBe(0);
    expect(LIMITS.groupMembers.bulkMax % LIMITS.groupMembers.bulkChunk).toBe(0);
    // Graph adds at most 20 members in one request (R-D-08): the group chunk never exceeds it.
    expect(LIMITS.groupMembers.bulkChunk).toBeLessThanOrEqual(20);
    // A cmdlet name, a member list and a full list answer fit one protocol line.
    expect(LIMITS.exchange.lineMaxBytes).toBeGreaterThanOrEqual(LIMITS.body.jsonBytes);
    // Exchange names: Name 64, DisplayName 256, Alias 64, address 254 (R-D-09).
    expect(LIMITS.contacts.nameMaxChars).toBe(64);
    expect(LIMITS.contacts.displayNameMaxChars).toBe(256);
  });

  it('is frozen like the rest of LIMITS', () => {
    for (const group of [
      LIMITS.exchange,
      LIMITS.distributionLists,
      LIMITS.groupMembers,
      LIMITS.contacts,
    ]) {
      expect(Object.isFrozen(group)).toBe(true);
    }
    expect(() => {
      (LIMITS.exchange as { workerMaxCalls: number }).workerMaxCalls = 1;
    }).toThrow(TypeError);
  });

  it('fails the guard when a Phase D value differs, is missing or is extra (negative fixtures)', () => {
    expectGuardFails(
      assertSpecTable,
      { ...LIMITS, exchange: { ...LIMITS.exchange, workerMaxCalls: 501 } },
      { reason: 'exchange.workerMaxCalls is 501' },
    );
    const without = structuredClone(LIMITS);
    Reflect.deleteProperty(without.distributionLists, 'bulkChunk');
    expectGuardFails(assertSpecTable, without, { reason: 'missing distributionLists.bulkChunk' });
    expectGuardFails(
      assertSpecTable,
      { ...LIMITS, contacts: { ...LIMITS.contacts, extra: 1 } },
      { reason: 'contacts.extra is not a row' },
    );
  });
});

describe('LIMITS: rate classes', () => {
  it.each<[RateLimitClass, number, number]>([
    ['read', 120, 2],
    ['write', 10, 0.5],
    ['upload', 3, 0.1],
    ['auth', 10, 0.2],
    ['setup', 10, 0.2],
    ['export', 6, 0.1],
  ])('%s: capacity %d, refill %d per second', (rateClass, capacity, perSecond) => {
    expect(LIMITS.rateLimit[rateClass].capacity).toBe(capacity);
    expect(refillPerSecond(rateClass)).toBe(perSecond);
  });

  it('knows exactly the six classes of the spec: three of Phase A, `auth` and `setup` (SB-28), and `export` of Phase D (ODD-07: 6 a minute)', () => {
    expect(Object.keys(LIMITS.rateLimit).sort()).toEqual([
      'auth',
      'export',
      'read',
      'setup',
      'upload',
      'write',
    ]);
  });

  it('the Phase B classes allow bursts of 10 and refill one token every 5 seconds', () => {
    for (const rateClass of ['auth', 'setup'] as const) {
      expect(LIMITS.rateLimit[rateClass]).toEqual({ capacity: 10, refillIntervalMs: 5_000 });
    }
  });

  it('orders the classes from the cheapest to the most expensive (a write never beats a read)', () => {
    expect(LIMITS.rateLimit.read.capacity).toBeGreaterThan(LIMITS.rateLimit.write.capacity);
    expect(LIMITS.rateLimit.write.capacity).toBeGreaterThan(LIMITS.rateLimit.upload.capacity);
    expect(LIMITS.rateLimit.read.refillIntervalMs).toBeLessThan(
      LIMITS.rateLimit.write.refillIntervalMs,
    );
    expect(LIMITS.rateLimit.write.refillIntervalMs).toBeLessThan(
      LIMITS.rateLimit.upload.refillIntervalMs,
    );
  });
});

describe('LIMITS: derivations that the spec states', () => {
  const { body } = LIMITS;

  it('the upload request is the logo plus a 64 KiB envelope', () => {
    expect(body.uploadRequestBytes).toBe(body.logoFileBytes + 64 * KIB);
  });

  it('the import request is the base64 of three logos plus 64 KiB of JSON, rounded up to whole MiB (A-36)', () => {
    // base64 writes every 3 bytes as 4 characters, with padding at the end.
    const base64Characters = Math.ceil(body.logoFileBytes / 3) * 4;
    expect(base64Characters).toBe(2_796_204);

    const threeImages = 3 * base64Characters;
    expect(threeImages).toBe(8_388_612);

    const withJson = threeImages + 64 * KIB;
    expect(withJson).toBe(8_454_148);

    // 8 MiB is too small by 65,540 bytes, so the limit is the next whole MiB: 9 MiB.
    expect(8 * MIB).toBeLessThan(withJson);
    expect(Math.ceil(withJson / MIB) * MIB).toBe(body.importRequestBytes);
    expect(body.importRequestBytes).toBe(9 * MIB);
  });

  it('the import is the largest request the app accepts (what must be allowed in front)', () => {
    const others = [body.jsonBytes, body.logoFileBytes, body.uploadRequestBytes];
    expect(body.importRequestBytes).toBeGreaterThan(Math.max(...others));
  });

  it('the pixel limit is 4096 by 4096', () => {
    expect(LIMITS.image.inputPixels).toBe(4096 * 4096);
  });

  it('the staging quota is 32 files and 32 MiB', () => {
    expect(LIMITS.staging.quotaFiles).toBe(32);
    expect(LIMITS.staging.quotaBytes).toBe(32 * MIB);
  });

  it('the keep-alive timeout exceeds the 60 s idle timeout of a proxy, the request timeout does not exceed it', () => {
    expect(LIMITS.http.keepAliveTimeoutMs).toBeGreaterThan(60 * SECOND);
    expect(LIMITS.http.headersTimeoutMs).toBeLessThanOrEqual(LIMITS.http.requestTimeoutMs);
  });

  it('the CSRF lifetime is 8 hours and the staged retention 24 hours', () => {
    expect(LIMITS.csrfTokenLifetimeMs).toBe(8 * HOUR);
    expect(LIMITS.staging.retentionMs).toBe(24 * HOUR);
  });
});

describe('the limits guard (negative fixtures)', () => {
  it('fails when a value differs from the spec (the import limit set to the pre-rounding 8,454,148)', () => {
    const wrong = { ...LIMITS, body: { ...LIMITS.body, importRequestBytes: 8_454_148 } };
    expectGuardFails(assertSpecTable, wrong, { reason: 'body.importRequestBytes is 8454148' });
  });

  it('fails when a row is missing', () => {
    const withoutDrain = structuredClone(LIMITS);
    Reflect.deleteProperty(withoutDrain, 'shutdownDrainMs');
    expectGuardFails(assertSpecTable, withoutDrain, { reason: 'missing shutdownDrainMs' });
  });

  it('fails when a row is missing inside a group', () => {
    const withoutCap = structuredClone(LIMITS);
    Reflect.deleteProperty(withoutCap.image, 'svgExpandedInstances');
    expectGuardFails(assertSpecTable, withoutCap, { reason: 'missing image.svgExpandedInstances' });
  });

  it('fails when a constant is added without a row in the spec', () => {
    const extra = { ...LIMITS, undocumentedLimit: 7 };
    expectGuardFails(assertSpecTable, extra, {
      reason: 'undocumentedLimit is not a row of spec 6.5',
    });
  });

  it('fails when a rate class is slower than the spec says', () => {
    const slow = {
      ...LIMITS,
      rateLimit: { ...LIMITS.rateLimit, upload: { capacity: 3, refillIntervalMs: 1000 } },
    };
    expectGuardFails(assertSpecTable, slow, { reason: 'rateLimit.upload.refillIntervalMs' });
  });

  it('fails when a value is stored as a string', () => {
    const text = { ...LIMITS, trackedClients: '10000' };
    expectGuardFails(assertSpecTable, text, { reason: 'trackedClients is 10000' });
  });
});

describe('TRUSTED_TYPES_POLICY_NAME (T-A-028, FR-A-042, plan 8.2)', () => {
  it('is the one policy name: the CSP lists it and the service worker registration creates it', () => {
    expect(TRUSTED_TYPES_POLICY_NAME).toBe('m365portal-sw');
  });

  it('is a valid Trusted Types policy name token', () => {
    // The `trusted-types` directive takes names of letters, digits and "-#=_/@.%" only.
    expect(TRUSTED_TYPES_POLICY_NAME).toMatch(/^[A-Za-z0-9\-#=_/@.%]+$/);
  });
});
