// What the static app shell needs from the page it is in (plan 14.2 tactic 5).
//
// The shell in index.html is the same for everybody and is painted before any script of the
// application has loaded. It is `hidden` in the markup and shown by this script, so a browser without
// scripting draws none of it. Three details depend on the request: the language (the shell holds its text
// in both, hidden; `<html lang>` was set by the boot script before this runs), the organisation name
// (data, never translated) and whether the preview banner is on. The last two are in the boot data the
// server embeds in the page, so this small inline script reads that block: no request, no framework,
// and no CSS (the entry CSS has a byte budget; `hidden` and the `flex` utility are already in it). It
// runs once, right after the shell in the document, and every step is guarded: a page without boot
// data (an old shell, a development server) keeps the plain shell, which is correct for it.
//
// Like boot-script.ts it is a pure function of what is injected and the build compiles it into an
// inline, nonce-carrying classic script (build/plugins/static-shell.ts); it imports nothing.

/** The id of the data block of the shell template (the same as lib/boot-data.ts; kept here so that this inline script imports nothing). */
const BOOT_DATA_ID = 'm365-boot';

/** Show the text of the page's language, fill the organisation name in and switch the preview banner on. */
export function revealStaticShell(doc: Document): void {
  try {
    // The shell starts hidden: without scripting nothing of it is drawn, only the <noscript> message.
    for (const shell of doc.querySelectorAll<HTMLElement>('[data-slot="static-shell"]')) {
      shell.hidden = false;
    }
    const language = doc.documentElement.lang;
    for (const element of doc.querySelectorAll('[data-shell-lang]')) {
      (element as HTMLElement).hidden = element.getAttribute('data-shell-lang') !== language;
    }
    const text = doc.getElementById(BOOT_DATA_ID)?.textContent;
    if (text === undefined || text === '') return;
    const data = JSON.parse(text) as {
      me?: { features?: { preview?: unknown } };
      branding?: { orgName?: unknown } | null;
    };
    if (data.me?.features?.preview === true) {
      for (const banner of doc.querySelectorAll<HTMLElement>('[data-shell-banner]')) {
        banner.hidden = false;
        banner.classList.add('flex');
      }
    }
    const name = data.branding?.orgName;
    if (typeof name !== 'string') return;
    for (const element of doc.querySelectorAll('[data-shell-org]')) {
      // `textContent`, never markup: the name is text a person typed.
      element.textContent = name;
    }
  } catch {
    // Not JSON, or not the shape: the plain shell stays.
  }
}
