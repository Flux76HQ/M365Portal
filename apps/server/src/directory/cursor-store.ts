// The cursor store of the directory lists (T-C-018, FR-C-103, FR-C-108, plan 5.3, PC-02): the cursor
// the browser sees is a random handle, and everything it stands for stays here, in memory:
//
//   - the handle is 18 random bytes from the injected `RandomSource`, base64url: 24 characters, 144 bits;
//   - an entry belongs to the actor it was made for. `take` for any other actor, for an expired entry
//     and for an unknown handle is the same answer, `null`, so a handle cannot be probed;
//   - an entry lives `ttlSeconds` after it was made or last used (the clock is injected), and the store
//     holds at most `maxEntries`: the least recently used goes first;
//   - a handle can be used again (a page may be asked for twice): `take` refreshes the entry.
//
// The state holds Graph's `@odata.nextLink` (as a `PageToken`) and the resume position inside a Graph
// page. It never reaches a browser and is lost on restart: a lost cursor is `cursor_invalid`, and the UI
// starts the list again (nothing is stored on disk).
import { LIMITS } from '@m365portal/shared/limits';
import type { Clock, RandomSource } from '../ports/clock.js';
import type { PageToken } from '../ports/graph.js';

/** Where a list resumes: the Graph page by its token (`null`: the first page) and the rows of it already handed out. */
export interface CursorState {
  /** Which list the cursor belongs to (`users.list`, `groups.members`): a cursor is not valid on another route. */
  readonly route: string;
  /** The canonical form of the parameters it was made for: a changed filter is not a continuation. */
  readonly key: string;
  readonly pageToken: PageToken | null;
  /** Rows of that Graph page that the earlier pages consumed (handed out or skipped). */
  readonly skip: number;
}

export interface CursorStore {
  /** Stores `state` for `actorId` and returns the handle the browser gets. */
  put(actorId: string, state: CursorState): string;
  /** The state of a handle that belongs to `actorId` and is alive, otherwise `null`. Refreshes the entry. */
  take(actorId: string, handle: string): CursorState | null;
  /** Entries held right now. */
  readonly size: number;
}

export interface CursorStoreOptions {
  readonly clock: Clock;
  readonly random: RandomSource;
  /** Default `LIMITS.directory.cursorTtlSeconds`. */
  readonly ttlSeconds?: number;
  /** Default `LIMITS.directory.cursorEntries`. */
  readonly maxEntries?: number;
}

/** 18 bytes: 24 base64url characters. */
const HANDLE_BYTES = 18;

interface Entry {
  readonly actorId: string;
  readonly state: CursorState;
  expiresAt: number;
}

export function createCursorStore(options: CursorStoreOptions): CursorStore {
  const ttlMs = (options.ttlSeconds ?? LIMITS.directory.cursorTtlSeconds) * 1000;
  const maxEntries = options.maxEntries ?? LIMITS.directory.cursorEntries;
  // A Map keeps insertion order: the first key is the least recently used one.
  const entries = new Map<string, Entry>();

  /** Forgets what has expired. Every use moves an entry to the end, so the front expires first. */
  function sweep(now: number): void {
    for (const [handle, entry] of entries) {
      if (entry.expiresAt > now) break;
      entries.delete(handle);
    }
  }

  function newHandle(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const bytes = options.random.bytes(HANDLE_BYTES);
      if (bytes.length !== HANDLE_BYTES) throw new RangeError('a cursor needs 18 random bytes');
      const handle = Buffer.from(bytes).toString('base64url');
      if (!entries.has(handle)) return handle;
    }
    // 144 bits colliding four times in a row is not chance: a broken random source.
    throw new Error('the random source repeats itself');
  }

  return {
    put(actorId, state) {
      const now = options.clock.now();
      sweep(now);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      const handle = newHandle();
      entries.set(handle, { actorId, state, expiresAt: now + ttlMs });
      return handle;
    },

    take(actorId, handle) {
      const now = options.clock.now();
      sweep(now);
      const entry = entries.get(handle);
      if (entry?.actorId !== actorId) return null;
      // A use refreshes the entry and makes it the most recently used.
      entries.delete(handle);
      entry.expiresAt = now + ttlMs;
      entries.set(handle, entry);
      return entry.state;
    },

    get size() {
      return entries.size;
    },
  };
}
