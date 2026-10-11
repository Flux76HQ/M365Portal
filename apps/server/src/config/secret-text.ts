// A secret value read from the environment (APP_KEY, SETUP_TOKEN, BREAK_GLASS_PASSWORD_HASH, ...)
// as it is carried around inside the configuration. The text is reachable only through
// `reveal()`; `toString`, `toJSON`, `util.inspect` and a template literal give `[redacted]`, so a
// configuration object that is logged, serialised or printed by a test failure shows no secret
// (AGENTS.md section 4, FR-B-104).
import { inspect } from 'node:util';

const REDACTED = '[redacted]';

export class SecretText {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  /** The secret itself. Call it where the value is used, and nowhere else. */
  reveal(): string {
    return this.#text;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
