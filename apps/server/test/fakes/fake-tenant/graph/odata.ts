// The `$filter`, `$orderby` and query-option handling of the fake Graph. It understands exactly what
// the product sends and what the call sheet needs, and it refuses everything else with a `FilterError`
// (the module answers 400 `Request_UnsupportedQuery`): a filter the product starts to send without
// this file knowing it is a failing test, not a silent pass.
//
// Grammar (spec FR-C-601):
//
//   expression  := term ( ("and" | "or") term )*         "and" binds tighter than "or"
//   term        := "not" term | "(" expression ")" | comparison
//   comparison  := property "eq" value | property "ne" value
//                | ("startsWith" | "endsWith") "(" property "," string ")"
//                | property "/any(" name ":" name " eq " string ")"
//   value       := string | true | false | null
//
// A string literal is single-quoted with `''` for a quote. There is no `contains`, `in`, `ge`, `le`,
// `gt`, `lt`, `$search` or arithmetic: Phase C does not use them, so the fake refuses them.
//
// The advanced-query rule (R-C-01, R-C-02) is ONE function, `advancedReasons`: it names every part of
// a query that Graph answers only to a request with `ConsistencyLevel: eventual` and `$count=true`.

export class FilterError extends Error {}

/** The right-hand side of `eq` and `ne`. */
export type FilterValue = string | boolean | null;

export type Filter =
  | {
      readonly kind: 'eq' | 'ne';
      readonly property: string;
      readonly value: FilterValue;
    }
  | {
      readonly kind: 'startswith' | 'endswith';
      readonly property: string;
      readonly value: string;
    }
  | { readonly kind: 'any'; readonly property: string; readonly value: string }
  | { readonly kind: 'and' | 'or'; readonly left: Filter; readonly right: Filter }
  | { readonly kind: 'not'; readonly operand: Filter };

interface Token {
  readonly type: 'word' | 'string' | 'punct';
  readonly text: string;
  readonly spaceBefore: boolean;
}

const PUNCTUATION = new Set(['(', ')', ',', ':', '/']);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let space = false;
  while (at < text.length) {
    const char = text.charAt(at);
    if (/\s/.test(char)) {
      space = true;
      at += 1;
      continue;
    }
    if (char === "'") {
      let value = '';
      at += 1;
      for (;;) {
        if (at >= text.length) throw new FilterError('unterminated string literal');
        const c = text.charAt(at);
        at += 1;
        if (c === "'") {
          if (text.charAt(at) === "'") {
            value += "'";
            at += 1;
            continue;
          }
          break;
        }
        value += c;
      }
      tokens.push({ type: 'string', text: value, spaceBefore: space });
    } else if (PUNCTUATION.has(char)) {
      tokens.push({ type: 'punct', text: char, spaceBefore: space });
      at += 1;
    } else if (/[A-Za-z0-9_.]/.test(char)) {
      const start = at;
      while (at < text.length && /[A-Za-z0-9_.]/.test(text.charAt(at))) at += 1;
      tokens.push({ type: 'word', text: text.slice(start, at), spaceBefore: space });
    } else {
      throw new FilterError(`unexpected character in the filter`);
    }
    space = false;
  }
  return tokens;
}

class Parser {
  #at = 0;
  constructor(
    readonly tokens: readonly Token[],
    readonly allowed: readonly string[],
  ) {}

  get done(): boolean {
    return this.#at >= this.tokens.length;
  }

  peek(): Token | undefined {
    return this.tokens[this.#at];
  }

  next(): Token {
    const token = this.tokens[this.#at];
    if (token === undefined) throw new FilterError('the filter ends too early');
    this.#at += 1;
    return token;
  }

  isWord(text: string): boolean {
    const token = this.peek();
    return token?.type === 'word' && token.text === text;
  }

  punct(char: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.text !== char) throw new FilterError(`expected "${char}"`);
  }

  property(): string {
    const token = this.next();
    if (token.type !== 'word') throw new FilterError('expected a property');
    if (!this.allowed.includes(token.text)) throw new FilterError(`cannot filter on ${token.text}`);
    return token.text;
  }

  string(): string {
    const token = this.next();
    if (token.type !== 'string') throw new FilterError('a string literal is single-quoted');
    return token.text;
  }

  expression(): Filter {
    return this.or();
  }

  or(): Filter {
    let left = this.and();
    while (this.isWord('or')) {
      this.operator();
      left = { kind: 'or', left, right: this.and() };
    }
    return left;
  }

  and(): Filter {
    let left = this.unary();
    while (this.isWord('and')) {
      this.operator();
      left = { kind: 'and', left, right: this.unary() };
    }
    return left;
  }

  /**
   * An operator word needs a space (or a parenthesis) after it, and a binary one also a space before.
   * `not` may start the filter.
   */
  operator(binary = true): void {
    const token = this.next();
    if (binary && !token.spaceBefore) {
      throw new FilterError(`expected a space before "${token.text}"`);
    }
    const after = this.peek();
    if (after !== undefined && !after.spaceBefore && after.text !== '(') {
      throw new FilterError(`expected a space after "${token.text}"`);
    }
  }

  unary(): Filter {
    if (this.isWord('not')) {
      this.operator(false);
      return { kind: 'not', operand: this.unary() };
    }
    const token = this.peek();
    if (token?.type === 'punct' && token.text === '(') {
      this.next();
      const inner = this.expression();
      this.punct(')');
      return inner;
    }
    return this.comparison();
  }

  comparison(): Filter {
    const first = this.peek();
    if (first?.type === 'word') {
      const lower = first.text.toLowerCase();
      const next = this.tokens[this.#at + 1];
      if ((lower === 'startswith' || lower === 'endswith') && next?.text === '(') {
        this.next();
        this.punct('(');
        const property = this.property();
        this.punct(',');
        const value = this.string();
        this.punct(')');
        return { kind: lower === 'startswith' ? 'startswith' : 'endswith', property, value };
      }
    }
    const property = this.property();
    const token = this.peek();
    if (token?.type === 'punct' && token.text === '/') {
      this.next();
      const name = this.next();
      if (name.type !== 'word' || name.text !== 'any') {
        throw new FilterError('only any() is supported after a property path');
      }
      this.punct('(');
      const variable = this.next();
      this.punct(':');
      const again = this.next();
      if (variable.type !== 'word' || again.type !== 'word' || again.text !== variable.text) {
        throw new FilterError('the lambda is any(c:c eq <string>)');
      }
      const op = this.next();
      if (op.type !== 'word' || op.text !== 'eq' || !op.spaceBefore) {
        throw new FilterError('the lambda is any(c:c eq <string>)');
      }
      const value = this.string();
      this.punct(')');
      return { kind: 'any', property, value };
    }
    const op = this.next();
    if (op.type !== 'word' || (op.text !== 'eq' && op.text !== 'ne')) {
      throw new FilterError('only eq and ne compare');
    }
    if (!op.spaceBefore) throw new FilterError('expected a space before the operator');
    const right = this.next();
    if (!right.spaceBefore) throw new FilterError('expected a space after the operator');
    let value: FilterValue;
    if (right.type === 'string') value = right.text;
    else if (right.type === 'word' && right.text === 'true') value = true;
    else if (right.type === 'word' && right.text === 'false') value = false;
    else if (right.type === 'word' && right.text === 'null') value = null;
    else throw new FilterError('a value is a string, true, false or null');
    return { kind: op.text, property, value };
  }
}

/** Parses a `$filter` over the properties in `allowed`. */
export function parseFilter(text: string, allowed: readonly string[]): Filter {
  const parser = new Parser(tokenize(text), allowed);
  const filter = parser.expression();
  if (!parser.done) throw new FilterError('unexpected text after the filter');
  return filter;
}

/** What a filter reads off an entity: text, a boolean, a list of text, or nothing. */
export type FilterReading = string | boolean | readonly string[] | null | undefined;

function same(actual: string | boolean, wanted: string | boolean): boolean {
  if (typeof actual === 'string' && typeof wanted === 'string') {
    return actual.toLowerCase() === wanted.toLowerCase();
  }
  return actual === wanted;
}

/** Evaluates a filter; string comparison is case-insensitive, as it is for directory objects. */
export function evaluate(filter: Filter, read: (property: string) => FilterReading): boolean {
  switch (filter.kind) {
    case 'and':
      return evaluate(filter.left, read) && evaluate(filter.right, read);
    case 'or':
      return evaluate(filter.left, read) || evaluate(filter.right, read);
    case 'not':
      return !evaluate(filter.operand, read);
    case 'any': {
      const actual = read(filter.property);
      return (
        Array.isArray(actual) &&
        actual.some((item: string) => item.toLowerCase() === filter.value.toLowerCase())
      );
    }
    case 'eq':
    case 'ne': {
      const actual = read(filter.property);
      const missing = actual === null || actual === undefined;
      let equal: boolean;
      if (filter.value === null) equal = missing;
      else if (missing || Array.isArray(actual)) equal = false;
      else equal = same(actual as string | boolean, filter.value);
      return filter.kind === 'eq' ? equal : !equal;
    }
    case 'startswith':
    case 'endswith': {
      const actual = read(filter.property);
      if (typeof actual !== 'string') return false;
      const left = actual.toLowerCase();
      const right = filter.value.toLowerCase();
      return filter.kind === 'startswith' ? left.startsWith(right) : left.endsWith(right);
    }
  }
}

/** `$orderby=<property> [asc|desc]` over one property of `allowed`. */
export interface OrderBy {
  readonly property: string;
  readonly direction: 'asc' | 'desc';
}

export function parseOrderBy(text: string, allowed: readonly string[]): OrderBy {
  const match = /^([A-Za-z][A-Za-z0-9]*)(?: (asc|desc))?$/.exec(text);
  if (match === null) throw new FilterError('$orderby is one property with asc or desc');
  const property = match[1] ?? '';
  if (!allowed.includes(property)) throw new FilterError(`cannot order by ${property}`);
  return { property, direction: match[2] === 'desc' ? 'desc' : 'asc' };
}

/** Does the filter use an operator that Graph answers only to an advanced query? */
function filterReasons(filter: Filter, advancedStartsWith: ReadonlySet<string>): string[] {
  switch (filter.kind) {
    case 'and':
    case 'or':
      return [
        ...filterReasons(filter.left, advancedStartsWith),
        ...filterReasons(filter.right, advancedStartsWith),
      ];
    case 'not':
      return ['the not operator', ...filterReasons(filter.operand, advancedStartsWith)];
    case 'ne':
      return ['the ne operator'];
    case 'endswith':
      return ['endsWith'];
    case 'eq':
      return filter.value === null ? ['eq null'] : [];
    case 'startswith':
      return advancedStartsWith.has(filter.property) ? [`startsWith on ${filter.property}`] : [];
    case 'any':
      return [];
  }
}

/**
 * THE advanced-query rule (R-C-01, R-C-02): the parts of a query that Graph answers only to a request
 * with `ConsistencyLevel: eventual` and `$count=true`. An empty list means the query is an ordinary
 * one. `advancedStartsWith` names the properties on which `startsWith` is documented as advanced only
 * (our reading of the property table of the advanced-queries page).
 */
export function advancedReasons(query: {
  readonly filter: Filter | null;
  readonly orderby: OrderBy | null;
  readonly count: boolean;
  readonly advancedStartsWith?: ReadonlySet<string>;
}): string[] {
  const reasons: string[] = [];
  if (query.filter !== null && query.orderby !== null) reasons.push('$filter with $orderby');
  if (query.count) reasons.push('$count');
  if (query.filter !== null) {
    reasons.push(...filterReasons(query.filter, query.advancedStartsWith ?? new Set()));
  }
  return [...new Set(reasons)];
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
