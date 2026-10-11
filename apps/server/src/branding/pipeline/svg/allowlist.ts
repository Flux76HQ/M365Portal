// The SVG allowlist (T-A-080; FR-A-087; plan 8.6; published in `docs/security.md`). One constant is the
// single source: the sanitiser reads it, the docs test compares it with the published list, and the
// plan's section 8.6 is what it is checked against at gate G2. Anything not on it is dropped.
//
// Element names are matched case-sensitively, as XML does: `SCRIPT` and `RECT` are not `script` and
// `rect`, they are unknown elements. An element is on the list only in the SVG namespace; a prefixed
// element that resolves to the SVG namespace is the same element, and a default namespace that is
// re-bound to another one is not.
import type { SvgContentCategory } from '@m365portal/shared/schemas/assets';

export interface SvgAllowlistSource {
  readonly elements: readonly string[];
  /** The allowed attributes by kind; the kind is documentation, the sanitiser uses the union. */
  readonly attributes: Readonly<Record<string, readonly string[]>>;
}

export const SVG_ALLOWLIST = {
  elements: [
    'svg',
    'g',
    'defs',
    'title',
    'desc',
    'symbol',
    'use',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
    'mask',
  ],
  attributes: {
    geometry: [
      'x',
      'y',
      'width',
      'height',
      'cx',
      'cy',
      'r',
      'rx',
      'ry',
      'x1',
      'y1',
      'x2',
      'y2',
      'fx',
      'fy',
      'points',
      'd',
    ],
    viewport: ['viewBox', 'preserveAspectRatio'],
    transform: ['transform', 'gradientTransform'],
    presentation: [
      'fill',
      'fill-opacity',
      'fill-rule',
      'stroke',
      'stroke-width',
      'stroke-linecap',
      'stroke-linejoin',
      'stroke-miterlimit',
      'stroke-dasharray',
      'stroke-dashoffset',
      'stroke-opacity',
      'opacity',
      'stop-color',
      'stop-opacity',
      'offset',
      'clip-path',
      'clip-rule',
      'mask',
      'display',
      'visibility',
    ],
    units: ['gradientUnits', 'spreadMethod', 'clipPathUnits', 'maskUnits', 'maskContentUnits'],
    identity: ['id'],
    reference: ['href'],
  },
} as const satisfies SvgAllowlistSource;

/** The allowlist in the shape the sanitiser looks things up in. */
export interface CompiledAllowlist {
  readonly elements: ReadonlySet<string>;
  readonly attributes: ReadonlySet<string>;
  /** The attributes a `style` declaration may set: the presentation kind. */
  readonly styleProperties: ReadonlySet<string>;
}

export function compileAllowlist(source: SvgAllowlistSource = SVG_ALLOWLIST): CompiledAllowlist {
  return {
    elements: new Set(source.elements),
    attributes: new Set(Object.values(source.attributes).flat()),
    styleProperties: new Set(source.attributes.presentation ?? []),
  };
}

export const DEFAULT_ALLOWLIST: CompiledAllowlist = compileAllowlist();

/** Elements in the SVG namespace that draw text: refused outright, there are no fonts to draw it with (A-38). */
export const TEXT_ELEMENTS: ReadonlySet<string> = new Set(['text', 'tspan', 'textPath', 'tref']);

// ---------------------------------------------------------------------------------------------
// What a dropped element or attribute is reported as
// ---------------------------------------------------------------------------------------------

const ANIMATION_ELEMENTS = new Set([
  'animate',
  'animateColor',
  'animateMotion',
  'animateTransform',
  'set',
  'mpath',
]);

const EXTERNAL_ELEMENTS = new Set(['image', 'iframe', 'embed', 'object', 'link', 'video', 'audio']);

/** The category a dropped element is reported under. Only the name is looked at, never the content. */
export function categoryOfElement(local: string): SvgContentCategory {
  if (local === 'script') return 'script';
  if (local === 'foreignObject') return 'foreign_object';
  if (local === 'style') return 'style';
  if (local === 'filter' || /^fe[A-Z]/.test(local)) return 'filter';
  if (ANIMATION_ELEMENTS.has(local)) return 'animation';
  if (EXTERNAL_ELEMENTS.has(local)) return 'external_reference';
  return 'unknown_element';
}

/** The category a dropped attribute is reported under. */
export function categoryOfAttribute(local: string): SvgContentCategory {
  if (/^on/i.test(local)) return 'event_handler';
  if (local === 'filter') return 'filter';
  if (local === 'style') return 'style';
  return 'unknown_attribute';
}
