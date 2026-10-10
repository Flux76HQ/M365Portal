// A logger with the call shape of pino (`logger.error(fields, message)`) that writes one JSON line
// per call into a `LogCapture`. The error-handler tests use it until the real logger exists
// (T-A-029); the real one takes the same two arguments, so nothing changes at the call site.
import type { LogCapture } from './log-capture.js';

export type LogFields = Readonly<Record<string, unknown>>;

export interface CaptureLogger {
  trace(fields: LogFields, message: string): void;
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
}

export function createCaptureLogger(capture: LogCapture): CaptureLogger {
  const write =
    (level: string) =>
    (fields: LogFields, message: string): void => {
      capture.write(`${JSON.stringify({ level, msg: message, ...fields })}\n`);
    };
  return {
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}
