// T-B-127: the live log (FR-B-211, I-B9). Rows carry a message key and scalar parameters, never
// translated text and never a secret; 1,000 are kept; reads are cursor pages.
import { LOG_KEYS } from '@m365portal/shared/setup/log-keys';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import { SetupLog, LogWriteError } from '../../src/setup/log.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createMigratedDatabase } from '../helpers/rbac-db.js';

async function make() {
  const db = await createMigratedDatabase();
  const clock = createFakeClock();
  const log = new SetupLog({ now: () => clock.nowMs() });
  const add = (n = 1, key: keyof typeof LOG_KEYS = 'setup.log.step_started'): void => {
    withTransaction(db, (tx) => {
      for (let i = 0; i < n; i += 1) {
        log.append(tx, {
          step: 'configure',
          level: 'info',
          messageKey: key,
          params: { step: 'configure' },
        });
      }
    });
  };
  return { db, clock, log, add };
}

describe('append', () => {
  it('assigns seq as MAX(seq) + 1 and stores the key and the parameters, nothing else', async () => {
    const { db, log, clock } = await make();
    withTransaction(db, (tx) => {
      expect(
        log.append(tx, {
          step: 'configure',
          level: 'info',
          messageKey: 'setup.log.created',
          params: { kind: 'application', name: 'M365Portal' },
        }),
      ).toBe(1);
      expect(
        log.append(tx, {
          step: 'configure',
          level: 'warn',
          messageKey: 'setup.log.waiting_replication',
          params: { attempt: 2, max: 40, seconds: 7 },
        }),
      ).toBe(2);
    });
    const rows = db.sqlite.prepare('SELECT * FROM setup_log ORDER BY seq').all() as Record<
      string,
      unknown
    >[];
    expect(rows).toEqual([
      {
        seq: 1,
        ts: clock.iso(),
        step: 'configure',
        level: 'info',
        message_key: 'setup.log.created',
        params: '{"kind":"application","name":"M365Portal"}',
      },
      {
        seq: 2,
        ts: clock.iso(),
        step: 'configure',
        level: 'warn',
        message_key: 'setup.log.waiting_replication',
        params: '{"attempt":2,"max":40,"seconds":7}',
      },
    ]);
  });

  it('keeps the newest 1,000 rows: the oldest are trimmed in the same transaction', async () => {
    const { db, add } = await make();
    add(1_005);
    const range = db.sqlite
      .prepare('SELECT count(*) AS n, min(seq) AS low, max(seq) AS high FROM setup_log')
      .get();
    expect(range).toEqual({ n: 1000, low: 6, high: 1005 });
  });

  it('a fault after the append rolls the row back with the rest of the transaction', async () => {
    const { db, log } = await make();
    expect(() =>
      withTransaction(db, (tx) => {
        log.append(tx, {
          step: 'verify',
          level: 'info',
          messageKey: 'setup.log.run_started',
          params: { mode: 'continue', steps: 'verify' },
        });
        throw new Error('fault');
      }),
    ).toThrow('fault');
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM setup_log').get()).toEqual({ n: 0 });
  });

  it.each([
    ['an unknown key', { messageKey: 'setup.log.invented', params: {} }],
    [
      'a parameter the key does not declare',
      { messageKey: 'setup.log.created', params: { kind: 'a', name: 'b', extra: 1 } },
    ],
    [
      'a parameter named secret',
      { messageKey: 'setup.log.created', params: { kind: 'a', secret: 'x' } },
    ],
    [
      'a parameter named token',
      { messageKey: 'setup.log.read', params: { what: 'x', token: 'x' } },
    ],
    [
      'a nested parameter',
      { messageKey: 'setup.log.created', params: { kind: { a: 1 }, name: 'b' } },
    ],
    [
      'a long string',
      { messageKey: 'setup.log.created', params: { kind: 'a', name: 'x'.repeat(257) } },
    ],
    [
      'more than 8 parameters',
      {
        messageKey: 'setup.log.created',
        params: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${String(i)}`, 1])),
      },
    ],
  ])('rejects %s and writes nothing', async (_name, entry) => {
    const { db, log } = await make();
    expect(() => {
      withTransaction(db, (tx) => {
        log.append(tx, { step: 'configure', level: 'info', ...entry } as never);
      });
    }).toThrow(LogWriteError);
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM setup_log').get()).toEqual({ n: 0 });
  });

  it('rejects a level and a step outside the sets', async () => {
    const { db, log } = await make();
    for (const entry of [
      { level: 'debug', step: 'configure' },
      { level: 'info', step: 'nope' },
    ]) {
      expect(() => {
        withTransaction(db, (tx) => {
          log.append(tx, { messageKey: 'setup.log.run_cancelled', params: {}, ...entry } as never);
        });
      }).toThrow(LogWriteError);
    }
  });
});

describe('read', () => {
  it('pages by cursor: after, limit, hasMore and lastSeq', async () => {
    const { db, log, add } = await make();
    add(450);
    const first = log.read(db, { after: 0, limit: 200 });
    expect(first.lines).toHaveLength(200);
    expect(first.lines[0]?.seq).toBe(1);
    expect(first).toMatchObject({ lastSeq: 200, hasMore: true, truncated: false });
    const second = log.read(db, { after: first.lastSeq, limit: 200 });
    expect(second.lines).toHaveLength(200);
    expect(second.hasMore).toBe(true);
    const third = log.read(db, { after: second.lastSeq, limit: 200 });
    expect(third.lines).toHaveLength(50);
    expect(third).toMatchObject({ lastSeq: 450, hasMore: false });
    const none = log.read(db, { after: 450, limit: 10 });
    expect(none).toEqual({ lines: [], lastSeq: 450, hasMore: false, truncated: false });
  });

  it('the lines are the wire shape with the key and scalar parameters', async () => {
    const { db, log, clock } = await make();
    withTransaction(db, (tx) => {
      log.append(tx, {
        step: 'connect',
        level: 'info',
        messageKey: 'setup.log.bootstrap_waiting',
        params: { seconds: 5 },
      });
    });
    expect(log.read(db, { after: 0, limit: 10 }).lines).toEqual([
      {
        seq: 1,
        ts: clock.iso(),
        step: 'connect',
        level: 'info',
        messageKey: 'setup.log.bootstrap_waiting',
        params: { seconds: 5 },
      },
    ]);
  });

  it('says truncated when lines after the cursor were already trimmed', async () => {
    const { db, log, add } = await make();
    add(1_010);
    expect(log.read(db, { after: 0, limit: 5 })).toMatchObject({ truncated: true });
    expect(log.read(db, { after: 3, limit: 5 })).toMatchObject({ truncated: true });
    // A cursor at or past the oldest retained row has lost nothing.
    expect(log.read(db, { after: 10, limit: 5 })).toMatchObject({ truncated: false });
    expect(log.read(db, { after: 11, limit: 5 }).lines[0]?.seq).toBe(12);
  });

  it('validates the limit and the cursor', async () => {
    const { db, log } = await make();
    for (const options of [
      { after: -1, limit: 10 },
      { after: 0, limit: 0 },
      { after: 0, limit: 201 },
      { after: 1.5, limit: 10 },
    ]) {
      expect(() => log.read(db, options)).toThrow(RangeError);
    }
  });

  it('latest() is the last seq written, 0 for an empty log', async () => {
    const { db, log, add } = await make();
    expect(log.latestSeq(db)).toBe(0);
    add(3);
    expect(log.latestSeq(db)).toBe(3);
  });
});
