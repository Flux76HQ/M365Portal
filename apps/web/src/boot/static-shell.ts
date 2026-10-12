// What the static app shell needs from the page it is in (plan 14.2 tactic 5).
//
// The shell in index.html is the same for everybody and is painted before any script of the
// application has loaded. It is `hidden` in the markup and shown by this script, so a browser without
// scripting draws none of it. Two details depend on the request: the language (a piece of text the shell
// holds in both languages is hidden except the one of `<html lang>`, which the boot script set before this
// runs; today the shell holds none, the preview banner of Phase A is gone) and the organisation name (data,
// never translated), which is in the boot data the server embeds in the page. This small inline script
// reads that block: no request, no framework, and no CSS (the entry CSS has a byte budget). It runs once,
// right after the shell in the document, and every step is guarded: a page without boot data (an old
// shell, a development server) keeps the plain shell, which is correct for it.
//
// Like boot-script.ts it is a pure function of what is injected and the build compiles it into an
// inline, nonce-carrying classic script (build/plugins/static-shell.ts); it imports nothing.

/** The id of the data block of the shell template (the same as lib/boot-data.ts; kept here so that this inline script imports nothing). */
const BOOT_DATA_ID = 'm365-boot';

/** Show the shell, the text of the page's language and the organisation name. */
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
    const data = JSON.parse(text) as { branding?: { orgName?: unknown } | null };
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
