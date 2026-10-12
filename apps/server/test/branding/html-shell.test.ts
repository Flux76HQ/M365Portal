// T-A-091 (FR-A-095; PD-15; C6, C8; E-14): the HTML shell renderer. The six placeholders of the
// template are filled in ONE regex pass by a replacer function, so what is written in is never
// interpreted as a replacement pattern and never replaced again; every value is escaped for the place
// it lands in; the filled page is never cached.
import { readFileSync } from 'node:fs';
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { BrandingSchema } from '@m365portal/shared/schemas/branding';
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import { renderTokenCss } from '@m365portal/shared/tokens';
import { describe, expect, it } from 'vitest';
import { degradedBranding } from '../../src/branding/defaults.js';
import { createBrandingShell, escapeHtml, escapeJsonForScript } from '../../src/branding/shell.js';
import { createNonce } from '../../src/http/csp.js';
import { createPlaceholderShell, type ShellRenderer } from '../../src/shell-port.js';
import { createBrandingStorage, type BrandingStorage } from './branding-fixture.js';
import type { z } from 'zod';

const TEMPLATE = readFileSync(new URL('../fixtures/shell-template.html', import.meta.url), 'utf8');
const REQUEST = new Request('http://localhost:9300/users');
const STAFF = { actor: { kind: 'user', id: '00000000-0000-4000-8000-0000000000aa' } } as const;

type Me = z.infer<typeof MeResponseSchema>;

const me = (storageAvailable = true): Me => ({
  actor: { kind: 'user', id: '00000000-0000-4000-8000-0000000000aa', label: 'Alex' },
  permissions: ['settings:branding'],
  roles: [{ key: 'admin' }],
  session: {
    expiresAt: '2026-10-12T18:00:00.000Z',
    idleExpiresAt: '2026-10-12T10:30:00.000Z',
    mfa: true,
    stepUpValidUntil: null,
    groupsStale: false,
  },
  setup: { state: 'completed' },
  features: { showcase: false, breakGlass: false },
  adminConsentUrl: null,
  version: '1.2.3-test',
  publicOrigin: 'http://localhost:9300',
  storageAvailable,
});

function shellOf(storage: BrandingStorage, options: { template?: string } = {}): ShellRenderer {
  return createBrandingShell({
    template: options.template ?? TEMPLATE,
    service: storage.service,
    me: () => me(),
  });
}

async function rename(storage: BrandingStorage, orgName: string, accent = '#0078d4') {
  const current = storage.service.get();
  return storage.service.apply(
    { orgName, accent, logos: { light: null, dark: null, compact: null } },
    current.revision,
    STAFF,
  );
}

/** The text of the one boot element, found the way the browser finds it: by its id. */
function bootText(html: string): string {
  const found = [...html.matchAll(/<script\b[^>]*\bid="m365-boot"[^>]*>([\s\S]*?)<\/script>/g)];
  expect(found).toHaveLength(1);
  return found[0]?.[1] ?? '';
}

const nonceA = createNonce();
const nonceB = createNonce();

describe('the six placeholders (C8)', () => {
  it('leaves none behind and puts the nonce on every tag that carries it', async () => {
    const storage = await createBrandingStorage();
    const html = await shellOf(storage).render({ nonce: nonceA, request: REQUEST });
    expect(html).not.toMatch(/__M365_[A-Z_]+__/);
    const tags = TEMPLATE.match(/nonce="__M365_NONCE__"/g)?.length ?? 0;
    expect(tags).toBeGreaterThan(4);
    expect(html.split(`nonce="${nonceA}"`)).toHaveLength(tags + 1);
  });

  it('keeps the template outside the placeholders byte for byte (font preload, inlined css)', async () => {
    const storage = await createBrandingStorage();
    const html = await shellOf(storage).render({ nonce: nonceA, request: REQUEST });
    for (const kept of [
      '<link rel="preload" href="/assets/inter-latin.woff2" as="font" type="font/woff2" crossorigin />',
      'body {\n        margin: 0;\n      }',
      '<link rel="manifest" href="/manifest.webmanifest" />',
      `<script type="module" nonce="${nonceA}" src="/assets/index-abc.js"></script>`,
    ]) {
      expect(html).toContain(kept);
    }
  });

  it('fills a placeholder that occurs several times everywhere and the others once', async () => {
    const storage = await createBrandingStorage();
    const template = `${TEMPLATE}<p>__M365_TITLE__</p><p>__M365_TITLE__</p>`;
    const html = await shellOf(storage, { template }).render({ nonce: nonceA, request: REQUEST });
    expect(html).not.toContain('__M365_TITLE__');
    expect(html.match(/M365Portal/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a nonce that is not base64 (it is written into attributes)', async () => {
    const storage = await createBrandingStorage();
    const shell = shellOf(storage);
    for (const nonce of ['', 'short', 'a"b' + 'c'.repeat(30), '<script>' + 'a'.repeat(30)]) {
      await expect(shell.render({ nonce, request: REQUEST })).rejects.toThrow(TypeError);
    }
  });
});

describe('one pass, a replacer function: hostile names stay literal text', () => {
  const names = [
    '__M365_NONCE__',
    '$&',
    '$`',
    "$'",
    '$1 $$ $<x>',
    '__M365_BOOT_JSON__ __M365_TITLE__',
  ];
  it.each(names)('the name %j is text in the title and in the boot data', async (name) => {
    const storage = await createBrandingStorage();
    await rename(storage, name);
    const html = await shellOf(storage).render({ nonce: nonceA, request: REQUEST });
    expect(html).toContain(`<title>${escapeHtml(name)}</title>`);
    const boot = JSON.parse(bootText(html)) as { branding: { orgName: string }; me: Me };
    expect(boot.branding.orgName).toBe(name);
    // Nothing the name carried was replaced a second time.
    expect(html.split(`nonce="${nonceA}"`).length - 1).toBe(
      TEMPLATE.match(/nonce="__M365_NONCE__"/g)?.length,
    );
    expect(bootText(html).match(/__M365_NONCE__/g)?.length ?? 0).toBe(
      name.match(/__M365_NONCE__/g)?.length ?? 0,
    );
  });
});

describe('<title> is HTML escaped (E-14)', () => {
  it.each([
    '"><img src=x onerror=alert(1)>',
    '</title><script>alert(1)</script>',
    '<!--',
    "'&amp;",
  ])('the name %j is inert', async (name) => {
    const storage = await createBrandingStorage();
    await rename(storage, name);
    const html = await shellOf(storage).render({ nonce: nonceA, request: REQUEST });
    const title = /<title>([\s\S]*?)<\/title>/.exec(html);
    expect(title?.[1]).toBe(escapeHtml(name));
    expect(title?.[1]).not.toMatch(/[<>"']/);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('alert(1)</script>');
    // Exactly the scripts of the template: the name added none.
    const scripts = (html.match(/<script\b/g) ?? []).length;
    expect(scripts).toBe((TEMPLATE.match(/<script\b/g) ?? []).length);
    expect((html.match(/<\/title>/g) ?? []).length).toBe(1);
  });

  it('escapes the five characters and nothing else', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml('Zoë 日本 🇳🇱')).toBe('Zoë 日本 🇳🇱');
  });
});

describe('the boot data', () => {
  it('is the JSON text of { me, branding } inside the template element, parsed back whole', async () => {
    const storage = await createBrandingStorage();
    await rename(storage, 'Contoso');
    const html = await shellOf(storage).render({ nonce: nonceA, request: REQUEST });
    const boot = JSON.parse(bootText(html)) as { me: unknown; branding: unknown };
    expect(Object.keys(boot)).toEqual(['me', 'branding']);
    expect(MeResponseSchema.parse(boot.me)).toEqual(me());
    expect(BrandingSchema.parse(boot.branding)).toEqual(storage.service.get());
    // The template owns the element: one script element carries the boot id and the nonce.
    expect(html).toContain(`<script type="application/json" id="m365-boot" nonce="${nonceA}">`);
  });

  it('escapes <, U+2028 and U+2029 so no text can close the element or the line', async () => {
    const storage = await createBrandingStorage();
    const name = '</script><script>x</script><!-- a\u2028b\u2029c';
    // The normaliser refuses U+2028 and U+2029 in a name; the escaper is proven on the JSON itself.
    await rename(storage, '</script><script>x</script><!-- a');
    const html = await shellOf(storage).render({ nonce: nonceA, request: REQUEST });
    const text = bootText(html);
    expect(text).not.toContain('<');
    expect(text).toContain('\\u003c/script>');
    expect((JSON.parse(text) as { branding: { orgName: string } }).branding.orgName).toBe(
      '</script><script>x</script><!-- a',
    );
    const escaped = escapeJsonForScript(JSON.stringify({ name }));
    expect(escaped).not.toMatch(/[<\u2028\u2029]/);
    expect(JSON.parse(escaped)).toEqual({ name });
  });

  it('is only the JSON text: no second script element and no wrapping', async () => {
    const storage = await createBrandingStorage();
    const html = await shellOf(storage).render({ nonce: nonceA, request: REQUEST });
    expect(bootText(html).trim().startsWith('{"me":')).toBe(true);
    expect((html.match(/id="m365-boot"/g) ?? []).length).toBe(1);
  });
});

describe('the theme, the icons and the theme colour', () => {
  it('writes renderTokenCss of the derived accent tokens into the style element', async () => {
    const storage = await createBrandingStorage();
    const branding = await rename(storage, 'Contoso', '#3b82f6');
    const html = await shellOf(storage).render({ nonce: nonceA, request: REQUEST });
    const expected = renderTokenCss({ accent: deriveAccentTokens('#3b82f6') });
    expect(html).toContain(expected);
    expect(branding.accent).toBe('#3b82f6');
    expect(html).toContain('--accent: #3b82f6');
  });

  it('links the hashed icons and sets theme-color to the effective light accent', async () => {
    const storage = await createBrandingStorage();
    const branding = await rename(storage, 'Contoso', '#ffff00');
    const html = await shellOf(storage).render({ nonce: nonceA, request: REQUEST });
    expect(html).toContain(
      `<link rel="icon" type="image/png" sizes="32x32" href="${branding.icons.favicon32.url}">`,
    );
    expect(html).toContain(
      `<link rel="apple-touch-icon" sizes="180x180" href="${branding.icons.appleTouch180.url}">`,
    );
    expect(html).toContain(`<meta name="theme-color" content="${branding.tokens.light.accent}" />`);
    expect(branding.tokens.light.accent).not.toBe('#ffff00');
    // The manifest link is the template's own.
    expect(html.match(/rel="manifest"/g)).toHaveLength(1);
  });
});

describe('a filled shell is never reused', () => {
  it('gives two requests two bodies with two nonces and no shared state', async () => {
    const storage = await createBrandingStorage();
    const shell = shellOf(storage);
    const [first, second] = await Promise.all([
      shell.render({ nonce: nonceA, request: REQUEST }),
      shell.render({ nonce: nonceB, request: REQUEST }),
    ]);
    expect(first).not.toBe(second);
    expect(first).toContain(nonceA);
    expect(first).not.toContain(nonceB);
    expect(second).toContain(nonceB);
    expect(second).not.toContain(nonceA);
    // Same nonce again is the same page (no hidden counter), a new revision a new page.
    expect(await shell.render({ nonce: nonceA, request: REQUEST })).toBe(first);
    await rename(storage, 'Changed');
    expect(await shell.render({ nonce: nonceA, request: REQUEST })).not.toBe(first);
  });

  it('asks the branding on every render', async () => {
    const storage = await createBrandingStorage();
    let reads = 0;
    const shell = createBrandingShell({
      template: TEMPLATE,
      service: {
        get: () => {
          reads += 1;
          return storage.service.get();
        },
      },
      me: () => me(),
    });
    await shell.render({ nonce: nonceA, request: REQUEST });
    await shell.render({ nonce: nonceB, request: REQUEST });
    expect(reads).toBe(2);
  });

  it('asks me per request', async () => {
    const storage = await createBrandingStorage();
    const seen: string[] = [];
    const shell = createBrandingShell({
      template: TEMPLATE,
      service: storage.service,
      me: (request) => {
        seen.push(new URL(request.url).pathname);
        return me();
      },
    });
    await shell.render({ nonce: nonceA, request: new Request('http://localhost/a') });
    await shell.render({ nonce: nonceA, request: new Request('http://localhost/b') });
    expect(seen).toEqual(['/a', '/b']);
  });
});

describe('degraded mode', () => {
  it('renders the in-memory defaults with no icon links', async () => {
    const storage = await createBrandingStorage();
    await rename(storage, 'Contoso');
    storage.setStorageAvailable(false);
    const html = await createBrandingShell({
      template: TEMPLATE,
      service: storage.service,
      me: () => me(false),
    }).render({ nonce: nonceA, request: REQUEST });
    const defaults = degradedBranding();
    expect(html).toContain('<title>M365Portal</title>');
    expect(html).not.toContain('rel="icon"');
    expect(html).not.toContain('apple-touch-icon');
    expect(html).not.toContain('/branding/');
    expect(html).toContain(`<meta name="theme-color" content="${defaults.tokens.light.accent}" />`);
    expect(html).toContain(renderTokenCss({ accent: deriveAccentTokens(defaults.accent) }));
    expect(html).not.toMatch(/__M365_[A-Z_]+__/);
    const boot = JSON.parse(bootText(html)) as { me: Me; branding: unknown };
    expect(boot.me.storageAvailable).toBe(false);
    expect(boot.branding).toBeNull();
  });
});

describe('the ShellRenderer port (C6)', () => {
  it('is a drop-in for the placeholder shell and fills what the placeholder leaves', async () => {
    const storage = await createBrandingStorage();
    const placeholder = await createPlaceholderShell(TEMPLATE).render({
      nonce: nonceA,
      request: REQUEST,
    });
    expect(placeholder).toContain('__M365_TITLE__');
    const real = await shellOf(storage).render({ nonce: nonceA, request: REQUEST });
    expect(real).not.toContain('__M365_TITLE__');
  });

  it('throws for a non-storage failure of the service instead of rendering a wrong page', async () => {
    const shell = createBrandingShell({
      template: TEMPLATE,
      service: {
        get: () => {
          throw new Error('boom');
        },
      },
      me: () => me(),
    });
    await expect(shell.render({ nonce: nonceA, request: REQUEST })).rejects.toThrow('boom');
  });
});
