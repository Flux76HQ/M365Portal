// Deep redaction of everything that reaches the log (FR-A-051, plan 8.9).
//
// The rule is by key: the value of `authorization`, `cookie`, `set-cookie` and `x-csrf-token`, and of
// any key that contains `password`, `secret`, `token`, `key` or `credential`, is replaced, however
// deep it sits, whatever its shape, in objects and in arrays, and whatever the case of the key. The
// key itself stays, so an operator can see that the field was there. A key that merely looks
// sensitive (`tokenCount`) is redacted too: a false positive costs a digit in a log line, a miss
// costs a credential.
//
// Redaction by key is not enough on its own, so the walk also decides what a value may look like:
//   - an Error is described by its name, system code and stack frames (`describeError`: never the
//     message, the cause or an own property, FR-A-023);
//   - bytes are described by their length;
//   - an object that is not a plain object or an array (a URL, a Map, a class with `toJSON`) is
//     described by its constructor name: `JSON.stringify` would call its `toJSON`, and that is a
//     door for a value the key rules never saw;
//   - a cycle, a depth beyond the limit, a very long string or a very long array is cut.
// The result is plain data that `JSON.stringify` cannot choke on.
import { describeError } from '../http/error-handler.js';

export const REDACTED = '[redacted]';

/** Keys that contain one of these (case-insensitive) are redacted. */
const SENSITIVE_FRAGMENTS = [
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
  'key',
  'credential',
] as const;

export const MAX_DEPTH = 8;
export const MAX_STRING_CHARACTERS = 8_192;
export const MAX_ARRAY_ITEMS = 100;

const SAFE_CONSTRUCTOR_NAME = /^[A-Za-z][A-Za-z0-9_$]{0,63}$/;

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

type Walked = unknown;

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeUnknownObject(value: object): string {
  const constructor: unknown = (value as { constructor?: unknown }).constructor;
  const name = typeof constructor === 'function' ? constructor.name : '';
  return `[object ${SAFE_CONSTRUCTOR_NAME.test(name) ? name : 'Object'}]`;
}

function walkRecord(
  value: object,
  depth: number,
  ancestors: WeakSet<object>,
): Record<string, Walked> {
  // No prototype: a key called `__proto__` is then an ordinary key, not a way to replace it.
  const result = Object.create(null) as Record<string, Walked>;
  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
      continue;
    }
    let entry: unknown;
    try {
      entry = (value as Record<string, unknown>)[key];
    } catch {
      // A getter that throws: its message could hold anything.
      result[key] = '[unreadable]';
      continue;
    }
    const walked = walk(entry, depth + 1, ancestors);
    if (walked !== undefined) result[key] = walked;
  }
  return result;
}

function walk(value: unknown, depth: number, ancestors: WeakSet<object>): Walked {
  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING_CHARACTERS
        ? `${value.slice(0, MAX_STRING_CHARACTERS)}…[truncated]`
        : value;
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (value === null) return null;
  const object = value as object;

  if (object instanceof Error) return describeError(object);
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? null : object.toISOString();
  }
  if (ArrayBuffer.isView(object)) return `[binary ${String(object.byteLength)} bytes]`;
  if (object instanceof ArrayBuffer) return `[binary ${String(object.byteLength)} bytes]`;

  if (depth >= MAX_DEPTH) return '[truncated]';
  if (ancestors.has(object)) return '[circular]';

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const items = (object as unknown[])
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => walk(item, depth + 1, ancestors) ?? null);
      if (object.length > MAX_ARRAY_ITEMS) {
        items.push(`[+${String(object.length - MAX_ARRAY_ITEMS)} more]`);
      }
      return items;
    }
    if (isPlainObject(object)) return walkRecord(object, depth, ancestors);
    return describeUnknownObject(object);
  } finally {
    ancestors.delete(object);
  }
}

/** A copy of `value` that is safe to write to the log. `value` itself is not changed. */
export function redactDeep(value: unknown): unknown {
  return walk(value, 0, new WeakSet<object>());
}

/** `redactDeep` for the fields of a log line: always a record, so pino can merge it. */
export function redactFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = redactDeep(fields);
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { value: result };
}
