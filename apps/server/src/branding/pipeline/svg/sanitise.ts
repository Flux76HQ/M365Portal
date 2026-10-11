// SVG allowlist rebuild (T-A-080; FR-A-087 second half; PD-09; plan 8.6): the parsed tree goes in, a new
// tree comes out, and only what the allowlist names has been copied. Nothing is cleaned in place: an
// element or attribute is either rebuilt from values that passed their rule, or it is not in the
// result. What was left out is reported by category (never by content), so the owner can be told
// "parts of your logo were removed: scripts, external references" without the warning carrying any of
// the attacker's text.
//
// Rules, in the order they apply:
//   - `<text>`, `<tspan>`, `<textPath>` and `<tref>` in the SVG namespace anywhere in the document are
//     refused outright (`svg_text_unsupported`): the runtime image has no fonts, so text cannot render;
//   - an element is kept when it is in the SVG namespace and its local name is on the list; otherwise it
//     is dropped with its whole subtree (prefixed, re-bound and foreign-namespace elements included);
//   - an attribute is kept when it has no namespace and is on the list and its value passes its rule,
//     or it is `xlink:href` (which becomes `href`) and its value is `#id`. Event handlers, `class`,
//     `xml:*`, unknown names and every value that fails its rule are dropped;
//   - `style` is not an attribute of the result: its declarations are parsed one by one and each one
//     that names an allowlisted presentation property with a valid value becomes an attribute (and
//     overrides the attribute of the same name, as CSS does). A declaration with a backslash or a
//     comment, `!important`, an unknown property or an invalid value is dropped. `<style>` elements
//     are dropped as unknown elements;
//   - the root's own size and view box are left to `rebuild.ts`, which computes them from the view box;
//   - text is kept only inside `title` and `desc`; it does not affect the picture.
//
// References (`href`, `url(#id)`) are checked against the document, for cycles and for the size of
// their expansion, by `refs.ts`; this module only guarantees that what is left has the form `#id`.
import type { SvgContentCategory } from '@m365portal/shared/schemas/assets';
import { PipelineError } from '../errors.js';
import {
  DEFAULT_ALLOWLIST,
  TEXT_ELEMENTS,
  categoryOfAttribute,
  categoryOfElement,
  type CompiledAllowlist,
} from './allowlist.js';
import { SVG_NAMESPACE, type ParsedSvg, type XmlAttribute, type XmlElement } from './parse.js';
import { VALUE_RULES, parseFragmentReference, type ValueRule } from './values.js';

const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

/** The attributes of the root that `rebuild.ts` replaces; they are not copied and not reported. */
const ROOT_OWN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'x',
  'y',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
]);

/** Text kept per `title` or `desc`, in UTF-16 units. It never affects the picture. */
const MAX_TEXT_LENGTH = 1_000;

export interface CleanElement {
  /** The local name, from the allowlist. */
  readonly name: string;
  /** Output attribute names and cleaned values, in document order. */
  readonly attributes: Map<string, string>;
  /** Child elements, and text for `title` and `desc`. */
  readonly children: CleanNode[];
}

export type CleanNode = CleanElement | string;

export interface SanitiseOptions {
  /** The allowlist to apply. Tests widen it on purpose; the pipeline uses the default. */
  readonly allowlist?: CompiledAllowlist;
  /** Value rules by attribute name. An allowlisted name with no rule is accepted as written. */
  readonly rules?: Readonly<Record<string, ValueRule>>;
}

export interface Sanitised {
  readonly root: CleanElement;
  /** What was left out, by category. Empty when the document was copied whole. */
  readonly removed: Set<SvgContentCategory>;
}

interface Context {
  readonly allowlist: CompiledAllowlist;
  readonly rules: Readonly<Record<string, ValueRule>>;
  readonly removed: Set<SvgContentCategory>;
  readonly ids: Set<string>;
}

function hasUrlFunction(value: string): boolean {
  return /url\s*\(/i.test(value);
}

function assertNoTextElements(element: XmlElement): void {
  if (element.uri === SVG_NAMESPACE && TEXT_ELEMENTS.has(element.local)) {
    throw new PipelineError('svg_text_unsupported', 'the SVG contains text, which cannot be drawn');
  }
  for (const child of element.children) {
    if (child.kind === 'element') assertNoTextElements(child);
  }
}

function dropValue(context: Context, value: string, fallback: SvgContentCategory): void {
  context.removed.add(hasUrlFunction(value) ? 'external_reference' : fallback);
}

/** Apply the rule of `name` to `value`; the cleaned value, or null (and the removal is recorded). */
function acceptValue(context: Context, name: string, value: string): string | null {
  const rule = context.rules[name];
  const cleaned = rule === undefined ? value : rule(value);
  if (cleaned === null) {
    dropValue(context, value, 'unknown_attribute');
    return null;
  }
  return cleaned;
}

function convertStyle(style: string, context: Context, attributes: Map<string, string>): void {
  for (const declaration of style.split(';')) {
    const text = declaration.trim();
    if (text === '') continue;
    if (/\\|\/\*|\*\//.test(text) || /!\s*important/i.test(text)) {
      dropValue(context, text, 'style');
      continue;
    }
    const colon = text.indexOf(':');
    const property = colon > 0 ? text.slice(0, colon).trim().toLowerCase() : '';
    const value = colon > 0 ? text.slice(colon + 1).trim() : '';
    if (!context.allowlist.styleProperties.has(property)) {
      dropValue(context, text, 'style');
      continue;
    }
    const rule = context.rules[property];
    const cleaned = rule === undefined ? value : rule(value);
    if (cleaned === null) {
      dropValue(context, text, 'style');
      continue;
    }
    attributes.set(property, cleaned);
  }
}

function cleanAttributes(
  element: XmlElement,
  isRoot: boolean,
  context: Context,
): Map<string, string> {
  const attributes = new Map<string, string>();
  let style: string | null = null;
  let plainHref: XmlAttribute | null = null;
  let xlinkHref: XmlAttribute | null = null;

  for (const attribute of element.attributes) {
    if (attribute.uri === XLINK_NAMESPACE && attribute.local === 'href') {
      xlinkHref = attribute;
      continue;
    }
    if (attribute.uri !== '') {
      // `xml:space`, `xlink:title`, a foreign namespace: none of it is on the list.
      context.removed.add('unknown_attribute');
      continue;
    }
    const name = attribute.local;
    if (name === 'style') {
      style = attribute.value;
    } else if (name === 'href') {
      plainHref = attribute;
    } else if (isRoot && ROOT_OWN_ATTRIBUTES.has(name)) {
      continue;
    } else if (!context.allowlist.attributes.has(name)) {
      const category = categoryOfAttribute(name);
      if (category === 'unknown_attribute') {
        dropValue(context, attribute.value, category);
      } else {
        context.removed.add(category);
      }
    } else if (name === 'id') {
      const cleaned = acceptValue(context, 'id', attribute.value);
      if (cleaned === null) continue;
      if (context.ids.has(cleaned)) {
        // The first element with an id keeps it; a second one would make every reference ambiguous.
        context.removed.add('unknown_attribute');
      } else {
        context.ids.add(cleaned);
        attributes.set('id', cleaned);
      }
    } else {
      const cleaned = acceptValue(context, name, attribute.value);
      if (cleaned !== null) attributes.set(name, cleaned);
    }
  }

  // `href` wins over `xlink:href` when both are present (SVG 2); either one must be `#id`.
  const link = plainHref ?? xlinkHref;
  if (xlinkHref !== null && plainHref !== null) context.removed.add('unknown_attribute');
  if (link !== null) {
    if (!context.allowlist.attributes.has('href')) {
      dropValue(context, link.value, 'external_reference');
    } else if (parseFragmentReference(link.value.trim()) === null) {
      context.removed.add('external_reference');
    } else {
      attributes.set('href', link.value.trim());
    }
  }

  if (style !== null) convertStyle(style, context, attributes);
  return attributes;
}

function cleanElement(element: XmlElement, isRoot: boolean, context: Context): CleanElement | null {
  if (!(element.uri === SVG_NAMESPACE && context.allowlist.elements.has(element.local))) {
    context.removed.add(categoryOfElement(element.local));
    return null;
  }
  const attributes = cleanAttributes(element, isRoot, context);
  const children: CleanNode[] = [];
  const keepsText = element.local === 'title' || element.local === 'desc';
  let textLength = 0;
  for (const child of element.children) {
    if (child.kind === 'element') {
      const cleaned = cleanElement(child, false, context);
      if (cleaned !== null) children.push(cleaned);
    } else if (keepsText && textLength < MAX_TEXT_LENGTH) {
      const text = child.text.slice(0, MAX_TEXT_LENGTH - textLength);
      textLength += text.length;
      children.push(text);
    }
  }
  return { name: element.local, attributes, children };
}

/**
 * Rebuild the parsed document from the allowlist. Throws `svg_text_unsupported` for text elements.
 * The root is always kept (the parser checked that it is an `svg` element in the SVG namespace).
 */
export function sanitiseTree(parsed: ParsedSvg, options: SanitiseOptions = {}): Sanitised {
  const context: Context = {
    allowlist: options.allowlist ?? DEFAULT_ALLOWLIST,
    rules: options.rules ?? VALUE_RULES,
    removed: new Set(),
    ids: new Set(),
  };
  assertNoTextElements(parsed.root);
  const root = cleanElement(parsed.root, true, context);
  if (root === null) {
    // Only a widened or narrowed allowlist can get here; the pipeline's own always lists `svg`.
    throw new PipelineError('image_empty', 'nothing of the SVG is left after the allowlist');
  }
  if (parsed.processingInstructions > 0) context.removed.add('processing_instruction');
  return { root, removed: context.removed };
}
