// T-A-021, contract C3, FR-A-025, FR-A-045, FR-A-182 (source): every number of the limits table of
// spec section 6.5 exists once, in `src/limits.ts`. The server, the tests and `docs/operations.md`
// (compared by `server/limits-doc.test.ts`) all read these constants.
//
// The expected values below are written out again, in the units of the spec (bytes, seconds, hours),
// and compared with the constants by a guard that throws on any difference. The guard is proven
// with negative fixtures (tasks.md section 0.3): a wrong value, a missing value and an extra value.
import { describe, expect, it } from 'vitest';
import { expectGuardFails } from '../src/testing/index.js';
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
  // Image size ceiling: 400 MB uncompressed
  imageSizeCeilingMegabytes: 400,
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
  for (const [path, expected] of Object.entries(SPEC_6_5)) {
    if (!actual.has(path)) problems.push(`missing ${path}`);
    else if (actual.get(path) !== expected) {
      problems.push(`${path} is ${String(actual.get(path))}, the spec says ${String(expected)}`);
    }
  }
  for (const path of actual.keys()) {
    if (!(path in SPEC_6_5)) problems.push(`${path} is not a row of spec 6.5`);
  }
  if (problems.length > 0) throw new Error(`limits differ from spec 6.5: ${problems.join('; ')}`);
}

describe('LIMITS: spec section 6.5', () => {
  it('holds every row of the table with its exact value, and nothing else', () => {
    expect(() => {
      assertSpecTable(LIMITS);
    }).not.toThrow();
  });

  it('has the default port of the container, defined here once (FR-A-016)', () => {
    expect(DEFAULT_PORT).toBe(8080);
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

describe('LIMITS: rate classes', () => {
  it.each<[RateLimitClass, number, number]>([
    ['read', 120, 2],
    ['write', 10, 0.5],
    ['upload', 3, 0.1],
  ])('%s: capacity %d, refill %d per second', (rateClass, capacity, perSecond) => {
    expect(LIMITS.rateLimit[rateClass].capacity).toBe(capacity);
    expect(refillPerSecond(rateClass)).toBe(perSecond);
  });

  it('knows exactly the three classes of the spec', () => {
    expect(Object.keys(LIMITS.rateLimit).sort()).toEqual(['read', 'upload', 'write']);
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
