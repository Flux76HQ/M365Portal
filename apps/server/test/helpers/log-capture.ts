// Collects what the application logs, so a test can read it as data (the logging tests) or search it
// for a value that must not appear (the no-leak tests: a canary secret in a thrown error).
//
// It is a writable stream, so it can be the destination of the logger: pino writes one JSON object
// per line, and `lines()` parses them back. A line that is not JSON (a stray `console.log`) makes
// `lines()` throw, because the application logs JSON and nothing else.
import { StringDecoder } from 'node:string_decoder';
import { Writable } from 'node:stream';

export type LogLine = Record<string, unknown>;

export class LogCapture extends Writable {
  #text = '';
  // A multi-byte character may arrive split over two writes.
  readonly #decoder = new StringDecoder('utf8');

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#text += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    callback();
  }

  /** Everything written so far, raw. */
  text(): string {
    return this.#text;
  }

  /** The complete lines written so far, each parsed as a JSON object, in order. */
  lines(): LogLine[] {
    const complete = this.#text.slice(0, this.#text.lastIndexOf('\n') + 1);
    const parsed: LogLine[] = [];
    complete
      .split('\n')
      .filter((line) => line !== '')
      .forEach((line, index) => {
        const number = String(index + 1);
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw new Error(`log line ${number} is not JSON`);
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error(`log line ${number} is not a JSON object`);
        }
        parsed.push(value as LogLine);
      });
    return parsed;
  }

  /** Forget everything written so far. */
  clear(): void {
    this.#text = '';
  }
}

export function createLogCapture(): LogCapture {
  return new LogCapture();
}
