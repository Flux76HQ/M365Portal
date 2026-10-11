// Applies a saved branding to the running shell (T-A-215; FR-A-132, FR-A-095 client part; US-2.1).
//
// The server draws the shell with the branding in force when the page is requested: the accent
// variables in a nonce-carrying <style>, the title, the theme colour, the icon links. A branding saved
// on the Appearance page changes while the page stays open, so the client does what the server did:
//
//   - the sidebar and header mark (`OrgMark`) and `document.title` (`DocumentTitleSync`) are React
//     components that read the branding query, so the cache update that every save, reset and applied
//     import performs is enough for them;
//   - the accent variables of the current theme are written on `:root` through the CSSOM
//     (`style.setProperty`, which `style-src` allows; never a `style="..."` string), with the values the
//     server wrote for the same branding (`branding.tokens` is `deriveAccentTokens(accent)`), and the
//     theme colour and the icon links get the new values.
//
// The inline values win over the server's <style> rules, for the theme that is showing; when the theme
// changes they are written again for the new one. When the branding is still the one the server drew,
// nothing is written (and the shared token code is never loaded). Setting the very same values the
// server drew would be harmless, only wasted.
import type { ResolvedTheme } from '../../boot/boot-script';
import { useEffect, useRef } from 'react';
import { readBootData } from '../../lib/boot-data';
import { useBranding } from '../../lib/router-context';
import { useTheme } from '../../lib/theme';
import type { Branding } from './types';

type AccentVariables = Readonly<Record<string, string>>;

/**
 * Writes the accent variables of `theme`, the theme colour and the icon links of `branding` into the
 * document. Pure but for the document it is given.
 */
export function applyBrandingToDocument(
  doc: Document,
  branding: Branding,
  theme: ResolvedTheme,
  accentVariables: AccentVariables,
): void {
  const root = doc.documentElement;
  const set = branding.tokens[theme];
  for (const [field, variable] of Object.entries(accentVariables)) {
    const value = (set as unknown as Record<string, unknown>)[field];
    if (typeof value === 'string') root.style.setProperty(variable, value.toLowerCase());
  }
  doc
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', branding.tokens.light.accent);
  doc.querySelector('link[rel="icon"]')?.setAttribute('href', branding.icons.favicon32.url);
  doc
    .querySelector('link[rel="apple-touch-icon"]')
    ?.setAttribute('href', branding.icons.appleTouch180.url);
}

/**
 * Keeps the shell's accent in step with the branding in the cache. Mount once, inside the router
 * (`root-providers.tsx`).
 */
export function useApplyBrandingToShell(): void {
  const branding = useBranding();
  const { resolved } = useTheme();
  // The revision the server drew into the page, or null when the page came without embedded data.
  const drawn = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (branding === undefined) return;
    if (drawn.current === undefined) {
      drawn.current = readBootData() === null ? null : branding.revision;
    }
    if (drawn.current === branding.revision) return;

    let live = true;
    void import('@m365portal/shared/tokens').then(({ ACCENT_VARIABLES }) => {
      if (live) applyBrandingToDocument(document, branding, resolved, ACCENT_VARIABLES);
    });
    return () => {
      live = false;
    };
  }, [branding, resolved]);
}
