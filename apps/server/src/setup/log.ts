// The live log of the wizard (T-B-127, FR-B-211, plan 9.6, I-B9): `setup_log`.
//
// A row is `{seq, ts, step, level, messageKey, params}`. It carries a catalogue key from `LOG_KEYS`
// and scalar parameters, never translated text and never a secret: the writer checks the key, the
// parameter names the key declares and the secret-free rules of `LogParamsSchema`. `seq` is
// `MAX(seq) + 1` assigned inside the caller's transaction (no AUTOINCREMENT), and the rows older than
// the newest 1,000 are deleted in the same transaction, so the log never grows past its bound.
import { LIMITS } from '@m365portal/shared/limits';
import { LogParamsSchema } from '@m365portal/shared/schemas/connection';
import { LOG_KEYS, isLogKey, type LogKey } from '@m365portal/shared/setup/log-keys';
import { STEP_KEYS, type StepKey } from '@m365portal/shared/setup/steps';
import type { DatabaseHandle } from '../db/index.js';
import type { Tx } from '../db/tx.js';

export type LogLevel = 'info' | 'warn' | 'error';
const LEVELS: readonly string[] = ['info', 'warn', 'error'];

export type LogParams = Record<string, string | number | boolean>;

export interface LogEntryInput {
  readonly step: StepKey;
  readonly level: LogLevel;
  readonly messageKey: LogKey;
  readonly params: LogParams;
}

export interface LogLineWire {
  readonly seq: number;
  readonly ts: string;
  readonly step: StepKey;
  readonly level: LogLevel;
  readonly messageKey: LogKey;
  readonly params: LogParams;
}

export interface LogWindow {
  readonly lines: LogLineWire[];
  readonly lastSeq: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
}

export type LogWriteProblem = 'step_invalid' | 'level_invalid' | 'key_unknown' | 'params_invalid';

export class LogWriteError extends Error {
  readonly problem: LogWriteProblem;

  constructor(problem: LogWriteProblem) {
    super(`a setup log line was refused: ${problem}`);
    this.name = 'LogWriteError';
    this.problem = problem;
  }
}

interface RawLine {
  seq: number;
  ts: string;
  step: StepKey;
  level: LogLevel;
  message_key: LogKey;
  params: string;
}

export class SetupLog {
  readonly #now: () => number;

  constructor(options: { readonly now: () => number }) {
    this.#now = options.now;
  }

  /** Append one line inside the caller's transaction; returns its `seq`. */
  append(tx: Tx, entry: LogEntryInput): number {
    if (!(STEP_KEYS as readonly string[]).includes(entry.step)) throw new LogWriteError('step_invalid');
    if (!LEVELS.includes(entry.level)) throw new LogWriteError('level_invalid');
    if (!isLogKey(entry.messageKey)) throw new LogWriteError('key_unknown');
    const checked = LogParamsSchema.safeParse(entry.params);
    if (!checked.success) throw new LogWriteError('params_invalid');
    const declared: readonly string[] = LOG_KEYS[entry.messageKey];
    if (Object.keys(checked.data).some((name) => !declared.includes(name))) {
      throw new LogWriteError('params_invalid');
    }
    const next =
      ((tx.sqlite.prepare('SELECT MAX(seq) AS high FROM setup_log').get() as { high: number | null })
        .high ?? 0) + 1;
    tx.sqlite
      .prepare(
        'INSERT INTO setup_log (seq, ts, step, level, message_key, params) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        next,
        new Date(this.#now()).toISOString(),
        entry.step,
        entry.level,
        entry.messageKey,
        JSON.stringify(checked.data),
      );
    tx.sqlite
      .prepare('DELETE FROM setup_log WHERE seq <= ?')
      .run(next - LIMITS.setup.logRetained);
    return next;
  }

  /** Lines with `seq > after`, at most `limit` (1 to 200), in order. */
  read(db: DatabaseHandle, options: { readonly after: number; readonly limit: number }): LogWindow {
    const { after, limit } = options;
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError('after is a whole number from 0');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.setup.logPageMax) {
      throw new RangeError(`limit is a whole number from 1 to ${String(LIMITS.setup.logPageMax)}`);
    }
    const raws = db.sqlite
      .prepare('SELECT * FROM setup_log WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(after, limit + 1) as RawLine[];
    const page = raws.slice(0, limit);
    const lines = page.map(
      (raw): LogLineWire => ({
        seq: raw.seq,
        ts: raw.ts,
        step: raw.step,
        level: raw.level,
        messageKey: raw.message_key,
        params: JSON.parse(raw.params) as LogParams,
      }),
    );
    const oldest = (
      db.sqlite.prepare('SELECT MIN(seq) AS low FROM setup_log').get() as { low: number | null }
    ).low;
    // Lines between the cursor and the oldest retained row were trimmed.
    const truncated = oldest !== null && oldest > after + 1 && oldest > 1;
    return {
      lines,
      lastSeq: lines.length > 0 ? (lines[lines.length - 1]?.seq ?? after) : after,
      hasMore: raws.length > limit,
      truncated,
    };
  }

  latestSeq(db: DatabaseHandle): number {
    return (
      (db.sqlite.prepare('SELECT MAX(seq) AS high FROM setup_log').get() as { high: number | null })
        .high ?? 0
    );
  }
}
