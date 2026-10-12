// The `$filter` and query-option handling of the fake Graph. It understands exactly what the
// product sends and what the call sheet needs: `property eq 'literal'`, `startswith(property,
// 'literal')` and `and` between them. A literal is single-quoted with `''` for a quote. Anything
// else is a `FilterError`, which the module answers as 400 `Request_UnsupportedQuery`: a filter the
// product starts to send without this file knowing it is a failing test, not a silent pass.

export class FilterError extends Error {}

export type Filter =
  | { readonly kind: 'eq'; readonly property: string; readonly value: string }
  | { readonly kind: 'startswith'; readonly property: string; readonly value: string }
  | { readonly kind: 'and'; readonly left: Filter; readonly right: Filter };

class Reader {
  #at = 0;
  constructor(readonly text: string) {}

  get done(): boolean {
    return this.#at >= this.text.length;
  }

  skipSpace(): void {
    while (this.#at < this.text.length && /\s/.test(this.text.charAt(this.#at))) this.#at += 1;
  }

  /** Whether at least one white space character follows (required around `eq` and `and`). */
  spaceAhead(): boolean {
    return /\s/.test(this.text.charAt(this.#at));
  }

  word(): string {
    const start = this.#at;
    while (this.#at < this.text.length && /[A-Za-z0-9_.]/.test(this.text.charAt(this.#at)))
      this.#at += 1;
    return this.text.slice(start, this.#at);
  }

  accept(char: string): boolean {
    if (this.text.charAt(this.#at) === char) {
      this.#at += 1;
      return true;
    }
    return false;
  }

  literal(): string {
    if (!this.accept("'")) throw new FilterError('a string literal is single-quoted');
    let value = '';
    for (;;) {
      if (this.#at >= this.text.length) throw new FilterError('unterminated string literal');
      const char = this.text.charAt(this.#at);
      this.#at += 1;
      if (char === "'") {
        if (this.text.charAt(this.#at) === "'") {
          value += "'";
          this.#at += 1;
          continue;
        }
        return value;
      }
      value += char;
    }
  }
}

function term(reader: Reader, allowed: readonly string[]): Filter {
  reader.skipSpace();
  const first = reader.word();
  if (first.length === 0) throw new FilterError('expected a property or a function');
  if (first === 'startswith') {
    reader.skipSpace();
    if (!reader.accept('(')) throw new FilterError('expected "("');
    reader.skipSpace();
    const property = reader.word();
    reader.skipSpace();
    if (!reader.accept(',')) throw new FilterError('expected ","');
    reader.skipSpace();
    const value = reader.literal();
    reader.skipSpace();
    if (!reader.accept(')')) throw new FilterError('expected ")"');
    if (!allowed.includes(property)) throw new FilterError(`cannot filter on ${property}`);
    return { kind: 'startswith', property, value };
  }
  if (!allowed.includes(first)) throw new FilterError(`cannot filter on ${first}`);
  if (!reader.spaceAhead()) throw new FilterError('expected a space before the operator');
  reader.skipSpace();
  if (reader.word() !== 'eq') throw new FilterError('only eq is supported');
  if (!reader.spaceAhead()) throw new FilterError('expected a space after the operator');
  reader.skipSpace();
  return { kind: 'eq', property: first, value: reader.literal() };
}

/** Parses a `$filter` over the properties in `allowed`. */
export function parseFilter(text: string, allowed: readonly string[]): Filter {
  const reader = new Reader(text);
  let filter = term(reader, allowed);
  for (;;) {
    if (!reader.spaceAhead()) break;
    reader.skipSpace();
    if (reader.done) break;
    if (reader.word() !== 'and') throw new FilterError('only "and" joins terms');
    if (!reader.spaceAhead()) throw new FilterError('expected a space after "and"');
    filter = { kind: 'and', left: filter, right: term(reader, allowed) };
  }
  reader.skipSpace();
  if (!reader.done) throw new FilterError('unexpected text after the filter');
  return filter;
}

/** Evaluates a filter; string comparison is case-insensitive, as it is for directory objects. */
export function evaluate(
  filter: Filter,
  read: (property: string) => string | null | undefined,
): boolean {
  if (filter.kind === 'and') return evaluate(filter.left, read) && evaluate(filter.right, read);
  const actual = read(filter.property);
  if (actual === null || actual === undefined) return false;
  const left = actual.toLowerCase();
  const right = filter.value.toLowerCase();
  return filter.kind === 'eq' ? left === right : left.startsWith(right);
}

/** `$select` as a list, or `null` when there is none. An empty item is an error. */
export function parseSelect(value: string | null): string[] | null {
  if (value === null) return null;
  const items = value.split(',').map((item) => item.trim());
  if (items.some((item) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(item))) {
    throw new FilterError('$select is a comma separated list of property names');
  }
  return items;
}

/**
 * Keeps the selected properties of an entity (always `id`), or the default set when there is no
 * `$select`. `render` has every property the fake can show; a name outside `catalog` is an error.
 */
export function project(
  render: Readonly<Record<string, unknown>>,
  defaults: readonly string[],
  catalog: ReadonlySet<string>,
  select: readonly string[] | null,
): Record<string, unknown> {
  const names = select ?? defaults;
  const out: Record<string, unknown> = {};
  if ('id' in render) out.id = render.id;
  for (const name of names) {
    if (!catalog.has(name)) throw new FilterError(`could not find a property named ${name}`);
    out[name] = name in render ? render[name] : null;
  }
  return out;
}
