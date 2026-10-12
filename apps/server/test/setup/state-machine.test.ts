// T-B-123: the setup state machine and its repository (FR-B-201, I-B5). The transition table of plan
// 9.1 is tested against the service and, with the service bypassed, against the SQL trigger.
import { SETUP_STATES, type SetupState } from '@m365portal/shared/setup/steps';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import {
  SETUP_EVENTS,
  SETUP_TRANSITIONS,
  SetupStateRepository,
  SetupTransitionError,
  nextSetupState,
  type SetupEvent,
} from '../../src/setup/state.js';
import { createMigratedDatabase } from '../helpers/rbac-db.js';
import { createFakeClock } from '../helpers/fake-clock.js';

const ALLOWED_EDGES: ReadonlySet<string> = new Set([
  'unconfigured>in_progress',
  'in_progress>awaiting_first_signin',
  'awaiting_first_signin>completed',
  'awaiting_first_signin>in_progress',
  'completed>in_progress',
]);

/** The seeded random source: 16 fixed bytes, so the install id is known. */
const random = {
  bytes: (n: number): Uint8Array => new Uint8Array(n).fill(0xab),
  float: (): number => 0.5,
};

async function repository() {
  const db = await createMigratedDatabase();
  const clock = createFakeClock();
  const repo = new SetupStateRepository({ now: () => clock.nowMs(), random });
  return { db, repo, clock };
}

function force(
  db: { sqlite: { prepare(sql: string): { run(...p: unknown[]): unknown } } },
  state: SetupState,
): void {
  // Bypasses the service on purpose, but along allowed edges only, so the trigger lets it through.
  const path: Record<SetupState, readonly SetupState[]> = {
    unconfigured: [],
    in_progress: ['in_progress'],
    awaiting_first_signin: ['in_progress', 'awaiting_first_signin'],
    completed: ['in_progress', 'awaiting_first_signin', 'completed'],
  };
  for (const step of path[state]) {
    if (step === 'completed') {
      db.sqlite
        .prepare("UPDATE setup_state SET state = ?, completed_at = '2026-10-10T12:00:00.000Z'")
        .run(step);
    } else if (step === 'in_progress' && state !== 'in_progress') {
      db.sqlite.prepare("UPDATE setup_state SET state = 'in_progress', completed_at = NULL").run();
    } else {
      db.sqlite.prepare('UPDATE setup_state SET state = ?, completed_at = NULL').run(step);
    }
  }
}

describe('the transition table (plan 9.1)', () => {
  it('has the five edges and no other', () => {
    const edges = SETUP_TRANSITIONS.flatMap((row) =>
      row.from.filter((from) => from !== row.to).map((from) => `${from}>${row.to}`),
    );
    expect(new Set(edges)).toEqual(ALLOWED_EDGES);
    // The one self-loop is a later unlock while the wizard is open.
    expect(SETUP_TRANSITIONS.filter((row) => row.from.includes(row.to))).toEqual([
      { event: 'unlock', from: ['in_progress'], to: 'in_progress' },
    ]);
  });

  it('the service allows exactly the edges, for every state and every event', () => {
    for (const from of SETUP_STATES) {
      for (const event of SETUP_EVENTS) {
        let to: SetupState | undefined;
        try {
          to = nextSetupState(from, event);
        } catch (failure) {
          expect(failure).toBeInstanceOf(SetupTransitionError);
        }
        if (to !== undefined && to !== from) expect(ALLOWED_EDGES.has(`${from}>${to}`)).toBe(true);
      }
    }
    expect(nextSetupState('unconfigured', 'unlock')).toBe('in_progress');
    expect(nextSetupState('in_progress', 'unlock')).toBe('in_progress');
    expect(nextSetupState('in_progress', 'finish')).toBe('awaiting_first_signin');
    expect(nextSetupState('awaiting_first_signin', 'complete')).toBe('completed');
    expect(nextSetupState('completed', 'reopen')).toBe('in_progress');
    expect(nextSetupState('awaiting_first_signin', 'reopen')).toBe('in_progress');
  });

  it.each([
    ['unconfigured', 'finish'],
    ['unconfigured', 'complete'],
    ['unconfigured', 'reopen'],
    ['in_progress', 'complete'],
    ['awaiting_first_signin', 'unlock'],
    ['awaiting_first_signin', 'finish'],
    ['completed', 'unlock'],
    ['completed', 'finish'],
    ['completed', 'complete'],
  ] as const)('refuses %s + %s', (from, event) => {
    expect(() => nextSetupState(from, event)).toThrow(SetupTransitionError);
  });

  it('with the service bypassed the SQL trigger refuses every forbidden edge and allows the others', async () => {
    for (const from of SETUP_STATES) {
      for (const to of SETUP_STATES) {
        if (from === to) continue;
        const { db } = await repository();
        db.sqlite
          .prepare(
            "INSERT INTO setup_state (id, state, mode, install_id, updated_at) VALUES (1, 'unconfigured', 'automatic', ?, '2026-10-10T12:00:00.000Z')",
          )
          .run('0123456789abcdef0123456789abcdef');
        force(db, from);
        const completedAt = to === 'completed' ? "'2026-10-10T12:00:00.000Z'" : 'NULL';
        const move = (): unknown =>
          db.sqlite
            .prepare(`UPDATE setup_state SET state = ?, completed_at = ${completedAt}`)
            .run(to);
        if (ALLOWED_EDGES.has(`${from}>${to}`)) expect(move, `${from}>${to}`).not.toThrow();
        else expect(move, `${from}>${to}`).toThrow(/may only move forward/);
      }
    }
  });

  it('a service that allows unconfigured -> completed fails the table (negative)', () => {
    const lenient = (from: SetupState, event: SetupEvent): SetupState =>
      from === 'unconfigured' && event === 'complete' ? 'completed' : nextSetupState(from, event);
    const checkTable = (service: typeof nextSetupState): void => {
      for (const from of SETUP_STATES) {
        for (const event of SETUP_EVENTS) {
          let to: SetupState | undefined;
          try {
            to = service(from, event);
          } catch {
            continue;
          }
          if (to !== from && !ALLOWED_EDGES.has(`${from}>${to}`)) {
            throw new Error(`the table is broken: ${from} + ${event} -> ${to}`);
          }
        }
      }
    };
    expect(() => {
      checkTable(nextSetupState);
    }).not.toThrow();
    expectGuardFails(checkTable, lenient, { reason: 'the table is broken' });
  });
});

describe('the repository', () => {
  it('ensure creates the singleton as unconfigured with a 128-bit install id of 32 hex, once', async () => {
    const { db, repo } = await repository();
    repo.ensure(db);
    const row = repo.read(db);
    expect(row.state).toBe('unconfigured');
    expect(row.mode).toBe('automatic');
    expect(row.installId).toBe('ab'.repeat(16));
    expect(row.installId).toMatch(/^[0-9a-f]{32}$/);
    // A second call keeps the row, and so the id.
    const other = new SetupStateRepository({
      now: () => 1,
      random: { bytes: (n) => new Uint8Array(n).fill(0x01), float: () => 0 },
    });
    other.ensure(db);
    expect(other.read(db).installId).toBe('ab'.repeat(16));
  });

  it('applies the events, keeps completed_at non-null exactly when completed, and the state is never cached', async () => {
    const { db, repo, clock } = await repository();
    repo.ensure(db);
    const run = (event: SetupEvent): SetupState =>
      withTransaction(db, (tx) => repo.apply(tx, event).to);
    expect(run('unlock')).toBe('in_progress');
    expect(run('unlock')).toBe('in_progress');
    expect(repo.read(db).completedAt).toBeNull();
    expect(run('finish')).toBe('awaiting_first_signin');
    expect(repo.read(db).completedAt).toBeNull();
    clock.advance(1000);
    expect(run('complete')).toBe('completed');
    const completed = repo.read(db);
    expect(completed.completedAt).toBe(clock.iso());
    // A CLI reopen (another connection, here: raw SQL) takes effect at once: no cache.
    db.sqlite.prepare("UPDATE setup_state SET state = 'in_progress', completed_at = NULL").run();
    expect(repo.read(db).state).toBe('in_progress');
    expect(repo.read(db).completedAt).toBeNull();
    expect(() => run('complete')).toThrow(SetupTransitionError);
    expect(repo.read(db).state).toBe('in_progress');
  });

  it('reopen clears completed_at in one update', async () => {
    const { db, repo } = await repository();
    repo.ensure(db);
    withTransaction(db, (tx) => {
      repo.apply(tx, 'unlock');
      repo.apply(tx, 'finish');
      repo.apply(tx, 'complete');
    });
    const result = withTransaction(db, (tx) => repo.apply(tx, 'reopen'));
    expect(result).toEqual({ from: 'completed', to: 'in_progress' });
    expect(repo.read(db).completedAt).toBeNull();
  });

  it('stores the mode, the proposed tenant, the designated owner and the language', async () => {
    const { db, repo } = await repository();
    repo.ensure(db);
    withTransaction(db, (tx) => {
      repo.setMode(tx, 'manual');
      repo.setProposedTenant(tx, '11111111-1111-4111-8111-111111111111');
      repo.setDesignatedOwner(tx, '22222222-2222-4222-8222-222222222222');
      repo.setLanguage(tx, 'nl');
    });
    const row = repo.read(db);
    expect(row).toMatchObject({
      mode: 'manual',
      proposedTenantId: '11111111-1111-4111-8111-111111111111',
      designatedOwnerOid: '22222222-2222-4222-8222-222222222222',
      defaultLanguage: 'nl',
    });
  });

  it('read fails with a named error when the row is missing', async () => {
    const { db, repo } = await repository();
    expect(() => repo.read(db)).toThrow(/setup_state/);
  });
});
