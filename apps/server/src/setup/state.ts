// The setup state machine and its repository (T-B-123, FR-B-201, I-B5, plan 9.1).
//
// `setup_state` is one row. Its `state` moves only along the edges of plan 9.1:
//
//   unconfigured -> in_progress              unlock (the first successful one)
//   in_progress -> in_progress               a later unlock (no change)
//   in_progress -> awaiting_first_signin     finish
//   awaiting_first_signin -> completed       complete (the first sign-in of the designated Owner)
//   awaiting_first_signin | completed -> in_progress    reopen (the command line only)
//
// The service (`nextSetupState`) is the first line of defence, the SQL trigger `setup_state_transition`
// the second. `SetupStateRepository` is the only writer of `setup_state` after the singleton exists;
// every write takes a `Tx`, so the change commits with the audit entry the caller writes beside it.
// The state is read from the database on every call and cached nowhere, so a reopen from another
// process takes effect at once.
import type { SetupMode, SetupState } from '@m365portal/shared/setup/steps';
import type { DatabaseHandle } from '../db/index.js';
import type { Tx } from '../db/tx.js';
import type { RandomSource } from '../ports/clock.js';

export type SetupEvent = 'unlock' | 'finish' | 'complete' | 'reopen';

export const SETUP_EVENTS: readonly SetupEvent[] = Object.freeze([
  'unlock',
  'finish',
  'complete',
  'reopen',
]);

interface Transition {
  readonly event: SetupEvent;
  readonly from: readonly SetupState[];
  readonly to: SetupState;
}

/** The edges of plan 9.1 (the self-loop of a later unlock is `unlock` from `in_progress`). */
export const SETUP_TRANSITIONS: readonly Transition[] = Object.freeze([
  { event: 'unlock', from: ['unconfigured'], to: 'in_progress' },
  { event: 'unlock', from: ['in_progress'], to: 'in_progress' },
  { event: 'finish', from: ['in_progress'], to: 'awaiting_first_signin' },
  { event: 'complete', from: ['awaiting_first_signin'], to: 'completed' },
  { event: 'reopen', from: ['awaiting_first_signin', 'completed'], to: 'in_progress' },
]);

/** The state change is not an edge of the table. Carries the two names and nothing else. */
export class SetupTransitionError extends Error {
  readonly code = 'setup_transition_refused';
  readonly from: SetupState;
  readonly event: SetupEvent;

  constructor(from: SetupState, event: SetupEvent) {
    super(`the setup state ${from} does not accept ${event}`);
    this.name = 'SetupTransitionError';
    this.from = from;
    this.event = event;
  }
}

/** The state after `event` from `from`, or a `SetupTransitionError`. Pure. */
export function nextSetupState(from: SetupState, event: SetupEvent): SetupState {
  const edge = SETUP_TRANSITIONS.find((row) => row.event === event && row.from.includes(from));
  if (edge === undefined) throw new SetupTransitionError(from, event);
  return edge.to;
}

export interface SetupStateRow {
  readonly state: SetupState;
  readonly mode: SetupMode;
  /** 128 random bits as 32 lower-case hexadecimal characters. */
  readonly installId: string;
  readonly designatedOwnerOid: string | null;
  readonly proposedTenantId: string | null;
  readonly defaultLanguage: 'nl' | 'en' | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

interface RawRow {
  state: SetupState;
  mode: SetupMode;
  install_id: string;
  designated_owner_oid: string | null;
  proposed_tenant_id: string | null;
  default_language: 'nl' | 'en' | null;
  completed_at: string | null;
  updated_at: string;
}

export class SetupStateMissingError extends Error {
  readonly code = 'setup_state_missing';

  constructor() {
    super('the setup_state row does not exist');
    this.name = 'SetupStateMissingError';
  }
}

export interface SetupStateDeps {
  readonly now: () => number;
  readonly random: RandomSource;
}

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

export class SetupStateRepository {
  readonly #deps: SetupStateDeps;

  constructor(deps: SetupStateDeps) {
    this.#deps = deps;
  }

  /** `INSERT OR IGNORE` of the singleton: `unconfigured`, `automatic`, a fresh install id. */
  ensure(db: DatabaseHandle): void {
    const installId = Buffer.from(this.#deps.random.bytes(16)).toString('hex');
    db.sqlite
      .prepare(
        "INSERT OR IGNORE INTO setup_state (id, state, mode, install_id, updated_at) VALUES (1, 'unconfigured', 'automatic', ?, ?)",
      )
      .run(installId, iso(this.#deps.now()));
  }

  /** The row, read now. Throws `SetupStateMissingError` when there is none. */
  read(db: DatabaseHandle): SetupStateRow {
    const row = db.sqlite.prepare('SELECT * FROM setup_state WHERE id = 1').get() as
      | RawRow
      | undefined;
    if (row === undefined) throw new SetupStateMissingError();
    return {
      state: row.state,
      mode: row.mode,
      installId: row.install_id,
      designatedOwnerOid: row.designated_owner_oid,
      proposedTenantId: row.proposed_tenant_id,
      defaultLanguage: row.default_language,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    };
  }

  /** The state alone, or `undefined` without a database or a row. */
  stateOf(db: DatabaseHandle | undefined): SetupState | undefined {
    if (db === undefined) return undefined;
    try {
      return this.read(db).state;
    } catch {
      return undefined;
    }
  }

  /** Apply `event` inside the caller's transaction. Returns the two states. */
  apply(tx: Tx, event: SetupEvent): { readonly from: SetupState; readonly to: SetupState } {
    const { state: from } = this.read(tx);
    const to = nextSetupState(from, event);
    const now = iso(this.#deps.now());
    if (to === from) return { from, to };
    if (to === 'completed') {
      tx.sqlite
        .prepare("UPDATE setup_state SET state = 'completed', completed_at = ?, updated_at = ? WHERE id = 1")
        .run(now, now);
    } else {
      tx.sqlite
        .prepare('UPDATE setup_state SET state = ?, completed_at = NULL, updated_at = ? WHERE id = 1')
        .run(to, now);
    }
    return { from, to };
  }

  setMode(tx: Tx, mode: SetupMode): void {
    this.#set(tx, 'mode', mode);
  }

  setProposedTenant(tx: Tx, tenantId: string | null): void {
    this.#set(tx, 'proposed_tenant_id', tenantId);
  }

  setDesignatedOwner(tx: Tx, oid: string | null): void {
    this.#set(tx, 'designated_owner_oid', oid);
  }

  setLanguage(tx: Tx, language: 'nl' | 'en' | null): void {
    this.#set(tx, 'default_language', language);
  }

  #set(
    tx: Tx,
    column: 'mode' | 'proposed_tenant_id' | 'designated_owner_oid' | 'default_language',
    value: string | null,
  ): void {
    // The column name comes from the closed union above, never from a caller's string.
    tx.sqlite
      .prepare(`UPDATE setup_state SET ${column} = ?, updated_at = ? WHERE id = 1`)
      .run(value, iso(this.#deps.now()));
  }
}
