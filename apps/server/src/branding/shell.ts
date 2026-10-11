// The HTML shell renderer (T-A-091; FR-A-095; PD-15; C6 and C8; E-14): the branding module's
// `ShellRenderer`. It takes the template of the web build (read once at start, the only thing that is
// cached) and fills the six placeholders of C8 for one request:
//
//   __M365_NONCE__        the CSP nonce of this response: on every tag that carries it
//   __M365_TITLE__        the organisation name, HTML escaped: the text inside <title>
//   __M365_THEME_CSS__    `renderTokenCss` of the derived accent tokens: the text inside <style>
//   __M365_ICON_LINKS__   the <link> tags of the hashed icons (raw HTML we build from validated hashes)
//   __M365_THEME_COLOR__  the effective light accent: the value of content= in <meta name="theme-color">
//   __M365_BOOT_JSON__    `{ "me", "branding" }` as JSON TEXT: the template owns the <script> element
//
// All six are replaced in ONE regular-expression pass by a REPLACER FUNCTION. A function's return
// value is inserted literally, so an organisation name such as `$&`, `` $` ``, `$'` or
// `__M365_NONCE__` stays the text it is (a replacement string would interpret the first three), and
// because it is a single pass over the template, nothing that was written in is scanned again. The
// result is a new string for this request; it is never stored, and the caller sends it `no-store`.
//
// Every value is escaped or validated for the place it lands in: the title is HTML escaped, the CSS
// comes from `renderTokenCss` (which accepts validated `#rrggbb` only and throws otherwise), the icon
// URLs are rebuilt from 64 hex digits, the theme colour must be `#rrggbb`, and the boot JSON has `<`,
// U+2028 and U+2029 escaped so no text can close the element. The nonce is checked to be base64
// before it is written into attributes.
//
// Degraded mode (storage unusable, FR-A-013): the in-memory defaults, no icon links, and
// `"branding": null` in the boot data (there is no applied branding to embed; the web app then asks
// the API like it does without boot data, and learns `storageAvailable: false` from `me`).
import { deriveAccentTokens, tryNormalizeAccent } from '@m365portal/shared/branding/accent';
import { brandingAssetUrl, type Branding } from '@m365portal/shared/schemas/branding';
import type { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import { renderTokenCss } from '@m365portal/shared/tokens';
import type { z } from 'zod';
import type { ShellRenderer } from '../shell-port.js';
import { isAssetHash } from './asset-store.js';
import { degradedBranding, type DegradedBranding } from './defaults.js';
import { appliedBranding } from './manifest.js';
import type { BrandingService } from './service.js';

type MeResponse = z.infer<typeof MeResponseSchema>;

export interface BrandingShellDeps {
  /** `index.html` of the web build with the placeholders of C8, read once at start. */
  readonly template: string;
  /** The applied branding; a 503 `storage_unavailable` means degraded mode. Asked on every render. */
  readonly service: Pick<BrandingService, 'get'>;
  /** The `me` of this request (`GET /api/v1/me`), embedded in the boot data. */
  readonly me: (request: Request) => MeResponse;
}

/** What a nonce looks like: standard base64 of at least 128 bits, as `createNonce` makes it. */
const NONCE_SHAPE = /^[A-Za-z0-9+/]{22,128}={0,2}$/;
const PLACEHOLDER = /__M365_(?:NONCE|TITLE|THEME_CSS|ICON_LINKS|THEME_COLOR|BOOT_JSON)__/g;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text for an HTML text node or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * JSON text for the inside of a `<script type="application/json">` element: `<` (which could close
 * the element or open a comment), U+2028 and U+2029 (line terminators in script source) are written
 * as `\u` escapes. The value is the same JSON after parsing.
 */
export function escapeJsonForScript(json: string): string {
  return json.replace(/[<\u2028\u2029]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}

function iconLinks(branding: Branding | DegradedBranding): string {
  if (!('icons' in branding)) return '';
  const favicon = branding.icons.favicon32;
  const apple = branding.icons.appleTouch180;
  // Rebuilt from the hash: a url that is not the hashed path of a registered file never gets in.
  for (const { hash } of [favicon, apple]) {
    if (!isAssetHash(hash)) throw new TypeError('an icon hash is not 64 hex digits');
  }
  return [
    `<link rel="icon" type="image/png" sizes="32x32" href="${brandingAssetUrl(favicon.hash)}">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="${brandingAssetUrl(apple.hash)}">`,
  ].join('\n    ');
}

export function createBrandingShell(deps: BrandingShellDeps): ShellRenderer {
  return {
    render({ nonce, request }) {
      try {
        if (!NONCE_SHAPE.test(nonce)) {
          throw new TypeError('the nonce must be at least 128 bits of base64');
        }
        const applied = appliedBranding(deps.service);
        const branding = applied ?? degradedBranding();
        const themeColor = branding.tokens.light.accent;
        // The shared normaliser is the one judge of a colour (FR-A-008): only its own output goes in.
        if (tryNormalizeAccent(themeColor) !== themeColor) {
          throw new TypeError('the accent is not #rrggbb');
        }
        const css = renderTokenCss({ accent: deriveAccentTokens(branding.accent) });
        if (css.includes('<')) throw new TypeError('the theme css holds markup');

        const values: Readonly<Record<string, string>> = {
          __M365_NONCE__: nonce,
          __M365_TITLE__: escapeHtml(branding.orgName),
          __M365_THEME_CSS__: css,
          __M365_ICON_LINKS__: iconLinks(branding),
          __M365_THEME_COLOR__: themeColor,
          __M365_BOOT_JSON__: escapeJsonForScript(
            JSON.stringify({ me: deps.me(request), branding: applied ?? null }),
          ),
        };
        return Promise.resolve(
          deps.template.replace(PLACEHOLDER, (placeholder) => values[placeholder] ?? placeholder),
        );
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('the shell failed'));
      }
    },
  };
}
