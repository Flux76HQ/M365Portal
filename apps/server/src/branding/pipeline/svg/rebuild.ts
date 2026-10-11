// The SVG stages up to the rasteriser, in one call (T-A-080; FR-A-087; PD-09; plan 8.5 stage 7b and 8.6):
// pre-scan, strict parse, allowlist rebuild, references, size, serialise. Bytes in, a new SVG document
// as a string out, plus the warning that says what was removed. Nothing here renders, opens a file or
// makes a connection.
//
// The size of the output is decided here and only here: the view box of the input (else its width and
// height) gives the shape, the slot's bound (512, or 128 for the compact variant) gives the scale, and
// the new root carries explicit `width`, `height` and `viewBox`. The size the file declares is never
// used to size anything (H-19). A view box or a size beyond the number limit is `svg_too_complex`; a
// file with neither a usable view box nor a usable width and height is `svg_not_wellformed`.
import { SVG_CONTENT_CATEGORIES, type SvgContentCategory } from '@m365portal/shared/schemas/assets';
import type { UploadWarning } from '@m365portal/shared/schemas/assets';
import { PipelineError } from '../errors.js';
import { prescanSvg } from './prescan.js';
import { SVG_NAMESPACE, parseSvg, type XmlElement } from './parse.js';
import { drawsAnything, resolveReferences } from './refs.js';
import { sanitiseTree, type CleanElement, type SanitiseOptions } from './sanitise.js';
import {
  isLengthSyntax,
  isNumberSyntax,
  isPreserveAspectRatio,
  lengthInPixels,
  parseViewBox,
  MAX_NUMBER_MAGNITUDE,
  type ViewBox,
} from './values.js';

export interface RebuildOptions extends SanitiseOptions {
  /** The largest edge of the picture: 512, or 128 for the compact variant. */
  readonly bound: number;
}

export interface RebuiltSvg {
  /** The new document: only allowlisted elements and attributes, explicit size. */
  readonly svg: string;
  /** The size the document will be rendered at, at most `bound` on the longer edge. */
  readonly width: number;
  readonly height: number;
  /** What was dropped, in the order of `SVG_CONTENT_CATEGORIES`. Empty when nothing was. */
  readonly removed: readonly SvgContentCategory[];
  /** `[svg_content_removed]` when something was dropped, else nothing. */
  readonly warnings: readonly UploadWarning[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (char) => ENTITIES[char] ?? char);
}

function rawAttribute(root: XmlElement, name: string): string | undefined {
  return root.attributes.find((attribute) => attribute.uri === '' && attribute.local === name)
    ?.value;
}

interface RootBox {
  readonly box: ViewBox;
  /** The root's `viewBox` was there but unusable, so it was not used. */
  readonly viewBoxDropped: boolean;
}

/** The box that gives the picture its shape: the view box, else width and height. */
function rootBox(root: XmlElement): RootBox {
  const viewBoxText = rawAttribute(root, 'viewBox');
  let viewBoxDropped = false;
  if (viewBoxText !== undefined) {
    const tokens = viewBoxText.trim().split(/\s*,\s*|\s+/);
    if (tokens.length === 4 && tokens.every(isNumberSyntax)) {
      if (tokens.some((token) => !(Math.abs(Number(token)) <= MAX_NUMBER_MAGNITUDE))) {
        throw new PipelineError('svg_too_complex', 'the SVG view box is outside the number limit');
      }
      const box = parseViewBox(viewBoxText);
      if (box !== null) return { box, viewBoxDropped };
    }
    viewBoxDropped = true;
  }
  const widthText = rawAttribute(root, 'width');
  const heightText = rawAttribute(root, 'height');
  for (const text of [widthText, heightText]) {
    if (
      text !== undefined &&
      isLengthSyntax(text) &&
      lengthInPixels(text) === null &&
      !text.includes('%')
    ) {
      throw new PipelineError('svg_too_complex', 'the SVG size is outside the number limit');
    }
  }
  const width = widthText === undefined ? null : lengthInPixels(widthText);
  const height = heightText === undefined ? null : lengthInPixels(heightText);
  if (width === null || height === null || !(width > 0) || !(height > 0)) {
    throw new PipelineError(
      'svg_not_wellformed',
      'the SVG has no usable view box, width or height',
    );
  }
  return { box: { x: 0, y: 0, width, height }, viewBoxDropped };
}

/** The output size: the longer edge is `bound`, the other follows the aspect, at least one pixel. */
function outputSize(box: ViewBox, bound: number): { width: number; height: number } {
  const scale = bound / Math.max(box.width, box.height);
  const edge = (length: number): number => {
    const value = Math.round(length * scale);
    return Number.isFinite(value) ? Math.min(bound, Math.max(1, value)) : bound;
  };
  return { width: edge(box.width), height: edge(box.height) };
}

function serialiseElement(element: CleanElement, out: string[], extra: string): void {
  out.push(`<${element.name}${extra}`);
  for (const [name, value] of element.attributes) {
    out.push(` ${name}="${escapeAttribute(value)}"`);
  }
  if (element.children.length === 0) {
    out.push('/>');
    return;
  }
  out.push('>');
  for (const child of element.children) {
    if (typeof child === 'string') {
      out.push(escapeText(child));
    } else {
      serialiseElement(child, out, '');
    }
  }
  out.push(`</${element.name}>`);
}

/**
 * Sanitise an SVG into a new document. Throws `PipelineError`: `svg_not_wellformed`,
 * `svg_doctype_forbidden`, `svg_text_unsupported`, `svg_too_complex` or `image_empty`.
 */
export function rebuildSvg(bytes: Uint8Array, options: RebuildOptions): RebuiltSvg {
  const parsed = parseSvg(prescanSvg(bytes));
  const { root, removed } = sanitiseTree(parsed, options);
  const { box, viewBoxDropped } = rootBox(parsed.root);
  if (viewBoxDropped) removed.add('unknown_attribute');
  const ids = resolveReferences(root, removed);
  if (!drawsAnything(root, ids)) {
    throw new PipelineError('image_empty', 'nothing of the SVG can be drawn');
  }

  const { width, height } = outputSize(box, options.bound);
  const aspect = rawAttribute(parsed.root, 'preserveAspectRatio');
  const rootAttributes =
    ` xmlns="${SVG_NAMESPACE}" width="${String(width)}" height="${String(height)}"` +
    ` viewBox="${[box.x, box.y, box.width, box.height].map(String).join(' ')}"` +
    (aspect !== undefined && isPreserveAspectRatio(aspect)
      ? ` preserveAspectRatio="${escapeAttribute(aspect.trim())}"`
      : '');
  const out: string[] = [];
  serialiseElement(root, out, rootAttributes);

  const categories = SVG_CONTENT_CATEGORIES.filter((category) => removed.has(category));
  return {
    svg: out.join(''),
    width,
    height,
    removed: categories,
    warnings: categories.length === 0 ? [] : [{ code: 'svg_content_removed', categories }],
  };
}
