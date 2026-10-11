// THE STATIC APP SHELL (plan 14.2 tactic 5; T-A-173): the build-time token filler, the stage-chunk
// finder of the deferred start, the inline loader and the inline script that fills in the two request
// dependent facts. The built document itself is checked in build-output.test.ts.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { LOADER_SCRIPT, startBlock, stageChunkFiles } from '../build/plugins/defer-entry';
import { fillCatalogueTokens } from '../build/plugins/static-shell';
import { revealStaticShell } from '../src/boot/static-shell';

const CATALOGUES = {
  en: { 'a.b': 'Fish & <chips>', 'a.c': 'Plain' },
  nl: { 'a.b': 'Vis', 'a.c': 'Gewoon' },
};

describe('fillCatalogueTokens', () => {
  it('writes the escaped catalogue text of each language', () => {
    expect(fillCatalogueTokens('<i>{{en:a.b}}</i><i>{{nl:a.b}}</i>', CATALOGUES)).toBe(
      '<i>Fish &amp; &lt;chips&gt;</i><i>Vis</i>',
    );
  });

  it('fails the build for a key that a catalogue does not have (negative fixture)', () => {
    expectGuardFails(
      (html: string) => fillCatalogueTokens(html, CATALOGUES),
      '<i>{{nl:missing.key}}</i>',
      { reason: 'no text for "missing.key"' },
    );
  });
});

describe('stageChunkFiles', () => {
  const chunk = (fileName: string, imports: string[], moduleIds: string[]) => ({
    type: 'chunk',
    fileName,
    imports,
    moduleIds,
  });
  const bundle = {
    'assets/stage-a.js': chunk(
      'assets/stage-a.js',
      ['assets/shared.js'],
      ['/w/src/boot/stage-a.ts'],
    ),
    'assets/shared.js': chunk('assets/shared.js', ['assets/deep.js'], ['/w/src/lib/x.ts']),
    'assets/deep.js': chunk('assets/deep.js', [], ['/w/src/lib/y.ts']),
    'assets/route.js': chunk('assets/route.js', ['assets/shared.js'], ['/w/src/routes/users.tsx']),
    'assets/logo.png': { type: 'asset', fileName: 'assets/logo.png' },
  };

  it('is every stage chunk and what it imports, and nothing else', () => {
    expect(stageChunkFiles(bundle).sort()).toEqual([
      'assets/deep.js',
      'assets/shared.js',
      'assets/stage-a.js',
    ]);
  });

  it('finds nothing when no module is a stage (negative fixture: the guard of the build)', () => {
    expectGuardFails(
      (input: Record<string, unknown>) => {
        expect(stageChunkFiles(input)).not.toEqual([]);
      },
      { 'assets/route.js': bundle['assets/route.js'] },
    );
  });
});

describe('the start block and the loader', () => {
  it('writes the entry and the preloads as JSON that cannot close the script element', () => {
    const text = startBlock('/assets/e</script>.js', ['/assets/a.js']);
    expect(text).not.toContain('</script');
    expect(JSON.parse(text)).toEqual({ entry: '/assets/e</script>.js', preload: ['/assets/a.js'] });
  });

  it('is one text for every build: no file name, no placeholder, no module script', () => {
    expect(LOADER_SCRIPT).not.toMatch(/assets|__M365_|createElement\("script"\)/);
    expect(LOADER_SCRIPT).toContain('import(d.entry)');
  });
});

describe('revealStaticShell', () => {
  function page(boot: string | null, lang = 'en'): Document {
    document.documentElement.lang = lang;
    document.body.innerHTML =
      (boot === null ? '' : `<script type="application/json" id="m365-boot">${boot}</script>`) +
      '<div id="root">' +
      '<div data-shell-banner hidden class="items-start">' +
      '<span data-shell-lang="en" hidden>Preview</span><span data-shell-lang="nl" hidden>Voorbeeld</span>' +
      '</div><bdi data-shell-org></bdi><bdi data-shell-org></bdi></div>';
    return document;
  }
  const visible = (doc: Document): string[] =>
    [...doc.querySelectorAll<HTMLElement>('[data-shell-lang]')]
      .filter((element) => !element.hidden)
      .map((element) => element.textContent);

  it('writes the organisation name as text into every placeholder and turns the banner on for preview', () => {
    const doc = page(
      JSON.stringify({
        me: { features: { preview: true } },
        branding: { orgName: '<b>شركة</b> & Co' },
      }),
    );
    revealStaticShell(doc);
    const names = [...doc.querySelectorAll('[data-shell-org]')];
    expect(names.map((element) => element.textContent)).toEqual([
      '<b>شركة</b> & Co',
      '<b>شركة</b> & Co',
    ]);
    expect(doc.querySelector('[data-shell-org] b')).toBeNull();
    const banner = doc.querySelector<HTMLElement>('[data-shell-banner]')!;
    expect(banner.hidden).toBe(false);
    expect(banner.classList.contains('flex')).toBe(true);
  });

  it('keeps the banner off when preview mode is off', () => {
    const doc = page(
      JSON.stringify({ me: { features: { preview: false } }, branding: { orgName: 'Acme' } }),
    );
    revealStaticShell(doc);
    expect(doc.querySelector<HTMLElement>('[data-shell-banner]')!.hidden).toBe(true);
    expect(doc.querySelector('[data-shell-org]')?.textContent).toBe('Acme');
  });

  it('shows the text of the language of the page and only that', () => {
    expect(visible(revealStaticShell_(page(null, 'en')))).toEqual(['Preview']);
    expect(visible(revealStaticShell_(page(null, 'nl')))).toEqual(['Voorbeeld']);
    // A language the shell has no text for shows none (never the wrong one).
    expect(visible(revealStaticShell_(page(null, 'de')))).toEqual([]);
  });

  it('leaves the plain shell alone for missing, empty, broken or foreign boot data', () => {
    for (const boot of [null, '', '{not json', '[]', 'null', JSON.stringify({ branding: null })]) {
      const doc = page(boot);
      expect(() => {
        revealStaticShell(doc);
      }).not.toThrow();
      expect(doc.querySelector('[data-shell-org]')?.textContent).toBe('');
      expect(doc.querySelector<HTMLElement>('[data-shell-banner]')!.hidden).toBe(true);
    }
  });
});

function revealStaticShell_(doc: Document): Document {
  revealStaticShell(doc);
  return doc;
}
