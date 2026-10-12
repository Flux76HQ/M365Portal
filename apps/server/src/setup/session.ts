// The setup session (T-B-125, FR-B-205, plan 9.3): what `POST /api/v1/setup/unlock` hands out.
//
// A random 256-bit id (43 base64url characters) in the `setup` cookie. The server keeps only its
// SHA-256 hash, in memory: idle 60 minutes (sliding), absolute 8 hours, at most 5 live sessions (the
// oldest is evicted), and a restart ends them all, so the operator unlocks again. The registry is the
// `SetupSessionReader` of the policy layer: the actor exists only for a session that is live while the
// setup is open. `onEmpty` runs when the last session ends or expires, which is where the bootstrap
// object is discarded (FR-B-215c).
import { LIMITS } from '@m365portal/shared/limits';
import { newCookieId } from '../auth/cookies.js';
import type { RandomSource } from '../ports/clock.js';
import type { SetupSessionReader, SetupSessionRecord } from '../policy/index.js';
import { hashSessionId } from '../policy/session-hash.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export type EmptyReason = 'ended' | 'expired';

export interface CreatedSetupSession {
  /** The cookie value: shown to the browser once and never kept. */
  readonly id: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface SetupSessions extends SetupSessionReader {
  create(): CreatedSetupSession;
  /** Slide the idle deadline of a live session. */
  touch(idHash: string): void;
  /** The two deadlines of a live session. */
  info(
    idHash: string,
  ): { readonly idleExpiresAt: string; readonly absoluteExpiresAt: string } | undefined;
  /** End one session at once. `last` is true when it was the last live one. */
  end(idHash: string): { readonly ended: boolean; readonly last: boolean };
  /** End every session (the state became `completed`, or setup was reopened). */
  endAll(): void;
  /** Remove the expired ones; runs `onEmpty('expired')` when that emptied the registry. */
  sweep(): { readonly expired: number };
  count(): number;
}

export interface SetupSessionsOptions {
  readonly now: () => number;
  readonly random: RandomSource;
  /** Is setup open (the state is not `completed`)? Read on every lookup. */
  readonly isOpen: () => boolean;
  readonly onEmpty?: (reason: EmptyReason) => void;
}

interface Entry {
  readonly createdAt: number;
  lastSeenAt: number;
}

export function createSetupSessions(options: SetupSessionsOptions): SetupSessions {
  const idleMs = LIMITS.setup.sessionIdleMinutes * MINUTE_MS;
  const absoluteMs = LIMITS.setup.sessionAbsoluteHours * HOUR_MS;
  const entries = new Map<string, Entry>();

  const alive = (entry: Entry, now: number): boolean =>
    now - entry.lastSeenAt < idleMs && now - entry.createdAt < absoluteMs;

  function emptied(reason: EmptyReason): void {
    options.onEmpty?.(reason);
  }

  return {
    create() {
      const now = options.now();
      const id = newCookieId(options.random);
      entries.set(hashSessionId(id), { createdAt: now, lastSeenAt: now });
      // Evict the oldest beyond the maximum.
      while (entries.size > LIMITS.setup.sessionsMax) {
        const oldest = [...entries].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
        if (oldest === undefined) break;
        entries.delete(oldest[0]);
      }
      return {
        id,
        idleExpiresAt: new Date(now + idleMs).toISOString(),
        absoluteExpiresAt: new Date(now + absoluteMs).toISOString(),
      };
    },

    find(idHash): SetupSessionRecord | undefined {
      if (!options.isOpen()) return undefined;
      const entry = entries.get(idHash);
      if (entry === undefined || !alive(entry, options.now())) return undefined;
      return { createdAt: new Date(entry.createdAt).toISOString() };
    },

    touch(idHash) {
      const entry = entries.get(idHash);
      const now = options.now();
      if (entry !== undefined && alive(entry, now)) entry.lastSeenAt = now;
    },

    info(idHash) {
      const entry = entries.get(idHash);
      if (entry === undefined || !alive(entry, options.now())) return undefined;
      return {
        idleExpiresAt: new Date(
          Math.min(entry.lastSeenAt + idleMs, entry.createdAt + absoluteMs),
        ).toISOString(),
        absoluteExpiresAt: new Date(entry.createdAt + absoluteMs).toISOString(),
      };
    },

    end(idHash) {
      const ended = entries.delete(idHash);
      const last = ended && entries.size === 0;
      if (last) emptied('ended');
      return { ended, last };
    },

    endAll() {
      const had = entries.size > 0;
      entries.clear();
      if (had) emptied('ended');
    },

    sweep() {
      const now = options.now();
      let expired = 0;
      for (const [hash, entry] of entries) {
        if (!alive(entry, now)) {
          entries.delete(hash);
          expired += 1;
        }
      }
      if (expired > 0 && entries.size === 0) emptied('expired');
      return { expired };
    },

    count: () => entries.size,
  };
}
