// References inside a sanitised SVG (T-A-080; FR-A-087; plan 8.6; H-24). After the allowlist rebuild
// every reference has the form `#id` or `url(#id)`; this module decides what becomes of it.
//
//   - a reference to an id that does not exist is dropped (a paint falls back to its fallback colour
//     when it has one) and reported as `unresolved_reference`;
//   - a reference cycle (gradient `href` chains, a `clip-path` or `mask` that contains an element
//     using itself, `use` of an ancestor) is `svg_too_complex`;
//   - so is a graph without any cycle that expands to more than 100,000 element instances when every
//     `use`, gradient, clip-path and mask reference is followed (a chain of groups that each `use` the
//     previous one ten times is 10^n instances from n+1 elements). This is decided here, from the tree,
//     before anything is rendered: the renderer never sees such a file.
//
// Two numbers are computed, both in linear time:
//   - the cost of an element when it is instantiated: one, plus the cost of its children, plus the cost
//     of everything it references. It is computed once per element (memoised), so a graph of 10,000
//     elements is walked in linear time however large the number it adds up to. The walk covers every
//     element, referenced or not, so a cycle is found even in a definition nobody uses;
//   - the instances the document draws: the root counts one, an element in place counts one plus its
//     children (definitions are not drawn where they stand: `defs`, `symbol`, `clipPath`, `mask` and
//     gradients count one, and their content counts only where something references it) plus the cost
//     of what it references.
// The second number is compared with the limit. Neither walk recurses along a chain of references
// (an explicit stack and a work list), so a chain of thousands of references cannot exhaust the stack.
import { LIMITS } from '@m365portal/shared/limits';
import type { SvgContentCategory } from '@m365portal/shared/schemas/assets';
import { PipelineError } from '../errors.js';
import type { CleanElement } from './sanitise.js';
import { parseFragmentReference, parseLength, parsePaint, parseReferenceOrNone } from './values.js';

const IN_PROGRESS = -1;

function childElements(element: CleanElement): CleanElement[] {
  return element.children.filter((child): child is CleanElement => typeof child !== 'string');
}

/** Every element with an id, by id. The sanitiser keeps the first of a duplicated id only. */
export function indexIds(root: CleanElement): Map<string, CleanElement> {
  const index = new Map<string, CleanElement>();
  const walk = (element: CleanElement): void => {
    const id = element.attributes.get('id');
    if (id !== undefined && !index.has(id)) index.set(id, element);
    for (const child of childElements(element)) walk(child);
  };
  walk(root);
  return index;
}

/** The ids an attribute value refers to: the target of `href`, of `url(#id)` in a paint, `clip-path` and `mask`. */
function referencesOf(name: string, value: string): string | null {
  if (name === 'href') return parseFragmentReference(value);
  if (name === 'fill' || name === 'stroke') return parsePaint(value)?.reference ?? null;
  if (name === 'clip-path' || name === 'mask')
    return parseReferenceOrNone(value)?.reference ?? null;
  return null;
}

/** Drop the references that point nowhere; a paint keeps its fallback. */
function dropUnresolved(
  root: CleanElement,
  ids: ReadonlyMap<string, CleanElement>,
  removed: Set<SvgContentCategory>,
): void {
  const walk = (element: CleanElement): void => {
    for (const [name, value] of [...element.attributes]) {
      const target = referencesOf(name, value);
      if (target === null || ids.has(target)) continue;
      removed.add('unresolved_reference');
      const fallback = name === 'fill' || name === 'stroke' ? parsePaint(value)?.fallback : null;
      if (fallback === null || fallback === undefined) {
        element.attributes.delete(name);
      } else {
        element.attributes.set(name, fallback);
      }
    }
    for (const child of childElements(element)) walk(child);
  };
  walk(root);
}

function targetsOf(element: CleanElement, ids: ReadonlyMap<string, CleanElement>): CleanElement[] {
  const targets: CleanElement[] = [];
  for (const [name, value] of element.attributes) {
    const id = referencesOf(name, value);
    const target = id === null ? undefined : ids.get(id);
    if (target !== undefined) targets.push(target);
  }
  return targets;
}

function tooComplex(reason: string): PipelineError {
  return new PipelineError('svg_too_complex', reason);
}

/** Containers of definitions: not drawn where they stand, used by reference. */
const DEFINITION_CONTAINERS: ReadonlySet<string> = new Set([
  'defs',
  'symbol',
  'clipPath',
  'mask',
  'linearGradient',
  'radialGradient',
]);

/**
 * Resolve the references of a sanitised tree: drop the unresolved ones (recorded in `removed`), then
 * refuse cycles and an expansion above the limit with `svg_too_complex`. Mutates the attributes of
 * `root`. Returns the id index for the renderability check.
 */
export function resolveReferences(
  root: CleanElement,
  removed: Set<SvgContentCategory>,
): Map<string, CleanElement> {
  const ids = indexIds(root);
  dropUnresolved(root, ids, removed);

  // The cost of an element when it is instantiated, with cycle detection over the whole document.
  // An explicit stack instead of recursion: a chain of thousands of references must not be able to
  // exhaust the call stack, and the answer must not depend on the order of the document.
  const costs = new Map<CleanElement, number>();
  interface Frame {
    readonly next: readonly CleanElement[];
    index: number;
    total: number;
    readonly element: CleanElement;
  }
  const open = (element: CleanElement): Frame => {
    costs.set(element, IN_PROGRESS);
    return {
      element,
      next: [...childElements(element), ...targetsOf(element, ids)],
      index: 0,
      total: 1,
    };
  };
  const frames: Frame[] = [open(root)];
  for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
    const next = frame.next[frame.index];
    if (next !== undefined) {
      frame.index += 1;
      const known = costs.get(next);
      if (known === IN_PROGRESS) throw tooComplex('the SVG has a reference cycle');
      if (known === undefined) {
        frames.push(open(next));
      } else {
        frame.total += known;
      }
    } else {
      costs.set(frame.element, frame.total);
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) parent.total += frame.total;
    }
  }

  // The instances that are drawn: the tree as it stands, with every reference expanded.
  const drawn = (element: CleanElement): number => {
    let total = 1;
    if (!DEFINITION_CONTAINERS.has(element.name)) {
      for (const child of childElements(element)) total += drawn(child);
    }
    for (const target of targetsOf(element, ids)) total += costs.get(target) ?? 0;
    return total;
  };
  if (drawn(root) > LIMITS.image.svgExpandedInstances) {
    throw tooComplex('the SVG expands to too many element instances');
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Is there anything to draw?
// ---------------------------------------------------------------------------------------------

const SHAPES: ReadonlySet<string> = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
]);

/** Containers whose content is not drawn where it stands: it is defined here and used elsewhere. */
const NOT_DRAWN_IN_PLACE: ReadonlySet<string> = new Set([
  'defs',
  'symbol',
  'clipPath',
  'mask',
  'linearGradient',
  'radialGradient',
  'title',
  'desc',
  'stop',
]);

function isPositive(element: CleanElement, name: string): boolean {
  const value = element.attributes.get(name);
  const length = value === undefined ? null : parseLength(value);
  return length !== null && length.value > 0;
}

/** A shape draws nothing without the geometry it needs: `<rect/>` has no size, `<path/>` no data. */
function shapeHasGeometry(element: CleanElement): boolean {
  switch (element.name) {
    case 'path':
      return element.attributes.has('d');
    case 'rect':
      return isPositive(element, 'width') && isPositive(element, 'height');
    case 'circle':
      return isPositive(element, 'r');
    case 'ellipse':
      return isPositive(element, 'rx') && isPositive(element, 'ry');
    case 'line':
      return ['x1', 'y1', 'x2', 'y2'].some((name) => element.attributes.has(name));
    default:
      return element.attributes.has('points');
  }
}

/**
 * Does the document draw anything: a shape with geometry that is not hidden, reached from the root or
 * through a `use`? (Whether the pixels are visible, a shape with `fill="none"` for one, is decided on
 * the rendered image.) A work list instead of recursion, for the same reason as above. A `use` of a
 * `symbol` draws the symbol's content; any other target is drawn like an element in place.
 */
export function drawsAnything(root: CleanElement, ids: ReadonlyMap<string, CleanElement>): boolean {
  const seen = new Set<CleanElement>();
  const work: CleanElement[] = [root];
  for (let element = work.pop(); element !== undefined; element = work.pop()) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (
      element.attributes.get('display') === 'none' ||
      isZeroOpacity(element.attributes.get('opacity')) ||
      NOT_DRAWN_IN_PLACE.has(element.name)
    ) {
      continue;
    }
    if (SHAPES.has(element.name)) {
      if (shapeHasGeometry(element)) return true;
    } else if (element.name === 'use') {
      const id = parseFragmentReference(element.attributes.get('href') ?? '');
      const target = id === null ? undefined : ids.get(id);
      if (target === undefined) continue;
      if (target.name === 'symbol') {
        work.push(...childElements(target));
      } else {
        work.push(target);
      }
    } else {
      work.push(...childElements(element));
    }
  }
  return false;
}

function isZeroOpacity(value: string | undefined): boolean {
  if (value === undefined) return false;
  const length = parseLength(value);
  return length !== null && length.value === 0;
}
