// Strict SVG parse (T-A-079; FR-A-087 first half; PD-09; plan 8.6): the text that `prescanSvg` returned
// becomes a plain tree, and nothing in it is acted on.
//
// `saxes` is a namespace-aware XML 1.0/1.1 parser with no DTD support at all: it has no entity
// table beyond the five predefined ones (`&foo;` is an error), it fetches nothing, and it reads no
// file. It is run with `xmlns: true` so that every element and attribute carries the namespace it
// resolves to, which is what the allowlist checks (an `svg:script` is in the SVG namespace, an
// `html:script` is not, and neither is judged by its written name).
//
// Hard limits are enforced by throwing from the handlers, which stops the parser at once: more than
// 10,000 elements or a depth above 64 is `svg_too_complex` (a 100,000-deep nesting bomb ends at depth
// 65 without the rest of the file being read). Anything the parser reports is `svg_not_wellformed`,
// with a constant message: the parser's own message names the offending text, and none of it leaves
// this module.
//
// What the tree holds: elements (with namespace and attributes, the namespace declarations
// themselves excluded) and text. Comments are dropped. Processing instructions are counted and
// dropped, never interpreted (`xml-stylesheet` is just a name). The XML declaration is checked for an
// encoding other than UTF-8 and is otherwise ignored. An XInclude element is an element of another
// namespace like any other; nothing here knows how to include anything.
import { LIMITS } from '@m365portal/shared/limits';
import { SaxesParser } from 'saxes';
import { PipelineError } from '../errors.js';

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The namespace saxes reports for `xmlns` and `xmlns:*` declarations. */
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

export interface XmlAttribute {
  /** The qualified name as written, `xlink:href`. */
  readonly name: string;
  readonly prefix: string;
  readonly local: string;
  /** The namespace the prefix resolves to; empty for an attribute without a prefix. */
  readonly uri: string;
  readonly value: string;
}

export interface XmlElement {
  readonly kind: 'element';
  readonly prefix: string;
  readonly local: string;
  /** The namespace the element is in; empty when it is in none. */
  readonly uri: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: XmlNode[];
}

export interface XmlText {
  readonly kind: 'text';
  text: string;
}

export type XmlNode = XmlElement | XmlText;

export interface ParsedSvg {
  readonly root: XmlElement;
  /** Every element of the document, the root included, also those that will be dropped. */
  readonly elementCount: number;
  /** Processing instructions seen (the XML declaration is not one); never acted on. */
  readonly processingInstructions: number;
}

const NOT_WELLFORMED = 'the SVG is not well-formed XML';

/**
 * Parse an SVG document. The text has been through `prescanSvg`. Throws `PipelineError`:
 * `svg_not_wellformed` (also for a root that is not an `svg` element in the SVG namespace) and
 * `svg_too_complex`.
 */
export function parseSvg(text: string): ParsedSvg {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const stack: XmlElement[] = [];
  // The handlers fill this; a plain variable would be narrowed to `null` after the closures.
  const found: { root: XmlElement | null } = { root: null };
  let elementCount = 0;
  let processingInstructions = 0;

  const fail = (): never => {
    throw new PipelineError('svg_not_wellformed', NOT_WELLFORMED);
  };

  parser.on('error', fail);
  // The pre-scan refuses a DOCTYPE; this is the second layer, should the pre-scan ever be bypassed.
  parser.on('doctype', () => {
    throw new PipelineError('svg_doctype_forbidden', 'the SVG declares a DOCTYPE or an entity');
  });
  parser.on('xmldecl', (declaration) => {
    const encoding = declaration.encoding;
    if (encoding !== undefined && encoding.toLowerCase() !== 'utf-8') {
      throw new PipelineError(
        'svg_not_wellformed',
        'the SVG declares an encoding other than UTF-8',
      );
    }
  });
  parser.on('processinginstruction', () => {
    processingInstructions += 1;
  });
  parser.on('opentag', (tag) => {
    elementCount += 1;
    if (elementCount > LIMITS.image.svgElements || stack.length >= LIMITS.image.svgDepth) {
      throw new PipelineError(
        'svg_too_complex',
        'the SVG has too many elements or is nested too deeply',
      );
    }
    const attributes: XmlAttribute[] = [];
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === XMLNS_NAMESPACE) continue;
      attributes.push({
        name: attribute.name,
        prefix: attribute.prefix,
        local: attribute.local,
        uri: attribute.uri,
        value: attribute.value,
      });
    }
    const element: XmlElement = {
      kind: 'element',
      prefix: tag.prefix,
      local: tag.local,
      uri: tag.uri,
      attributes,
      children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      found.root = element;
    } else {
      parent.children.push(element);
    }
    stack.push(element);
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  const addText = (data: string): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) return;
    const last = parent.children[parent.children.length - 1];
    if (last?.kind === 'text') {
      last.text += data;
    } else {
      parent.children.push({ kind: 'text', text: data });
    }
  };
  parser.on('text', addText);
  parser.on('cdata', addText);

  try {
    parser.write(text).close();
  } catch (failure) {
    if (failure instanceof PipelineError) throw failure;
    // An exception of the library itself: the document is not something we can parse.
    return fail();
  }

  const document = found.root;
  if (document?.local !== 'svg' || document.uri !== SVG_NAMESPACE) {
    throw new PipelineError(
      'svg_not_wellformed',
      'the root element is not an svg element in the SVG namespace',
    );
  }
  return { root: document, elementCount, processingInstructions };
}
