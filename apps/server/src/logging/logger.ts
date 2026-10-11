// The logger (FR-A-051, plan 8.9): pino, JSON, one line per call on standard output, the level from
// `LOG_LEVEL`, and a redaction pass over every field before it is written.
//
// The call shape is `log.info(fields, message)`: the message is a fixed word (`request`, `posture`,
// `unhandled_error`), and everything variable travels in `fields`, where the redaction can see it.
// pino would also accept `log.info('text %s', value)`, which puts a value into the message where no
// key rule applies; the `Logger` type below leaves that form out on purpose.
//
// Time comes from an injected clock (plan 13.2), so a test that moves the clock gets the time it
// set, and a clock that steps backwards gives a line with an earlier time, as it should.
import pino from 'pino';
import type { AppConfig, LogLevel } from '../config/env.js';
import { readPosture } from '../config/posture.js';
import { redactFields } from './redact.js';

export type LogFields = Readonly<Record<string, unknown>>;

/** The call shape every module of the server logs with. The error handler's `ErrorLogger` fits it. */
export interface Logger {
  readonly level: LogLevel;
  /** A logger that adds `bindings` to every line. They are redacted like any other field. */
  child(bindings: LogFields): Logger;
  trace(fields: LogFields, message: string): void;
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  fatal(fields: LogFields, message: string): void;
}

export interface LogDestination {
  write(line: string): unknown;
}

export interface CreateLoggerOptions {
  readonly level: LogLevel;
  /** Where the lines go. Default: standard output (descriptor 1), written synchronously. */
  readonly destination?: LogDestination;
  /** The clock for the `time` of each line, in milliseconds since the epoch. Default: `Date.now`. */
  readonly now?: () => number;
}

function stdoutDestination(): LogDestination {
  // Synchronous, so that the last line before an exit (a failed start, the shutdown) is written.
  const destination = pino.destination({ dest: 1, sync: true });
  destination.on('error', () => {
    // A closed standard output means the runtime is gone; throwing from here would only add a
    // crash to the problem, and the log has nowhere left to say so.
  });
  return destination;
}

function timeOf(now: () => number): string {
  const milliseconds = now();
  const instant = Number.isFinite(milliseconds) ? new Date(milliseconds) : new Date();
  return instant.toISOString();
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const now = options.now ?? Date.now;
  const instance = pino(
    {
      level: options.level,
      // No process id and no host name: the first is noise, the second is a container id. With no
      // base there are no root bindings either; the bindings of a child go through `wrap` below.
      base: null,
      timestamp: () => `,"time":"${timeOf(now)}"`,
      formatters: {
        level: (label) => ({ level: label }),
        log: (fields) => redactFields(fields),
      },
    },
    options.destination ?? stdoutDestination(),
  );
  return wrap(instance);
}

/**
 * pino's own `child` would take its bindings as they come, past the redaction hook, so the logger
 * handed out is a thin wrapper that redacts them first. A request-scoped logger carrying the request
 * id is the likely use; one carrying a token must not be able to leak it.
 */
function wrap(instance: pino.Logger): Logger {
  return {
    get level(): LogLevel {
      return instance.level as LogLevel;
    },
    // pino calls hasOwnProperty on what it is given, which a record without a prototype lacks.
    child: (bindings) => wrap(instance.child({ ...redactFields(bindings) })),
    trace: (fields, message) => {
      instance.trace(fields, message);
    },
    debug: (fields, message) => {
      instance.debug(fields, message);
    },
    info: (fields, message) => {
      instance.info(fields, message);
    },
    warn: (fields, message) => {
      instance.warn(fields, message);
    },
    error: (fields, message) => {
      instance.error(fields, message);
    },
    fatal: (fields, message) => {
      instance.fatal(fields, message);
    },
  };
}

/** What the start knows beyond the configuration (FR-A-015). */
export interface StartStatus {
  readonly storageWritable: boolean;
  /** The schema version of the database, or `null` when there is none (degraded mode). */
  readonly schemaVersion: number | null;
  /**
   * The setup state (`unconfigured`, `in_progress`, `awaiting_first_signin`, `completed`), or
   * `unknown` when there is no database to ask (FR-B-101). A name, never a value.
   */
  readonly setupState?: string;
  /**
   * The state of the sealed storage, which is the secrets state of FR-B-108 (`ok`, `key_missing`,
   * ...), or `unknown` before it is known. The field is not called `secretsState` because the
   * redaction pass would replace the value of any key that contains `secret`.
   */
  readonly sealedStorage?: string;
}

/**
 * The posture line (FR-A-015, FR-B-101, E-15): once, at info, at start. Modes and flags only: which
 * trust-proxy mode is in effect (never an address), the HSTS mode, showcase, whether the break-glass
 * account exists and whether multi-factor sign-in is required, the setup state and the secrets
 * state, whether storage is writable and the schema version. No value of any variable and no
 * address.
 */
export function logPosture(
  log: Pick<Logger, 'info'>,
  config: AppConfig,
  status: StartStatus,
): void {
  log.info(
    {
      event: 'posture',
      ...readPosture(config),
      setupState: status.setupState ?? 'unknown',
      sealedStorage: status.sealedStorage ?? 'unknown',
      storageWritable: status.storageWritable,
      schemaVersion: status.schemaVersion,
    },
    'posture',
  );
}
