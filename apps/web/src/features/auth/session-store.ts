// The small store of what the session needs to tell the page (T-B-295, T-B-296; FR-B-416, FR-B-411):
// the idle deadline of the session and whether a write was refused for a missing step-up.
//
// The idle deadline comes from two places. The header `X-Session-Idle-Expires` of every response carries
// the deadline AFTER the request slid the session, so it always wins. The body of `GET /api/v1/me` reports
// `session.idleExpiresAt` as stored when the request STARTED, which is never later than the header of the
// same response; it seeds the store and can move the deadline forward, never back. A break-glass session
// reports its absolute end, which never slides.
//
// The store is a plain object with `subscribe` and `getSnapshot`, so React reads it with
// `useSyncExternalStore` and a test builds its own. It holds no secret and no identity.
import { IsoTimestampSchema } from '@m365portal/shared/schemas/common';

export interface SessionSnapshot {
  /** The idle deadline in milliseconds since the epoch, or null while none is known. */
  readonly idleExpiresAt: number | null;
  /** A write was refused with `step_up_required` and the person has not answered the dialog yet. */
  readonly stepUpRequested: boolean;
}

export interface SessionStore {
  readonly getSnapshot: () => SessionSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** The header of a response: a valid timestamp replaces the deadline, anything else is ignored. */
  readonly noteIdleHeader: (value: string | null | undefined) => void;
  /** The `session` of `/api/v1/me`: seeds the deadline, never moves it back. */
  readonly noteMeSession: (session: { readonly idleExpiresAt: string } | null) => void;
  readonly requestStepUp: () => void;
  readonly dismissStepUp: () => void;
  /** Forgets everything (a sign-out). */
  readonly reset: () => void;
}

function parsed(value: unknown): number | null {
  const checked = IsoTimestampSchema.safeParse(value);
  return checked.success ? Date.parse(checked.data) : null;
}

export function createSessionStore(): SessionStore {
  let snapshot: SessionSnapshot = { idleExpiresAt: null, stepUpRequested: false };
  const listeners = new Set<() => void>();

  function update(next: Partial<SessionSnapshot>): void {
    const merged = { ...snapshot, ...next };
    if (
      merged.idleExpiresAt === snapshot.idleExpiresAt &&
      merged.stepUpRequested === snapshot.stepUpRequested
    ) {
      return;
    }
    snapshot = merged;
    for (const listener of [...listeners]) listener();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    noteIdleHeader(value) {
      const time = parsed(value);
      if (time === null) return;
      update({ idleExpiresAt: time });
    },
    noteMeSession(session) {
      if (session === null) {
        update({ idleExpiresAt: null });
        return;
      }
      const time = parsed(session.idleExpiresAt);
      if (time === null) return;
      if (snapshot.idleExpiresAt === null || time > snapshot.idleExpiresAt) {
        update({ idleExpiresAt: time });
      }
    },
    requestStepUp() {
      update({ stepUpRequested: true });
    },
    dismissStepUp() {
      update({ stepUpRequested: false });
    },
    reset() {
      update({ idleExpiresAt: null, stepUpRequested: false });
    },
  };
}

let shared: SessionStore | undefined;

/** The store of this page, created on first use. */
export function getSessionStore(): SessionStore {
  shared ??= createSessionStore();
  return shared;
}
