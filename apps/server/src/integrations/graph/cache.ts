// The short-TTL cache for Graph GET results (FR-B-313): organization 300 s, user 60 s, group 60 s,
// a least-recently-used store of at most 1,000 entries keyed by method, path and sorted query.
//
// Only a success is ever stored (the caller stores after a 2xx; an error never reaches `set`). A
// hit hands out a copy, so a caller that edits what it got cannot change what the next one reads.
// Time is the injected clock: an entry is valid while `now < storedAt + ttl`, so at exactly the TTL
// it has expired.
import { LIMITS } from '@m365portal/shared/limits';
import type { Clock } from '../../ports/clock.js';

const LIMIT = LIMITS.microsoft;

/** The TTLs of FR-B-313, in milliseconds. */
export const GRAPH_CACHE_TTL_MS = Object.freeze({
  organization: LIMIT.graphCacheTtlSeconds.organization * 1000,
  user: LIMIT.graphCacheTtlSeconds.user * 1000,
  group: LIMIT.graphCacheTtlSeconds.group * 1000,
} as const);

export const GRAPH_CACHE_ENTRIES = LIMIT.graphCacheEntries;

interface Entry {
  readonly body: unknown;
  readonly expiresAt: number;
}

export class GraphCache {
  readonly #clock: Clock;
  readonly #max: number;
  /** A `Map` keeps insertion order: the first key is the least recently used. */
  readonly #entries = new Map<string, Entry>();

  constructor(clock: Clock, maxEntries: number = GRAPH_CACHE_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('a cache holds at least one entry');
    }
    this.#clock = clock;
    this.#max = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** A copy of the stored body, or `undefined` when there is none or it has expired. */
  get(key: string): { readonly body: unknown } | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (this.#clock.now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    // Reading makes it the most recently used.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return { body: structuredClone(entry.body) };
  }

  set(key: string, body: unknown, ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
      throw new RangeError('a TTL is a positive whole number of ms');
    this.#entries.delete(key);
    this.#entries.set(key, { body: structuredClone(body), expiresAt: this.#clock.now() + ttlMs });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** `GET /users/abc?$select=id&$top=1`: method, path and the query already sorted by `buildQuery`. */
export function cacheKey(method: string, pathAndQuery: string): string {
  return `${method} ${pathAndQuery}`;
}
