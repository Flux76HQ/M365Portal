// THE STATIC APP SHELL (plan 14.2 tactic 5; T-A-173): the build-time token filler, the stage-chunk
// finder of the deferred start, the inline loader and the inline script that fills in the two request
// dependent facts. The built document itself is checked in build-output.test.ts.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  LOADER_SCRIPT,
  routeChunkFiles,
  startBlock,
  stageChunkFiles,
} from '../build/plugins/defer-entry';
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

describe('routeChunkFiles', () => {
  const chunk = (fileName: string, imports: string[], moduleIds: string[]) => ({
    type: 'chunk',
    fileName,
    imports,
    moduleIds,
  });
  const bundle = {
    'assets/root.js': chunk('assets/root.js', [], ['/w/src/routes/__root.tsx?tsr-split=component']),
    'assets/index.js': chunk(
      'assets/index.js',
      ['assets/card.js'],
      ['/w/src/routes/index.tsx?tsr-split=component'],
    ),
    'assets/card.js': chunk('assets/card.js', [], ['/w/src/components/card.tsx']),
    'assets/settings.js': chunk(
      'assets/settings.js',
      [],
      ['/w/src/routes/settings.tsx?tsr-split=component'],
    ),
    'assets/settings-index.js': chunk(
      'assets/settings-index.js',
      [],
      ['/w/src/routes/settings.index.tsx?tsr-split=component'],
    ),
    'assets/appearance.js': chunk(
      'assets/appearance.js',
      ['assets/form.js'],
      ['/w/src/routes/settings.appearance.tsx?tsr-split=component'],
    ),
    'assets/form.js': chunk('assets/form.js', [], ['/w/src/lib/form.ts']),
    'assets/users.js': chunk(
      'assets/users.js',
      [],
      ['/w/src/routes/users.tsx?tsr-split=component'],
    ),
    'assets/helper.js': chunk('assets/helper.js', [], ['/w/src/routes/-helper.tsx']),
  };

  it('lists, per URL path, the chunks of the routes on the way to it and what they import', () => {
    const routes = routeChunkFiles(bundle, new Set());
    expect(Object.keys(routes).sort()).toEqual([
      '/',
      '/settings',
      '/settings/appearance',
      '/users',
    ]);
    expect([...routes['/']!].sort()).toEqual([
      '/assets/card.js',
      '/assets/index.js',
      '/assets/root.js',
    ]);
    expect([...routes['/users']!].sort()).toEqual([
      '/assets/card.js',
      '/assets/index.js',
      '/assets/root.js',
      '/assets/users.js',
    ]);
    // The layout `settings` is on the way to the Appearance page, `users` is not.
    const appearance = routes['/settings/appearance']!;
    expect(appearance).toEqual(
      expect.arrayContaining(['/assets/settings.js', '/assets/appearance.js', '/assets/form.js']),
    );
    expect(appearance).not.toContain('/assets/users.js');
    // A file of the folder that is not a route (a leading dash) is no route.
    for (const files of Object.values(routes)) expect(files).not.toContain('/assets/helper.js');
  });

  it('leaves out what the start-up already preloads', () => {
    const routes = routeChunkFiles(bundle, new Set(['/assets/root.js', '/assets/card.js']));
    expect(routes['/users']).not.toContain('/assets/root.js');
    expect(routes['/users']).not.toContain('/assets/card.js');
    expect(routes['/users']).toContain('/assets/users.js');
  });

  it('is empty for a bundle without route files (negative fixture: the guard of the build)', () => {
    expectGuardFails(
      (input: Record<string, unknown>) => {
        expect(Object.keys(routeChunkFiles(input, new Set()))).not.toEqual([]);
      },
      { 'assets/a.js': chunk('assets/a.js', [], ['/w/src/lib/x.ts']) },
    );
  });
});

describe('the start block and the loader', () => {
  it('writes the entry and the preloads as JSON that cannot close the script element', () => {
    const text = startBlock('/assets/e</script>.js', ['/assets/a.js']);
    expect(text).not.toContain('</script');
    expect(JSON.parse(text)).toEqual({
      entry: '/assets/e</script>.js',
      preload: ['/assets/a.js'],
      routes: {},
    });
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
      '<div id="root"><div data-slot="static-shell" hidden>' +
      '<p><span data-shell-lang="en" hidden>Hello</span><span data-shell-lang="nl" hidden>Hallo</span></p>' +
      '<bdi data-shell-org></bdi><bdi data-shell-org></bdi></div></div>';
    return document;
  }
  const visible = (doc: Document): string[] =>
    [...doc.querySelectorAll<HTMLElement>('[data-shell-lang]')]
      .filter((element) => !element.hidden)
      .map((element) => element.textContent);

  it('writes the organisation name as text into every placeholder', () => {
    const doc = page(JSON.stringify({ branding: { orgName: '<b>شركة</b> & Co' } }));
    revealStaticShell(doc);
    const names = [...doc.querySelectorAll('[data-shell-org]')];
    expect(names.map((element) => element.textContent)).toEqual([
      '<b>شركة</b> & Co',
      '<b>شركة</b> & Co',
    ]);
    expect(doc.querySelector('[data-shell-org] b')).toBeNull();
  });

  it('has no preview banner to switch on any more: the boot data of an old server changes nothing (FR-B-102)', () => {
    const doc = page(
      JSON.stringify({ me: { features: { preview: true } }, branding: { orgName: 'Acme' } }),
    );
    revealStaticShell(doc);
    expect(doc.querySelector('[data-shell-banner]')).toBeNull();
    expect(doc.querySelector('[data-shell-org]')?.textContent).toBe('Acme');
  });

  it('shows the text of the language of the page and only that', () => {
    expect(visible(revealStaticShell_(page(null, 'en')))).toEqual(['Hello']);
    expect(visible(revealStaticShell_(page(null, 'nl')))).toEqual(['Hallo']);
    // A language the shell has no text for shows none (never the wrong one).
    expect(visible(revealStaticShell_(page(null, 'de')))).toEqual([]);
  });

  it('shows the shell itself, whatever the boot data says: the shell is hidden until this script ran', () => {
    for (const boot of [null, '{not json', JSON.stringify({ branding: null })]) {
      const doc = page(boot);
      expect(doc.querySelector<HTMLElement>('[data-slot="static-shell"]')!.hidden).toBe(true);
      revealStaticShell(doc);
      expect(doc.querySelector<HTMLElement>('[data-slot="static-shell"]')!.hidden).toBe(false);
    }
  });

  it('leaves the plain shell alone for missing, empty, broken or foreign boot data', () => {
    for (const boot of [null, '', '{not json', '[]', 'null', JSON.stringify({ branding: null })]) {
      const doc = page(boot);
      expect(() => {
        revealStaticShell(doc);
      }).not.toThrow();
      expect(doc.querySelector('[data-shell-org]')?.textContent).toBe('');
    }
  });
});

function revealStaticShell_(doc: Document): Document {
  revealStaticShell(doc);
  return doc;
}
