// T-A-270 (FR-A-182, SC-A-014, E-24): the limits table of `docs/operations.md` equals `LIMITS`.
//
// `LIMITS` (packages/shared/src/limits.ts) is the one source of every number; the document is a
// mirror. The guard `assertLimitsDocument` throws when
//   - the section "Limits outside the repository" (the anchor AGENTS.md links to) or its table
//     (header: Limit, Value, Enforced by, Constrains) is missing;
//   - a row of spec 6.5 is missing, or a row has no "enforced by" or "constrains" text;
//   - the Value cell of a row does not state every number of its LIMITS entries (rates as the
//     per-second figure the spec states, durations in the unit of the spec: seconds, hours);
//   - a number of 1,000 or more in a Value or Constrains cell is not a value of LIMITS (or one of
//     the numbers of the import derivation, A-36): that is how an altered number is caught;
//   - the table has a row that spec 6.5 does not have, or a LIMITS entry is claimed by no row;
//   - the sentence that whatever sits in front must allow at least 9,437,184 bytes is missing;
//   - the Dutch section does not state the largest request.
// Phase B adds one row per row of spec 6.9.2, labelled with the constant of the spec (`SETUP_LOCK_MINUTES`).
// Format the document author must follow: one row per spec 6.5 row, the label starting with the
// words below, numbers written with thousands separators (`262,144`) or without (`9437184`).
//
// The real document is `docs/operations.md` (T-A-277). Until it is written the "real document"
// tests are red for exactly that reason: the table is the skeleton's placeholder row.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { findTable, numbersIn, sectionOf, stripMarkup } from './fixtures/docs/markdown.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureDirectory = fileURLToPath(new URL('./fixtures/docs/', import.meta.url));

/** A LIMITS path, optionally with a conversion to the unit the spec states. */
type Source = string | readonly [path: string, convert: (value: number) => number];

interface RowSpec {
  /** The label of the row starts with this text (markup and case ignored). */
  readonly label: string;
  readonly sources: readonly Source[];
}

const toSeconds = (ms: number): number => ms / 1000;
const toHours = (ms: number): number => ms / 3_600_000;
const perSecond = (refillIntervalMs: number): number => 1000 / refillIntervalMs;

/** The rows of spec 6.5, in the order the spec has them. */
const ROWS: readonly RowSpec[] = [
  { label: 'JSON request body', sources: ['body.jsonBytes'] },
  { label: 'Logo file', sources: ['body.logoFileBytes'] },
  { label: 'Logo upload request body', sources: ['body.uploadRequestBytes'] },
  { label: 'Branding import request body', sources: ['body.importRequestBytes'] },
  { label: 'Input pixels per image', sources: ['image.inputPixels'] },
  { label: 'SVG elements and depth', sources: ['image.svgElements', 'image.svgDepth'] },
  { label: 'Master sizes', sources: ['image.logoMasterPx', 'image.compactMasterPx'] },
  {
    label: 'Concurrent image jobs and queue',
    sources: ['image.concurrentJobs', 'image.queuedJobs'],
  },
  { label: 'Staging quota', sources: ['staging.quotaFiles', 'staging.quotaBytes'] },
  { label: 'SVG expanded element instances', sources: ['image.svgExpandedInstances'] },
  { label: 'Image job time budget', sources: [['image.jobTimeBudgetMs', toSeconds]] },
  { label: 'Request header size', sources: ['http.headerBytes'] },
  {
    label: 'Headers timeout, request timeout, keep-alive timeout',
    sources: [
      ['http.headersTimeoutMs', toSeconds],
      ['http.requestTimeoutMs', toSeconds],
      ['http.keepAliveTimeoutMs', toSeconds],
    ],
  },
  {
    label: 'Rate limit read',
    sources: ['rateLimit.read.capacity', ['rateLimit.read.refillIntervalMs', perSecond]],
  },
  {
    label: 'Rate limit write',
    sources: ['rateLimit.write.capacity', ['rateLimit.write.refillIntervalMs', perSecond]],
  },
  {
    label: 'Rate limit upload',
    sources: ['rateLimit.upload.capacity', ['rateLimit.upload.refillIntervalMs', perSecond]],
  },
  { label: 'Tracked clients', sources: ['trackedClients'] },
  { label: 'CSRF token lifetime', sources: [['csrfTokenLifetimeMs', toHours]] },
  { label: 'Staged asset retention', sources: [['staging.retentionMs', toHours]] },
  { label: 'Pre-migration backups kept', sources: ['preMigrationBackupsKept'] },
  { label: 'Graceful shutdown drain', sources: [['shutdownDrainMs', toSeconds]] },
  { label: 'Audit entry detail', sources: ['auditDetailBytes'] },
  { label: 'Organisation name', sources: ['orgName.maxGraphemes', 'orgName.maxBytes'] },
  { label: 'HSTS max-age default', sources: ['hstsMaxAgeSeconds'] },
  { label: 'Image size ceiling', sources: ['imageSizeCeilingMegabytes'] },
  // Phase B, spec 6.9.2 (T-B-004): the label is the constant of the spec row.
  {
    label: 'SETUP_UNLOCK_FAILS_PER_CLIENT',
    sources: ['setup.unlockFailsPerClient', 'setup.unlockFailsPerClientWindowMinutes'],
  },
  {
    label: 'SETUP_UNLOCK_FAILS_GLOBAL',
    sources: ['setup.unlockFailsGlobal', 'setup.unlockFailsGlobalWindowMinutes'],
  },
  {
    label: 'SETUP_LOCK_MINUTES',
    sources: ['setup.lockMinutes'],
  },
  {
    label: 'SETUP_SESSION_IDLE_MINUTES, SETUP_SESSION_ABSOLUTE_HOURS',
    sources: ['setup.sessionIdleMinutes', 'setup.sessionAbsoluteHours'],
  },
  {
    label: 'SETUP_SESSIONS_MAX',
    sources: ['setup.sessionsMax'],
  },
  {
    label: 'SETUP_MIN_WAIT_MS',
    sources: ['setup.minWaitMs'],
  },
  {
    label: 'SETUP_TOKEN_BYTES',
    sources: ['setup.tokenBytes'],
  },
  {
    label: 'SETUP_LEASE_HEARTBEAT_SECONDS, SETUP_LEASE_EXPIRY_SECONDS',
    sources: ['setup.leaseHeartbeatSeconds', 'setup.leaseExpirySeconds'],
  },
  {
    label: 'SETUP_LOG_RETAINED, SETUP_LOG_PAGE_MAX',
    sources: ['setup.logRetained', 'setup.logPageMax'],
  },
  {
    label: 'SETUP_DETAIL_STRING_MAX_BYTES, SETUP_VERIFY_RESULT_MAX_BYTES',
    sources: ['setup.detailStringMaxBytes', 'setup.verifyResultMaxBytes'],
  },
  {
    label: 'SETUP_TRANSIENT_BACKOFF',
    sources: [
      ['setup.transientBackoff.initialMs', toSeconds],
      ['setup.transientBackoff.maxMs', toSeconds],
      'setup.transientBackoff.maxTries',
    ],
  },
  {
    label: 'SETUP_REPLICATION_BACKOFF',
    sources: [
      ['setup.replicationBackoff.initialMs', toSeconds],
      ['setup.replicationBackoff.maxMs', toSeconds],
    ],
  },
  {
    label: 'SETUP_OBJECT_CHAIN_WINDOW_SECONDS',
    sources: ['setup.objectChainWindowSeconds'],
  },
  {
    label: 'SETUP_PROPAGATION_TIMEOUT_SECONDS (setting)',
    sources: [
      'setup.propagationTimeoutSeconds.default',
      'setup.propagationTimeoutSeconds.min',
      'setup.propagationTimeoutSeconds.max',
    ],
  },
  {
    label: 'SETUP_SKEW_WARN_SECONDS, SETUP_SKEW_FAIL_SECONDS',
    sources: ['setup.skewWarnSeconds', 'setup.skewFailSeconds'],
  },
  {
    label: 'SETUP_MUTATING_CALLS_CLEAN_RUN',
    sources: ['setup.mutatingCallsCleanRun'],
  },
  {
    label: 'CERT_RSA_BITS, CERT_VALIDITY_DAYS, CERT_BACKDATE_MINUTES',
    sources: ['certificate.rsaBits', 'certificate.validityDays', 'certificate.backdateMinutes'],
  },
  {
    label: 'CERT_WARN_DAYS, CERT_CRITICAL_DAYS',
    sources: ['certificate.warnDays', 'certificate.criticalDays'],
  },
  {
    label: 'APP_KEY_BYTES, SECRET_NONCE_BYTES, KEY_ID_BYTES',
    sources: ['secrets.appKeyBytes', 'secrets.nonceBytes', 'secrets.keyIdBytes'],
  },
  {
    label: 'APP_KEY_FILE_MAX_BYTES',
    sources: ['secrets.appKeyFileMaxBytes'],
  },
  {
    label: 'CLIENT_ASSERTION_LIFETIME_SECONDS',
    sources: ['microsoft.clientAssertionLifetimeSeconds'],
  },
  {
    label: 'TOKEN_ENDPOINT_TIMEOUT_SECONDS',
    sources: ['microsoft.tokenEndpointTimeoutSeconds'],
  },
  {
    label: 'ID_TOKEN_MAX_BYTES',
    sources: ['microsoft.idTokenMaxBytes'],
  },
  {
    label: 'CLOCK_TOLERANCE_SECONDS',
    sources: ['microsoft.clockToleranceSeconds'],
  },
  {
    label: 'JWKS_CACHE_HOURS, JWKS_REFRESH_MINUTES, JWKS_UNKNOWN_KID_COOLDOWN_MINUTES',
    sources: [
      'microsoft.jwksCacheHours',
      'microsoft.jwksRefreshMinutes',
      'microsoft.jwksUnknownKidCooldownMinutes',
    ],
  },
  {
    label: 'GRAPH_CHECK_MEMBER_GROUPS_MAX_IDS',
    sources: ['microsoft.graphCheckMemberGroupsMaxIds'],
  },
  {
    label: 'GRAPH_RETRY_MAX, GRAPH_RETRY_AFTER_MAX_WAIT_SECONDS',
    sources: ['microsoft.graphRetryMax', 'microsoft.graphRetryAfterMaxWaitSeconds'],
  },
  {
    label: 'GRAPH_5XX_BACKOFF',
    sources: [
      'microsoft.graph5xxBackoff.initialMs',
      ['microsoft.graph5xxBackoff.maxMs', toSeconds],
      'microsoft.graph5xxBackoff.maxRetries',
    ],
  },
  {
    label: 'GRAPH_BUDGET_INTERACTIVE_SECONDS, GRAPH_BUDGET_WIZARD_SECONDS, GRAPH_IN_FLIGHT_MAX',
    sources: [
      'microsoft.graphBudgetInteractiveSeconds',
      'microsoft.graphBudgetWizardSeconds',
      'microsoft.graphInFlightMax',
    ],
  },
  {
    label: 'GRAPH_CACHE_TTL_SECONDS, GRAPH_CACHE_ENTRIES',
    sources: [
      'microsoft.graphCacheTtlSeconds.organization',
      'microsoft.graphCacheTtlSeconds.user',
      'microsoft.graphCacheTtlSeconds.group',
      'microsoft.graphCacheEntries',
    ],
  },
  {
    label: 'EXCHANGE_RESULT_SIZE_MAX, EXCHANGE_PAGING_WINDOW_SECONDS',
    sources: ['microsoft.exchangeResultSizeMax', 'microsoft.exchangePagingWindowSeconds'],
  },
  {
    label: 'LOGIN_TX_MAX, LOGIN_TX_PER_CLIENT_MAX, LOGIN_TX_LIFETIME_SECONDS',
    sources: ['signIn.loginTxMax', 'signIn.loginTxPerClientMax', 'signIn.loginTxLifetimeSeconds'],
  },
  {
    label: 'RETURN_TO_MAX_CHARS',
    sources: ['signIn.returnToMaxChars'],
  },
  {
    label: 'RATE_AUTH, RATE_SETUP',
    sources: [
      'rateLimit.auth.capacity',
      ['rateLimit.auth.refillIntervalMs', perSecond],
      'rateLimit.setup.capacity',
      ['rateLimit.setup.refillIntervalMs', perSecond],
    ],
  },
  {
    label: 'SESSION_IDLE_TIMEOUT_MINUTES, SESSION_ABSOLUTE_TIMEOUT_HOURS (settings)',
    sources: [
      'session.idleTimeoutMinutes.default',
      'session.idleTimeoutMinutes.min',
      'session.idleTimeoutMinutes.max',
      'session.absoluteTimeoutHours.default',
      'session.absoluteTimeoutHours.min',
      'session.absoluteTimeoutHours.max',
    ],
  },
  {
    label: 'SESSION_WRITE_INTERVAL_SECONDS, SESSIONS_PER_PRINCIPAL_MAX, SESSION_PURGE_MINUTES',
    sources: ['session.writeIntervalSeconds', 'session.perPrincipalMax', 'session.purgeMinutes'],
  },
  {
    label: 'SESSION_IDLE_WARNING_SECONDS, SESSION_ABSOLUTE_WARNING_MINUTES',
    sources: ['session.idleWarningSeconds', 'session.absoluteWarningMinutes'],
  },
  {
    label: 'STEP_UP_WINDOW_MINUTES, STEP_UP_AUTH_TIME_LEEWAY_SECONDS',
    sources: ['session.stepUpWindowMinutes', 'session.stepUpAuthTimeLeewaySeconds'],
  },
  {
    label: 'REVALIDATE_RETRY_SECONDS',
    sources: ['session.revalidateRetrySeconds'],
  },
  {
    label: 'BREAK_GLASS_SESSION_MINUTES',
    sources: ['breakGlass.sessionMinutes'],
  },
  {
    label: 'BREAK_GLASS_FAILS_PER_CLIENT, BREAK_GLASS_FAILS_GLOBAL',
    sources: [
      'breakGlass.failsPerClient',
      'breakGlass.failsPerClientWindowMinutes',
      'breakGlass.failsGlobal',
      'breakGlass.failsGlobalWindowMinutes',
    ],
  },
  {
    label:
      'SCRYPT_N_MIN, SCRYPT_N_MAX, SCRYPT_MAX_MEMORY_BYTES, SCRYPT_SALT_BYTES, SCRYPT_HASH_BYTES',
    sources: [
      'breakGlass.scrypt.nMin',
      'breakGlass.scrypt.nMax',
      'breakGlass.scrypt.maxMemoryBytes',
      'breakGlass.scrypt.saltMinBytes',
      'breakGlass.scrypt.saltMaxBytes',
      'breakGlass.scrypt.hashMinBytes',
      'breakGlass.scrypt.hashMaxBytes',
    ],
  },
  {
    label: 'BREAK_GLASS_QUEUE_RUNNING, BREAK_GLASS_QUEUE_WAITING, BREAK_GLASS_PASSWORD_MIN_CHARS',
    sources: ['breakGlass.queueRunning', 'breakGlass.queueWaiting', 'breakGlass.passwordMinChars'],
  },
  {
    label: 'GROUP_CACHE_TTL_SECONDS (setting)',
    sources: [
      'rbac.groupCacheTtlSeconds.default',
      'rbac.groupCacheTtlSeconds.min',
      'rbac.groupCacheTtlSeconds.max',
    ],
  },
  {
    label: 'GROUPS_BOUND_MAX',
    sources: ['rbac.groupsBoundMax'],
  },
  {
    label: 'ASSIGNMENTS_MAX, ROLES_MAX',
    sources: ['rbac.assignmentsMax', 'rbac.rolesMax'],
  },
  {
    label: 'SCOPE_ITEMS_PER_ASSIGNMENT_MAX, SCOPE_VALUE_MAX_CHARS',
    sources: ['rbac.scopeItemsPerAssignmentMax', 'rbac.scopeValueMaxChars'],
  },
  {
    label: 'ASSIGNMENT_EXPIRY_MAX_DAYS',
    sources: ['rbac.assignmentExpiryMaxDays'],
  },
  {
    label: 'AUTH_BODY_MAX_BYTES',
    sources: ['body.authBytes'],
  },
];

function leafValue(path: string): number {
  let node: unknown = LIMITS;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(key in node)) {
      throw new Error(`fixture error: LIMITS has no ${path}`);
    }
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node !== 'number') throw new Error(`fixture error: LIMITS.${path} is not a number`);
  return node;
}

function leafPaths(node: unknown, prefix = ''): string[] {
  if (typeof node === 'number') return [prefix];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, child]) =>
    leafPaths(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function sourcePath(source: Source): string {
  return typeof source === 'string' ? source : source[0];
}

function sourceValue(source: Source): number {
  return typeof source === 'string' ? leafValue(source) : source[1](leafValue(source[0]));
}

/** The numbers the derivation of the largest request (A-36) adds to the row, computed not typed. */
function derivationNumbers(): number[] {
  const images = 3;
  const base64PerImage = 4 * Math.ceil(LIMITS.body.logoFileBytes / 3);
  const jsonAllowance = 65_536;
  return [
    base64PerImage,
    base64PerImage * images,
    base64PerImage * images + jsonAllowance,
    jsonAllowance,
  ];
}

/** Every number of 1,000 or more that a cell may contain. */
function allowedLargeNumbers(): Set<number> {
  const values = new Set<number>([4096, ...derivationNumbers()]);
  for (const row of ROWS) {
    for (const source of row.sources) values.add(sourceValue(source));
  }
  for (const path of leafPaths(LIMITS)) values.add(leafValue(path));
  return values;
}

const normalise = (label: string): string => stripMarkup(label).toLowerCase().replace(/\s+/g, ' ');

function assertLimitsDocument(markdown: string): void {
  const section = sectionOf(markdown, /^limits outside the repository$/i);
  if (section === undefined) {
    throw new Error('operations.md has no heading "Limits outside the repository"');
  }
  const table = findTable(
    section,
    (header) =>
      header.length === 4 &&
      header[0]?.toLowerCase() === 'limit' &&
      header[1]?.toLowerCase() === 'value' &&
      header[2]?.toLowerCase() === 'enforced by' &&
      header[3]?.toLowerCase() === 'constrains',
  );
  if (table === undefined) {
    throw new Error('the limits section has no table Limit | Value | Enforced by | Constrains');
  }

  const large = allowedLargeNumbers();
  const claimed = new Set<string>();
  const matchedRows = new Set<number>();
  for (const spec of ROWS) {
    const wanted = normalise(spec.label).replace(/`/g, '');
    const index = table.rows.findIndex((row) =>
      normalise(row[0] ?? '')
        .replace(/`/g, '')
        .startsWith(wanted),
    );
    const row = table.rows[index];
    if (row === undefined) throw new Error(`limits table has no row "${spec.label}"`);
    matchedRows.add(index);
    const [, value = '', enforcedBy = '', constrains = ''] = row;
    if (enforcedBy === '' || constrains === '') {
      throw new Error(`limits row "${spec.label}" has an empty "enforced by" or "constrains" cell`);
    }
    const stated = numbersIn(value);
    for (const source of spec.sources) {
      claimed.add(sourcePath(source));
      const expected = sourceValue(source);
      if (!stated.includes(expected)) {
        throw new Error(
          `limits row "${spec.label}" does not state ${String(expected)} (${sourcePath(source)}); it states ${stated.join(', ')}`,
        );
      }
    }
    for (const number of [...stated, ...numbersIn(constrains)]) {
      if (number >= 1000 && !large.has(number)) {
        throw new Error(
          `limits row "${spec.label}" contains ${String(number)}, which is no value of LIMITS`,
        );
      }
    }
  }
  const unknown = table.rows.findIndex((_, index) => !matchedRows.has(index));
  if (unknown !== -1) {
    throw new Error(
      `limits table has a row that spec 6.5 does not have: "${table.rows[unknown]?.[0] ?? ''}"`,
    );
  }
  for (const path of leafPaths(LIMITS)) {
    if (!claimed.has(path)) throw new Error(`LIMITS.${path} is stated by no row of this test`);
  }

  const flat = markdown.replace(/\s+/g, ' ');
  const largest = LIMITS.body.importRequestBytes.toLocaleString('en-US');
  const sentence = new RegExp(`in front[^.]*\\ballow\\b[^.]*at least ${largest} bytes`, 'i');
  if (!sentence.test(flat)) {
    throw new Error(
      `operations.md lacks the sentence that whatever sits in front must allow request bodies of at least ${largest} bytes`,
    );
  }

  const dutch = sectionOf(markdown, /^nederlands$/i);
  if (dutch === undefined) throw new Error('operations.md has no Dutch section "Nederlands"');
  const dutchDigits = dutch.replace(/(?<=\d)[.,\s'](?=\d{3}\b)/g, '');
  if (!dutchDigits.includes(String(LIMITS.body.importRequestBytes))) {
    throw new Error('the Dutch section does not state the largest request in bytes');
  }
}

// ---------------------------------------------------------------------------------------------
// A document built from LIMITS, the control for the negative cases
// ---------------------------------------------------------------------------------------------

const group = (n: number): string => n.toLocaleString('en-US');

function valueCell(spec: RowSpec): string {
  return spec.sources.map((source) => group(sourceValue(source))).join(' / ');
}

function buildDocument(change: (rows: string[][]) => void = () => undefined): string {
  const rows = ROWS.map((spec) => [
    spec.label,
    spec.label.startsWith('Branding import')
      ? `${valueCell(spec)} bytes (derivation: ${group(derivationNumbers()[1] ?? 0)} base64 characters per image)`
      : valueCell(spec),
    'the app',
    'a limit',
  ]);
  change(rows);
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [
    '# Operations',
    '',
    '## Limits outside the repository',
    '',
    `Whatever sits in front of the app must allow request bodies of at least ${group(LIMITS.body.importRequestBytes)} bytes.`,
    '',
    '| Limit | Value | Enforced by | Constrains |',
    '|---|---|---|---|',
    body,
    '',
    '## Nederlands',
    '',
    `Het grootste verzoek is ${String(LIMITS.body.importRequestBytes)} bytes.`,
    '',
  ].join('\n');
}

describe('limits-doc guard (negative fixtures, tasks.md section 0.3)', () => {
  it('accepts a document built from LIMITS', () => {
    expect(() => {
      assertLimitsDocument(buildDocument());
    }).not.toThrow();
  });

  it('fails when one number is altered', () => {
    const altered = buildDocument((rows) => {
      const row = rows[0];
      if (row === undefined) throw new Error('fixture error');
      row[1] = group(LIMITS.body.jsonBytes + 1);
    });
    expectGuardFails(assertLimitsDocument, altered, { reason: /does not state 262144/ });
  });

  it('fails when the largest request is altered by one byte', () => {
    const altered = buildDocument((rows) => {
      const row = rows[3];
      if (row === undefined) throw new Error('fixture error');
      row[1] =
        row[1]?.replace(
          group(LIMITS.body.importRequestBytes),
          group(LIMITS.body.importRequestBytes - 1),
        ) ?? '';
    });
    expectGuardFails(assertLimitsDocument, altered, { reason: /does not state 9437184/ });
  });

  it('fails on a stray large number that is no limit', () => {
    const altered = buildDocument((rows) => {
      const row = rows[4];
      if (row === undefined) throw new Error('fixture error');
      row[3] = 'and 123,456 more';
    });
    expectGuardFails(assertLimitsDocument, altered, {
      reason: /123456, which is no value of LIMITS/,
    });
  });

  it('fails when a rate is stated per refill interval instead of per second', () => {
    const altered = buildDocument((rows) => {
      const row = rows.find((candidate) => candidate[0] === 'Rate limit write');
      if (row === undefined) throw new Error('fixture error');
      row[1] = `10 / ${String(LIMITS.rateLimit.write.refillIntervalMs)}`;
    });
    expectGuardFails(assertLimitsDocument, altered, { reason: /does not state 0\.5/ });
  });

  it('fails when a row is missing', () => {
    const altered = buildDocument((rows) => {
      rows.splice(10, 1);
    });
    expectGuardFails(assertLimitsDocument, altered, {
      reason: /has no row "Image job time budget"/,
    });
  });

  it('fails on a row spec 6.5 does not have', () => {
    const altered = buildDocument((rows) => {
      rows.push(['Something new', '1', 'the app', 'nothing']);
    });
    expectGuardFails(assertLimitsDocument, altered, { reason: /does not have: "Something new"/ });
  });

  it('fails when "enforced by" is empty', () => {
    const altered = buildDocument((rows) => {
      const row = rows[1];
      if (row === undefined) throw new Error('fixture error');
      row[2] = ' ';
    });
    expectGuardFails(assertLimitsDocument, altered, { reason: /empty "enforced by"/ });
  });

  it('fails without the sentence about what sits in front', () => {
    const altered = buildDocument().replace(/Whatever sits in front[^\n]*\n/, '');
    expectGuardFails(assertLimitsDocument, altered, { reason: /lacks the sentence/ });
  });

  it('fails without the Dutch section', () => {
    const altered = buildDocument().replace(/## Nederlands[\s\S]*$/, '');
    expectGuardFails(assertLimitsDocument, altered, { reason: /no Dutch section/ });
  });

  it('fails on the skeleton table with the placeholder row', () => {
    const skeleton = readFileSync(join(fixtureDirectory, 'operations-limits-skeleton.md'), 'utf8');
    expectGuardFails(assertLimitsDocument, skeleton, { reason: /has no row "JSON request body"/ });
  });
});

describe('docs/operations.md limits table (FR-A-182)', () => {
  it('equals LIMITS row by row, states the largest request and has a Dutch section', () => {
    let markdown: string;
    try {
      markdown = readFileSync(join(repositoryRoot, 'docs/operations.md'), 'utf8');
    } catch {
      throw new Error('docs/operations.md is missing (T-A-277)');
    }
    assertLimitsDocument(markdown);
  });
});
