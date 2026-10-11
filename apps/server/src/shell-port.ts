// The shell port (contract C6, plan 7.1 step 3 and 7.5): how the server turns the built `index.html`
// into the page it sends. The server knows nothing about branding; the module that does (S2,
// `branding/shell.ts`) implements `ShellRenderer` and fills all six placeholders of the template
// (C8) in one pass. Until it is registered, `createPlaceholderShell` fills the nonce and nothing else.
//
// The page is rendered per request and never cached: the nonce in it is the nonce of this response's
// Content-Security-Policy, and a page with a nonce in it that was served twice would be a page whose
// scripts anyone who saw the first copy could imitate.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The placeholder every `nonce` attribute of the template carries. */
export const NONCE_PLACEHOLDER = '__M365_NONCE__';

export interface ShellRenderInput {
  /** The nonce of this request's CSP (`c.get('nonce')()`): base64, written into attributes. */
  readonly nonce: string;
  readonly request: Request;
}

export interface ShellRenderer {
  /** The complete HTML document for this request. Called once per navigation, never cached. */
  render(input: ShellRenderInput): Promise<string>;
}

/** The build output has no usable `index.html`: a broken build, the server must not start. */
export class ShellTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellTemplateError';
  }
}

/**
 * The shell template of a web build: `index.html` in the build output directory, read once at start.
 * Neither the path nor the content ends up in the error.
 */
export function readShellTemplate(webRoot: string): string {
  let template: string;
  try {
    template = readFileSync(join(webRoot, 'index.html'), 'utf8');
  } catch {
    throw new ShellTemplateError('index.html is missing from the web build output');
  }
  if (!template.includes(NONCE_PLACEHOLDER)) {
    throw new ShellTemplateError(
      `index.html has no ${NONCE_PLACEHOLDER} placeholder: the web build is broken`,
    );
  }
  return template;
}

/**
 * What a nonce looks like: standard base64 of at least 128 bits, as `createNonce` makes it (the same
 * alphabet `buildCsp` accepts). It goes into HTML attributes unescaped, so nothing else is let in.
 */
const NONCE_SHAPE = /^[A-Za-z0-9+/]{22,128}={0,2}$/;

const NONCE_PATTERN = new RegExp(NONCE_PLACEHOLDER, 'g');

/**
 * The renderer that serves until the branding module brings its own: it fills `__M365_NONCE__` and
 * leaves the other five placeholders of the template as they are. The replacement is a function, so
 * a `$&` or `$'` in the template is never read as a replacement pattern, and it is one pass over the
 * template, so what is written in cannot be replaced again. A nonce that is not base64 is refused:
 * it is written into HTML attributes.
 */
export function createPlaceholderShell(template: string): ShellRenderer {
  return {
    render({ nonce }) {
      if (!NONCE_SHAPE.test(nonce)) {
        return Promise.reject(new TypeError('the nonce must be at least 128 bits of base64'));
      }
      return Promise.resolve(template.replace(NONCE_PATTERN, () => nonce));
    },
  };
}
