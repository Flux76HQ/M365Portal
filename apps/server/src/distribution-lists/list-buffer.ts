// The list buffer of the Exchange lists (T-D-118, plan 5.2, PD-03, FR-D-202): the worker has no server-side
// cursor, so a list (the distribution lists, the mail contacts, the lists of one contact) is read ONCE
// into a buffer, and the pages are slices of it. The cursor the browser sees is a random handle:
//
//   - 18 random bytes from the injected `RandomSource`, base64url, as the cursor store of Phase C;
//   - a buffer and a handle belong to the actor they were made for. `take` for any other actor, for an
//     expired handle and for an unknown handle is the same answer, `null`;
//   - a handle names a buffer, a route, the canonical key of the parameters and an offset. The rows are
//     shared by every handle of the buffer (a page may be asked twice), so a handle costs a few bytes;
//   - a buffer lives `ttlSeconds` after it was made or last used (the clock is injected). The rows held
//     are bounded in all: when `rowBudget` would be exceeded the least recently used buffers go first;
//     handles to a buffer that is gone answer `null`, which is `cursor_invalid` and "start again";
//   - a buffer holds at most `LIMITS.exchange.listBufferMax` rows. The caller refuses a larger result
//     with the "narrow your search" answer; `put` throws if it is asked to hold more.
//
// Nothing here is persisted: the buffer is process memory and is lost on restart (as the cursors of
// Phase C). The rows are Exchange data (names, addresses): they are never logged.
import { LIMITS } from '@m365portal/shared/limits';
import type { Clock, RandomSource } from '../ports/clock.js';

export interface BufferedPage<Row> {
  /** The route the handle was made on, e.g. `distributionLists.list`. */
  readonly route: string;
  /** The canonical text of the parameters it stands for (see `keyOf`). */
  readonly key: string;
  readonly rows: readonly Row[];
  /** The index of the first row of the next page. */
  readonly offset: number;
}

export interface ListBufferStore {
  /** Buffers `rows` for `actorId` and returns the handle of the page that starts at `offset`; `null` at the end. */
  put(
    actorId: string,
    entry: { route: string; key: string; rows: readonly unknown[]; offset: number },
  ): string | null;
  /** The buffered page a handle stands for, when it belongs to `actorId` and is alive. Refreshes it. */
  take<Row>(actorId: string, handle: string): BufferedPage<Row> | null;
  /** Another handle for the same buffer at another offset; `null` when the offset is past the end. */
  next(actorId: string, handle: string, offset: number): string | null;
  /** Buffers held right now. */
  readonly buffers: number;
  /** Handles held right now. */
  readonly handles: number;
}

export interface ListBufferOptions {
  readonly clock: Clock;
  readonly random: RandomSource;
  /** Default `LIMITS.directory.cursorTtlSeconds`. */
  readonly ttlSeconds?: number;
  /** Handles kept at most. Default `LIMITS.directory.cursorEntries`. */
  readonly maxHandles?: number;
  /** Rows held in all buffers together. Default four full buffers. */
  readonly rowBudget?: number;
}

const HANDLE_BYTES = 18;

interface Held {
  readonly actorId: string;
  readonly route: string;
  readonly key: string;
  readonly rows: readonly unknown[];
  expiresAt: number;
}

interface Handle {
  readonly bufferId: string;
  readonly offset: number;
}

export function createListBufferStore(options: ListBufferOptions): ListBufferStore {
  const ttlMs = (options.ttlSeconds ?? LIMITS.directory.cursorTtlSeconds) * 1000;
  const maxHandles = options.maxHandles ?? LIMITS.directory.cursorEntries;
  const rowBudget = options.rowBudget ?? LIMITS.exchange.listBufferMax * 4;
  // Map keeps insertion order: the first key is the least recently used one.
  const buffers = new Map<string, Held>();
  const handles = new Map<string, Handle>();
  let rowsHeld = 0;

  function randomId(): string {
    const bytes = options.random.bytes(HANDLE_BYTES);
    if (bytes.length !== HANDLE_BYTES) throw new RangeError('a handle needs 18 random bytes');
    return Buffer.from(bytes).toString('base64url');
  }

  function freshId(taken: (id: string) => boolean): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = randomId();
      if (!taken(id)) return id;
    }
    throw new Error('the random source repeats itself');
  }

  function dropBuffer(id: string): void {
    const buffer = buffers.get(id);
    if (buffer === undefined) return;
    rowsHeld -= buffer.rows.length;
    buffers.delete(id);
  }

  function sweep(now: number): void {
    for (const [id, buffer] of buffers) {
      if (buffer.expiresAt > now) break;
      dropBuffer(id);
    }
    for (const [handle, entry] of handles) {
      if (!buffers.has(entry.bufferId)) handles.delete(handle);
    }
  }

  function touch(id: string, buffer: Held, now: number): void {
    buffer.expiresAt = now + ttlMs;
    buffers.delete(id);
    buffers.set(id, buffer);
  }

  function addHandle(bufferId: string, offset: number): string {
    while (handles.size >= maxHandles) {
      const oldest = handles.keys().next();
      if (oldest.done === true) break;
      handles.delete(oldest.value);
    }
    const handle = freshId((id) => handles.has(id));
    handles.set(handle, { bufferId, offset });
    return handle;
  }

  function lookup(
    actorId: string,
    handle: string,
  ): { id: string; buffer: Held; entry: Handle } | null {
    const entry = handles.get(handle);
    if (entry === undefined) return null;
    const buffer = buffers.get(entry.bufferId);
    if (buffer?.actorId !== actorId) return null;
    return { id: entry.bufferId, buffer, entry };
  }

  return {
    put(actorId, entry) {
      const now = options.clock.now();
      sweep(now);
      if (entry.rows.length > LIMITS.exchange.listBufferMax) {
        throw new RangeError('a list buffer holds at most LIMITS.exchange.listBufferMax rows');
      }
      if (entry.offset >= entry.rows.length) return null;
      while (rowsHeld + entry.rows.length > rowBudget && buffers.size > 0) {
        const oldest = buffers.keys().next();
        if (oldest.done === true) break;
        dropBuffer(oldest.value);
      }
      const id = freshId((candidate) => buffers.has(candidate));
      buffers.set(id, {
        actorId,
        route: entry.route,
        key: entry.key,
        rows: entry.rows,
        expiresAt: now + ttlMs,
      });
      rowsHeld += entry.rows.length;
      return addHandle(id, entry.offset);
    },

    take<Row>(actorId: string, handle: string): BufferedPage<Row> | null {
      const now = options.clock.now();
      sweep(now);
      const found = lookup(actorId, handle);
      if (found === null) return null;
      touch(found.id, found.buffer, now);
      return {
        route: found.buffer.route,
        key: found.buffer.key,
        rows: found.buffer.rows as readonly Row[],
        offset: found.entry.offset,
      };
    },

    next(actorId, handle, offset) {
      const now = options.clock.now();
      sweep(now);
      const found = lookup(actorId, handle);
      if (found === null) return null;
      touch(found.id, found.buffer, now);
      if (offset >= found.buffer.rows.length) return null;
      return addHandle(found.id, offset);
    },

    get buffers() {
      return buffers.size;
    },
    get handles() {
      return handles.size;
    },
  };
}
