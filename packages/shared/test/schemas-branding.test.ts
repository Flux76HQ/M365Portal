// T-A-074, gate G2a, C10, FR-A-080, FR-A-093, FR-A-094 (shape): the wire schemas of the branding API
// (contract sections 4, 5 and 8.1): `schemas/branding.ts`, `schemas/assets.ts`,
// `schemas/export-import.ts` and `schemas/manifest.ts`. The server routes, the OpenAPI document and
// the web app share them, so each schema is checked with the values it must accept and, as important,
// the values it must refuse.
//
// What every schema must be (contract 8.1, 8.4): an OpenAPI component (`.meta({ id })`, the id is the
// constant name without the suffix), convertible to JSON Schema in both directions, and free of
// transforms (a transform cannot be written in OpenAPI; normalisation happens in the service through
// the shared normalisers). Parsing a valid value returns it unchanged.
//
// The examples are built from the real producers (`deriveAccentTokens`, `monogramFor`,
// `normalizeOrgName`), so a schema that disagrees with the code that fills it fails here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deriveAccentTokens } from '../src/branding/accent.js';
import { monogramFor } from '../src/branding/monogram.js';
import { DEFAULT_ORG_NAME, normalizeOrgName } from '../src/branding/org-name.js';
import { LIMITS } from '../src/limits.js';
import * as assets from '../src/schemas/assets.js';
import * as branding from '../src/schemas/branding.js';
import * as exportImport from '../src/schemas/export-import.js';
import * as manifest from '../src/schemas/manifest.js';
import { expectGuardFails } from '../src/testing/index.js';

const {
  AccentTokenSetSchema,
  ApplyBrandingRequestSchema,
  AssetRefSchema,
  BrandingSchema,
  IconRefSchema,
  IconSetSchema,
  IfMatchHeaderSchema,
  MonogramGlyphSchema,
  MonogramSchema,
  OrgNameInputSchema,
  OrgNameSchema,
  ThemeTokensSchema,
} = branding;
const {
  AssetSlotSchema,
  StagedAssetSchema,
  SvgContentCategorySchema,
  UploadAssetQuerySchema,
  UploadAssetResponseSchema,
  UploadWarningSchema,
} = assets;
const {
  Base64PngSchema,
  BrandingExportSchema,
  ImportQuerySchema,
  ImportResultSchema,
  ImportedImageSummarySchema,
} = exportImport;
const { ManifestIconSchema, WebManifestSchema } = manifest;

/** Parse and report only whether it passed; the failure tests look at the messages separately. */
const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

/** The messages of every issue of a failed parse, with the path they are at. */
function issuesOf(schema: z.ZodType, value: unknown): { path: string; message: string }[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('/'),
    message: issue.message,
  }));
}

const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex');
const assetUrl = (hash: string): string => `/branding/${hash}.png`;

/** Everything except `key`. */
const without = (value: object, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

// ---------------------------------------------------------------------------------------------
// Fixtures built from the real producers
// ---------------------------------------------------------------------------------------------

const assetRef = (seed: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  hash: sha(seed),
  url: assetUrl(sha(seed)),
  width: 512,
  height: 256,
  luminance: 0.42,
  ...extra,
});

const iconRef = (seed: string): Record<string, unknown> => ({
  hash: sha(seed),
  url: assetUrl(sha(seed)),
});

const icons = (): Record<string, unknown> => ({
  favicon32: iconRef('favicon32'),
  appleTouch180: iconRef('appleTouch180'),
  pwa192: iconRef('pwa192'),
  pwa512: iconRef('pwa512'),
  maskable512: iconRef('maskable512'),
});

/** The default branding of a fresh installation (PD-12): name M365Portal, no logos, monogram icons. */
function defaultBranding(): Record<string, unknown> {
  return {
    revision: 1,
    orgName: DEFAULT_ORG_NAME,
    isDefaultName: true,
    accent: '#0078d4',
    tokens: deriveAccentTokens('#0078d4'),
    logos: { light: null, dark: null, compact: null },
    compactDerived: false,
    icons: icons(),
    monogram: monogramFor(DEFAULT_ORG_NAME),
    updatedAt: '2026-10-10T12:00:00.000Z',
  };
}

/** A branding with all three logos, the compact one derived. */
function loadedBranding(): Record<string, unknown> {
  return {
    ...defaultBranding(),
    revision: 7,
    orgName: 'Acme Vereniging',
    isDefaultName: false,
    accent: '#ff8800',
    tokens: deriveAccentTokens('#ff8800'),
    logos: { light: assetRef('light'), dark: assetRef('dark'), compact: assetRef('compact') },
    compactDerived: true,
    monogram: monogramFor('Acme Vereniging'),
  };
}

const applyRequest = (): Record<string, unknown> => ({
  orgName: 'Acme Vereniging',
  accent: '#0078D4',
  logos: { light: sha('light'), dark: null, compact: null },
});

const exportDocument = (): Record<string, unknown> => ({
  schemaVersion: 1,
  orgName: 'Acme Vereniging',
  accent: '#0078d4',
  images: { logoLight: 'iVBORw0KGgo=', logoDark: null, compact: null },
});

const importedImage = (seed: string): Record<string, unknown> => ({
  hash: sha(seed),
  width: 512,
  height: 512,
  bytes: 4096,
  warnings: [],
});

const webManifest = (): Record<string, unknown> => ({
  id: '/',
  name: 'Acme Vereniging',
  short_name: 'Acme Verenig',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  theme_color: '#0078d4',
  background_color: '#f3f5f8',
  icons: [
    { src: assetUrl(sha('pwa192')), sizes: '192x192', type: 'image/png' },
    { src: assetUrl(sha('pwa512')), sizes: '512x512', type: 'image/png' },
    { src: assetUrl(sha('maskable512')), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

// ---------------------------------------------------------------------------------------------
// Organisation name
// ---------------------------------------------------------------------------------------------

describe('OrgNameInputSchema and OrgNameSchema (FR-A-081)', () => {
  it('the input form accepts anything the normaliser accepts and returns it unchanged', () => {
    for (const name of [
      'Acme',
      '  Acme   Corp ',
      'Cafe\u{301}',
      '"><img src=x onerror=alert(1)>',
      DEFAULT_ORG_NAME,
    ]) {
      const parsed = OrgNameInputSchema.parse(name);
      expect(parsed).toBe(name);
    }
  });

  it('the input form refuses what the normaliser refuses, with the message org_name_invalid', () => {
    for (const name of [
      '',
      '   ',
      'a'.repeat(65),
      'Ac\u{200B}me',
      'Ac\u{202E}me',
      'Ac\u{0}me',
      '\u{2800}',
      42,
      null,
      undefined,
      {},
    ]) {
      const issues = issuesOf(OrgNameInputSchema, name);
      const label = typeof name === 'string' ? JSON.stringify(name) : typeof name;
      expect(issues.length, label).toBeGreaterThan(0);
      expect(issues[0]?.message, label).toBe('org_name_invalid');
    }
  });

  it('the stored form accepts only a name the normaliser would leave as it is', () => {
    for (const name of [
      'Acme',
      DEFAULT_ORG_NAME,
      normalizeOrgName('  Acme   Corp '),
      'Caf\u{E9}',
    ]) {
      expect(accepts(OrgNameSchema, name), name).toBe(true);
    }
    for (const name of ['  Acme', 'Acme  ', 'Acme   Corp', 'Cafe\u{301}', '', 'Ac\u{200B}me']) {
      expect(accepts(OrgNameSchema, name), JSON.stringify(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Tokens, asset references, icons, monogram
// ---------------------------------------------------------------------------------------------

describe('AccentTokenSetSchema and ThemeTokensSchema (C9)', () => {
  it('accept the real output of deriveAccentTokens for many colours', () => {
    for (const hex of [
      '#0078d4',
      '#ffff00',
      '#ffffff',
      '#000000',
      '#3b82f6',
      '#ff8800',
      '#123456',
      '#abcdef',
    ]) {
      const tokens = deriveAccentTokens(hex);
      expect(accepts(ThemeTokensSchema, tokens), hex).toBe(true);
      expect(accepts(AccentTokenSetSchema, tokens.light), hex).toBe(true);
      expect(accepts(AccentTokenSetSchema, tokens.dark), hex).toBe(true);
    }
  });

  const light = deriveAccentTokens('#0078d4').light;

  it.each([
    ['a missing adjusted flag', without(light, 'adjusted')],
    ['adjusted as text', { ...light, adjusted: 'false' }],
    ['a missing colour', without(light, 'accentHover')],
    ['an upper-case colour', { ...light, accent: '#0078D4' }],
    ['a short colour', { ...light, onAccent: '#fff' }],
    ['a colour name', { ...light, focusRing: 'blue' }],
    ['a colour with an alpha channel', { ...light, accentSubtle: '#0078d4ff' }],
    ['an extra member', { ...light, shadow: '#000000' }],
  ])('AccentTokenSet rejects %s', (_label, value) => {
    expect(accepts(AccentTokenSetSchema, value)).toBe(false);
  });

  it('ThemeTokens needs both themes and nothing else', () => {
    const tokens = deriveAccentTokens('#0078d4');
    expect(accepts(ThemeTokensSchema, { light: tokens.light })).toBe(false);
    expect(accepts(ThemeTokensSchema, { dark: tokens.dark })).toBe(false);
    expect(accepts(ThemeTokensSchema, { ...tokens, system: tokens.light })).toBe(false);
  });
});

describe('brandingAssetUrl (R12)', () => {
  it('is the one spelling of the url of a branding file, and what the schemas compare with', () => {
    expect(branding.brandingAssetUrl(sha('a'))).toBe(`/branding/${sha('a')}.png`);
    expect(
      branding.urlMatchesHash({ hash: sha('a'), url: branding.brandingAssetUrl(sha('a')) }),
    ).toBe(true);
    expect(
      branding.urlMatchesHash({ hash: sha('a'), url: branding.brandingAssetUrl(sha('b')) }),
    ).toBe(false);
    expect(
      branding.urlMatchesHash({ hash: sha('a'), url: `${branding.brandingAssetUrl(sha('a'))}?x` }),
    ).toBe(false);
  });
});

describe('AssetRefSchema (FR-A-080, FR-A-090)', () => {
  it('accepts a reference whose url is /branding/<hash>.png', () => {
    expect(accepts(AssetRefSchema, assetRef('a'))).toBe(true);
    expect(accepts(AssetRefSchema, assetRef('a', { luminance: null }))).toBe(true);
    expect(accepts(AssetRefSchema, assetRef('a', { luminance: 0 }))).toBe(true);
    expect(accepts(AssetRefSchema, assetRef('a', { luminance: 1, width: 1, height: 1024 }))).toBe(
      true,
    );
  });

  it.each([
    ['the url of another hash', { url: assetUrl(sha('other')) }],
    ['an absolute url', { url: `https://evil.example${assetUrl(sha('a'))}` }],
    ['a protocol-relative url', { url: `//evil.example${assetUrl(sha('a'))}` }],
    ['a query string', { url: `${assetUrl(sha('a'))}?x=1` }],
    ['another extension', { url: `/branding/${sha('a')}.svg` }],
    ['another folder', { url: `/assets/${sha('a')}.png` }],
    ['a traversal', { url: `/branding/../${sha('a')}.png` }],
    ['an upper-case hash', { hash: sha('a').toUpperCase(), url: assetUrl(sha('a').toUpperCase()) }],
    ['a short hash', { hash: sha('a').slice(1), url: assetUrl(sha('a').slice(1)) }],
    ['a width of 0', { width: 0 }],
    ['a width above 1024', { width: 1025 }],
    ['a fractional height', { height: 1.5 }],
    ['a luminance below 0', { luminance: -0.01 }],
    ['a luminance above 1', { luminance: 1.01 }],
    ['a luminance as text', { luminance: '0.5' }],
    ['an extra member', { createdAt: '2026-10-10T12:00:00.000Z' }],
  ])('rejects %s', (_label, change) => {
    expect(accepts(AssetRefSchema, assetRef('a', change))).toBe(false);
  });

  it.each(['hash', 'url', 'width', 'height', 'luminance'])(
    'rejects a reference without %s',
    (key) => {
      expect(accepts(AssetRefSchema, without(assetRef('a'), key))).toBe(false);
    },
  );

  it('reports the url as the member at fault when it does not match the hash', () => {
    const issues = issuesOf(AssetRefSchema, assetRef('a', { url: assetUrl(sha('other')) }));
    expect(issues.map((issue) => issue.path)).toContain('url');
  });
});

describe('IconRefSchema and IconSetSchema', () => {
  it('accept a reference and the five icons of the contract', () => {
    expect(accepts(IconRefSchema, iconRef('x'))).toBe(true);
    expect(accepts(IconSetSchema, icons())).toBe(true);
  });

  it.each(['favicon32', 'appleTouch180', 'pwa192', 'pwa512', 'maskable512'])(
    'IconSet needs %s',
    (key) => {
      expect(accepts(IconSetSchema, without(icons(), key))).toBe(false);
    },
  );

  it('rejects a mismatched url, an extra icon and extra members', () => {
    expect(accepts(IconRefSchema, { hash: sha('x'), url: assetUrl(sha('y')) })).toBe(false);
    expect(accepts(IconRefSchema, { ...iconRef('x'), width: 32 })).toBe(false);
    expect(accepts(IconSetSchema, { ...icons(), favicon16: iconRef('f16') })).toBe(false);
    expect(accepts(IconSetSchema, { ...icons(), pwa512: { ...iconRef('x'), url: '/x.png' } })).toBe(
      false,
    );
  });
});

describe('MonogramGlyphSchema and MonogramSchema (FR-A-092)', () => {
  it('accept what monogramFor returns for names in many scripts', () => {
    const names = [
      'Acme Corp',
      '\u{E9}lan vital',
      '\u{D8}rsted',
      '\u{1F680} Rocket',
      '3M',
      '\u{682A}\u{5F0F}\u{4F1A}\u{793E}',
      '',
      DEFAULT_ORG_NAME,
      '\u{42F}\u{43D}\u{434}\u{435}\u{43A}\u{441} \u{41C}',
      '"><img src=x onerror=alert(1)>',
    ];
    for (const name of names) {
      const monogram = monogramFor(name);
      expect(accepts(MonogramSchema, monogram), name).toBe(true);
      for (const glyph of monogram.glyphs)
        expect(accepts(MonogramGlyphSchema, glyph), name).toBe(true);
    }
  });

  const glyph = { key: 'A', x: 0, advance: 1026, path: 'M259 1000h-226l341-1000h269z' };

  it.each([
    ['a lower-case key', { key: 'a' }],
    ['a key of two letters', { key: 'AB' }],
    ['an unknown key name', { key: 'logo' }],
    ['a negative offset', { x: -1 }],
    ['a fractional offset', { x: 0.5 }],
    ['an advance of 0', { advance: 0 }],
    ['an empty path', { path: '' }],
    ['a path that breaks out of the attribute', { path: 'M0 0z"/><script>alert(1)</script>' }],
    ['a path with a letter outside the subset', { path: 'M0 0c1 1 2 2 3 3z' }],
    ['a path with a decimal', { path: 'M0 0h1.5z' }],
    ['a path that does not start with M', { path: 'h5v5z' }],
    ['a path that does not end with z', { path: 'M0 0h5v5' }],
    ['a path of over 2,048 characters', { path: `M0 0${'h1'.repeat(1023)}z` }],
    ['an extra member', { color: 'red' }],
  ])('MonogramGlyph rejects %s', (_label, change) => {
    expect(accepts(MonogramGlyphSchema, { ...glyph, ...change })).toBe(false);
  });

  it('accepts the pictogram key', () => {
    expect(accepts(MonogramGlyphSchema, { ...glyph, key: 'pictogram' })).toBe(true);
  });

  it('Monogram needs the layout of the contract: the first glyph at 0, each next one after the advance before it', () => {
    const monogram = monogramFor('Acme Corp');
    const [first, second] = monogram.glyphs;
    expect(first?.x).toBe(0);
    expect(accepts(MonogramSchema, { ...monogram, glyphs: [{ ...first, x: 5 }, second] })).toBe(
      false,
    );
    expect(
      accepts(MonogramSchema, {
        ...monogram,
        glyphs: [first, { ...second, x: (second?.x ?? 0) + 1 }],
      }),
    ).toBe(false);
    expect(accepts(MonogramSchema, { ...monogram, glyphs: [first, { ...second, x: 0 }] })).toBe(
      false,
    );
    const issues = issuesOf(MonogramSchema, { ...monogram, glyphs: [{ ...first, x: 5 }, second] });
    expect(issues.map((issue) => issue.path)).toContain('glyphs');
  });

  it('Monogram needs one or two glyphs, initials of at most 256 characters, and a fallback flag that tells the truth', () => {
    const monogram = monogramFor('Acme Corp');
    expect(accepts(MonogramSchema, { ...monogram, glyphs: [] })).toBe(false);
    expect(
      accepts(MonogramSchema, { ...monogram, glyphs: [...monogram.glyphs, ...monogram.glyphs] }),
    ).toBe(false);
    expect(accepts(MonogramSchema, { ...monogram, initials: 'x'.repeat(257) })).toBe(false);
    expect(accepts(MonogramSchema, without(monogram, 'fallback'))).toBe(false);
    expect(accepts(MonogramSchema, { ...monogram, extra: 1 })).toBe(false);
    // fallback true with letters, fallback false with the pictogram: the flag lies.
    expect(accepts(MonogramSchema, { ...monogram, fallback: true })).toBe(false);
    const picture = monogramFor('\u{682A}');
    expect(accepts(MonogramSchema, { ...picture, fallback: false })).toBe(false);
    // The pictogram never sits next to a letter.
    expect(
      accepts(MonogramSchema, {
        initials: 'A',
        fallback: false,
        glyphs: [{ ...glyph }, { ...glyph, key: 'pictogram', x: 1026 }],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Branding (R6)
// ---------------------------------------------------------------------------------------------

describe('BrandingSchema (R6, FR-A-080)', () => {
  it('accepts the default branding of a fresh installation', () => {
    expect(accepts(BrandingSchema, defaultBranding())).toBe(true);
  });

  it('accepts a branding with three logos and a derived compact variant', () => {
    expect(accepts(BrandingSchema, loadedBranding())).toBe(true);
  });

  it('returns a valid value unchanged: nothing is transformed, stripped or defaulted', () => {
    for (const value of [defaultBranding(), loadedBranding()]) {
      expect(BrandingSchema.parse(value)).toEqual(value);
    }
  });

  it.each([
    'revision',
    'orgName',
    'isDefaultName',
    'accent',
    'tokens',
    'logos',
    'compactDerived',
    'icons',
    'monogram',
    'updatedAt',
  ])('rejects a branding without %s', (key) => {
    expect(accepts(BrandingSchema, without(defaultBranding(), key))).toBe(false);
  });

  it.each([
    ['updatedBy', { kind: 'preview', id: 'preview' }],
    ['updatedByKind', 'preview'],
    ['updatedById', 'preview'],
    ['actor', { kind: 'preview', id: 'preview', label: 'Preview' }],
    ['updatedBySub', 'someone'],
    ['email', 'a@example.com'],
  ])('exposes no actor identity: a member named %s is refused', (key, value) => {
    expect(accepts(BrandingSchema, { ...defaultBranding(), [key]: value })).toBe(false);
  });

  it.each([
    ['a revision of 0', { revision: 0 }],
    ['a negative revision', { revision: -1 }],
    ['a fractional revision', { revision: 1.5 }],
    ['a revision as text', { revision: '3' }],
    ['an unnormalised name', { orgName: '  Acme ', isDefaultName: false }],
    ['an invalid name', { orgName: 'Ac\u{200B}me', isDefaultName: false }],
    ['an empty name', { orgName: '', isDefaultName: false }],
    ['a default-name flag that is true for another name', { orgName: 'Acme', isDefaultName: true }],
    ['a default-name flag that is false for the default name', { isDefaultName: false }],
    ['an upper-case accent', { accent: '#0078D4' }],
    ['a short accent', { accent: '#07d' }],
    ['a timestamp without milliseconds', { updatedAt: '2026-10-10T12:00:00Z' }],
    ['a timestamp with an offset', { updatedAt: '2026-10-10T12:00:00.000+02:00' }],
    ['compactDerived without a compact logo', { compactDerived: true }],
    ['compactDerived as text', { compactDerived: 'no' }],
  ])('rejects %s', (_label, change) => {
    expect(accepts(BrandingSchema, { ...defaultBranding(), ...change })).toBe(false);
  });

  it('rejects broken parts: tokens, logos, icons, monogram', () => {
    const base = defaultBranding();
    const tokens = deriveAccentTokens('#0078d4');
    expect(accepts(BrandingSchema, { ...base, tokens: { light: tokens.light } })).toBe(false);
    expect(
      accepts(BrandingSchema, {
        ...base,
        tokens: { ...tokens, dark: without(tokens.dark, 'adjusted') },
      }),
    ).toBe(false);
    expect(accepts(BrandingSchema, { ...base, logos: { light: null, dark: null } })).toBe(false);
    expect(
      accepts(BrandingSchema, {
        ...base,
        logos: { light: null, dark: null, compact: null, extra: null },
      }),
    ).toBe(false);
    expect(
      accepts(BrandingSchema, { ...base, logos: { light: 'x', dark: null, compact: null } }),
    ).toBe(false);
    expect(
      accepts(BrandingSchema, {
        ...base,
        logos: { light: assetRef('l', { url: '/x.png' }), dark: null, compact: null },
      }),
    ).toBe(false);
    expect(accepts(BrandingSchema, { ...base, icons: without(icons(), 'pwa192') })).toBe(false);
    expect(accepts(BrandingSchema, { ...base, icons: { ...icons(), extra: iconRef('e') } })).toBe(
      false,
    );
    expect(accepts(BrandingSchema, { ...base, monogram: { initials: 'M', fallback: false } })).toBe(
      false,
    );
    expect(
      accepts(BrandingSchema, { ...base, monogram: { ...monogramFor('Acme'), fallback: true } }),
    ).toBe(false);
  });

  it('is built from valid parts only: a dark and a compact logo may be null on their own', () => {
    const base = loadedBranding();
    const logos = base.logos as Record<string, unknown>;
    expect(accepts(BrandingSchema, { ...base, logos: { ...logos, dark: null } })).toBe(true);
    expect(
      accepts(BrandingSchema, {
        ...base,
        logos: { ...logos, light: null, dark: null },
        compactDerived: false,
      }),
    ).toBe(true);
    expect(accepts(BrandingSchema, { ...base, compactDerived: false })).toBe(true);
  });

  it('names the member at fault', () => {
    const issues = issuesOf(BrandingSchema, { ...defaultBranding(), compactDerived: true });
    expect(issues.map((issue) => issue.path)).toContain('compactDerived');
    const flag = issuesOf(BrandingSchema, { ...defaultBranding(), isDefaultName: false });
    expect(flag.map((issue) => issue.path)).toContain('isDefaultName');
  });
});

// ---------------------------------------------------------------------------------------------
// Apply (R8) and the If-Match header
// ---------------------------------------------------------------------------------------------

describe('ApplyBrandingRequestSchema (R8)', () => {
  it('accepts the example of the contract, and returns it unchanged (no normalisation here)', () => {
    const request = applyRequest();
    expect(ApplyBrandingRequestSchema.parse(request)).toEqual(request);
    expect(
      accepts(ApplyBrandingRequestSchema, {
        ...request,
        accent: '#abc',
        orgName: '  Acme   Corp ',
      }),
    ).toBe(true);
  });

  it('accepts three logos and no logos', () => {
    expect(
      accepts(ApplyBrandingRequestSchema, {
        ...applyRequest(),
        logos: { light: sha('a'), dark: sha('b'), compact: sha('c') },
      }),
    ).toBe(true);
    expect(
      accepts(ApplyBrandingRequestSchema, {
        ...applyRequest(),
        logos: { light: null, dark: null, compact: null },
      }),
    ).toBe(true);
  });

  it('is strict: an unknown key is refused, at the top and inside logos', () => {
    expect(accepts(ApplyBrandingRequestSchema, { ...applyRequest(), revision: 3 })).toBe(false);
    expect(accepts(ApplyBrandingRequestSchema, { ...applyRequest(), isDefaultName: false })).toBe(
      false,
    );
    expect(
      accepts(ApplyBrandingRequestSchema, {
        ...applyRequest(),
        logos: { light: null, dark: null, compact: null, icon: null },
      }),
    ).toBe(false);
  });

  it('refuses a request body with a __proto__ or constructor member', () => {
    const hostile = JSON.parse(
      '{"orgName":"Acme","accent":"#0078d4","logos":{"light":null,"dark":null,"compact":null},"__proto__":{"admin":true}}',
    ) as unknown;
    expect(accepts(ApplyBrandingRequestSchema, hostile)).toBe(false);
    expect(
      accepts(ApplyBrandingRequestSchema, { ...applyRequest(), constructor: { prototype: {} } }),
    ).toBe(false);
  });

  it.each(['orgName', 'accent', 'logos'])(
    'needs %s (replacement semantics: the whole branding is sent)',
    (key) => {
      expect(accepts(ApplyBrandingRequestSchema, without(applyRequest(), key))).toBe(false);
    },
  );

  it.each(['light', 'dark', 'compact'])(
    'needs the logos member %s, null when there is none',
    (key) => {
      const logos = { light: null, dark: null, compact: null };
      expect(
        accepts(ApplyBrandingRequestSchema, { ...applyRequest(), logos: without(logos, key) }),
      ).toBe(false);
    },
  );

  it.each([
    ['#12345', 'accent_invalid'],
    ['#1234567', 'accent_invalid'],
    ['0078d4', 'accent_invalid'],
    ['red', 'accent_invalid'],
    ['#GGGGGG', 'accent_invalid'],
    ['rgb(0,0,0)', 'accent_invalid'],
    ['#0078d4 ', 'accent_invalid'],
    ['', 'accent_invalid'],
    [null, 'accent_invalid'],
    [12, 'accent_invalid'],
  ])('refuses the accent %j with the message %s', (accent, message) => {
    const issues = issuesOf(ApplyBrandingRequestSchema, { ...applyRequest(), accent });
    expect(issues).toEqual([{ path: 'accent', message }]);
  });

  it.each([
    ['', 'org_name_invalid'],
    ['   ', 'org_name_invalid'],
    ['a'.repeat(65), 'org_name_invalid'],
    ['Ac\u{200E}me', 'org_name_invalid'],
    ['Ac\u{0}me', 'org_name_invalid'],
    [42, 'org_name_invalid'],
    [null, 'org_name_invalid'],
  ])('refuses the name %j with the message %s', (orgName, message) => {
    const issues = issuesOf(ApplyBrandingRequestSchema, { ...applyRequest(), orgName });
    expect(issues).toEqual([{ path: 'orgName', message }]);
  });

  it.each([
    ['an upper-case hash', { light: sha('a').toUpperCase(), dark: null, compact: null }],
    ['a short hash', { light: sha('a').slice(2), dark: null, compact: null }],
    ['a url instead of a hash', { light: assetUrl(sha('a')), dark: null, compact: null }],
    ['an asset reference instead of a hash', { light: assetRef('a'), dark: null, compact: null }],
    ['an empty string', { light: '', dark: null, compact: null }],
  ])('refuses logos with %s', (_label, logos) => {
    expect(accepts(ApplyBrandingRequestSchema, { ...applyRequest(), logos })).toBe(false);
  });
});

describe('IfMatchHeaderSchema (contract section 1, FR-A-083)', () => {
  it.each(['"3"', '"1"', '"0"', '"42"', '"999999999999999"'])(
    'accepts the strong quoted integer %s',
    (value) => {
      expect(IfMatchHeaderSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    ['an unquoted integer', '3'],
    ['a weak validator', 'W/"3"'],
    ['a single quote', "'3'"],
    ['a missing closing quote', '"3'],
    ['a missing opening quote', '3"'],
    ['a leading zero', '"03"'],
    ['a negative number', '"-1"'],
    ['a decimal', '"1.5"'],
    ['an exponent', '"1e3"'],
    ['a plus sign', '"+3"'],
    ['an empty tag', '""'],
    ['the wildcard', '*'],
    ['a list', '"1", "2"'],
    ['a leading space', ' "3"'],
    ['a trailing space', '"3" '],
    ['a trailing newline', '"3"\n'],
    ['sixteen digits', '"1234567890123456"'],
    ['a fullwidth digit', '"\u{FF13}"'],
    ['letters', '"abc"'],
    ['a hash instead of a revision', `"${sha('x')}"`],
    ['an empty header', ''],
  ])('rejects %s', (_label, value) => {
    expect(accepts(IfMatchHeaderSchema, value)).toBe(false);
  });

  it.each([3, null, undefined, {}, ['"3"']])('rejects the non-string %j', (value) => {
    expect(accepts(IfMatchHeaderSchema, value)).toBe(false);
  });

  it('has one spelling for the ETag the server sends and the If-Match the client sends', () => {
    expect(branding.revisionEtag(3)).toBe('"3"');
    expect(branding.revisionEtag(1_000_000)).toBe('"1000000"');
    expect(accepts(IfMatchHeaderSchema, branding.revisionEtag(12))).toBe(true);
    expect(branding.parseRevisionEtag('"3"')).toBe(3);
    expect(branding.parseRevisionEtag('"0"')).toBe(0);
    expect(branding.parseRevisionEtag(branding.revisionEtag(987_654))).toBe(987_654);
    for (const value of ['3', 'W/"3"', '"03"', '"-1"', '"1.5"', '', '*', '"1", "2"']) {
      expect(branding.parseRevisionEtag(value), value).toBeNull();
    }
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => branding.revisionEtag(value), String(value)).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Assets (R7)
// ---------------------------------------------------------------------------------------------

describe('AssetSlotSchema and UploadAssetQuerySchema (R7)', () => {
  it('accept the three slots of the contract', () => {
    for (const slot of ['logoLight', 'logoDark', 'compact']) {
      expect(accepts(AssetSlotSchema, slot)).toBe(true);
      expect(accepts(UploadAssetQuerySchema, { slot })).toBe(true);
    }
  });

  it.each(['logo', 'LogoLight', 'logolight', 'light', 'icon', '', ' compact', 'compact '])(
    'refuse the slot %j',
    (slot) => {
      expect(accepts(AssetSlotSchema, slot)).toBe(false);
      expect(accepts(UploadAssetQuerySchema, { slot })).toBe(false);
    },
  );

  it('the query needs a slot, refuses an unknown parameter and a repeated one', () => {
    expect(accepts(UploadAssetQuerySchema, {})).toBe(false);
    expect(accepts(UploadAssetQuerySchema, { slot: 'compact', t: '1' })).toBe(false);
    expect(accepts(UploadAssetQuerySchema, { slot: ['logoLight', 'logoDark'] })).toBe(false);
    expect(accepts(UploadAssetQuerySchema, { slot: undefined })).toBe(false);
  });
});

describe('UploadWarningSchema (R7, contract section 6)', () => {
  it('lists the eleven categories of the contract, in its order', () => {
    expect(assets.SVG_CONTENT_CATEGORIES).toEqual([
      'script',
      'event_handler',
      'external_reference',
      'foreign_object',
      'style',
      'animation',
      'filter',
      'unknown_element',
      'unknown_attribute',
      'processing_instruction',
      'unresolved_reference',
    ]);
    for (const category of assets.SVG_CONTENT_CATEGORIES) {
      expect(accepts(SvgContentCategorySchema, category)).toBe(true);
    }
    expect(accepts(SvgContentCategorySchema, 'Script')).toBe(false);
    expect(accepts(SvgContentCategorySchema, 'text')).toBe(false);
  });

  it('accepts svg_content_removed with its categories and animation_flattened without any', () => {
    expect(
      accepts(UploadWarningSchema, {
        code: 'svg_content_removed',
        categories: ['script', 'event_handler'],
      }),
    ).toBe(true);
    expect(
      accepts(UploadWarningSchema, {
        code: 'svg_content_removed',
        categories: [...assets.SVG_CONTENT_CATEGORIES],
      }),
    ).toBe(true);
    expect(accepts(UploadWarningSchema, { code: 'animation_flattened' })).toBe(true);
  });

  it.each([
    ['svg_content_removed without categories', { code: 'svg_content_removed' }],
    ['svg_content_removed with no category', { code: 'svg_content_removed', categories: [] }],
    ['an unknown category', { code: 'svg_content_removed', categories: ['malware'] }],
    ['a repeated category', { code: 'svg_content_removed', categories: ['script', 'script'] }],
    ['categories as a string', { code: 'svg_content_removed', categories: 'script' }],
    [
      'animation_flattened with categories',
      { code: 'animation_flattened', categories: ['animation'] },
    ],
    ['an unknown code', { code: 'image_resized' }],
    ['a problem code', { code: 'image_corrupt' }],
    ['no code', { categories: ['script'] }],
    ['an extra member', { code: 'animation_flattened', frames: 3 }],
  ])('rejects %s', (_label, value) => {
    expect(accepts(UploadWarningSchema, value)).toBe(false);
  });
});

describe('StagedAssetSchema and UploadAssetResponseSchema (R7)', () => {
  const staged = (seed: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...assetRef(seed),
    bytes: 31_415,
    created: true,
    ...extra,
  });

  it('accept a staged asset, with the warnings of a sanitised SVG and a flattened APNG', () => {
    expect(accepts(StagedAssetSchema, staged('a'))).toBe(true);
    expect(accepts(UploadAssetResponseSchema, { asset: staged('a'), warnings: [] })).toBe(true);
    expect(
      accepts(UploadAssetResponseSchema, {
        asset: staged('b', { created: false }),
        warnings: [
          { code: 'svg_content_removed', categories: ['script'] },
          { code: 'animation_flattened' },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    ['bytes of 0', { bytes: 0 }],
    ['bytes over the file limit', { bytes: LIMITS.body.logoFileBytes + 1 }],
    ['a fractional size', { bytes: 1.5 }],
    ['created as text', { created: 'true' }],
    ['a url of another hash', { url: assetUrl(sha('x')) }],
    ['a slot member', { slot: 'logoLight' }],
  ])('StagedAsset rejects %s', (_label, change) => {
    expect(accepts(StagedAssetSchema, staged('a', change))).toBe(false);
  });

  it.each(['bytes', 'created', 'hash', 'url', 'width', 'height', 'luminance'])(
    'StagedAsset needs %s',
    (key) => {
      expect(accepts(StagedAssetSchema, without(staged('a'), key))).toBe(false);
    },
  );

  it('UploadAssetResponse needs the asset and the warnings, at most two warnings, no extra member', () => {
    const asset = staged('a');
    expect(accepts(UploadAssetResponseSchema, { asset })).toBe(false);
    expect(accepts(UploadAssetResponseSchema, { warnings: [] })).toBe(false);
    expect(accepts(UploadAssetResponseSchema, { asset, warnings: [], created: true })).toBe(false);
    const warning = { code: 'animation_flattened' };
    expect(
      accepts(UploadAssetResponseSchema, { asset, warnings: [warning, warning, warning] }),
    ).toBe(false);
    expect(accepts(UploadAssetResponseSchema, { asset, warnings: [{ code: 'x' }] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Export and import (R10, R11)
// ---------------------------------------------------------------------------------------------

describe('Base64PngSchema (FR-A-093)', () => {
  const signature = 'iVBORw0KGgo=';

  it('accepts canonical base64 without whitespace, with and without padding', () => {
    for (const value of [
      signature,
      'QQ==',
      'QUI=',
      'QUJD',
      'AAAA',
      btoa('\u{0}\u{1}\u{2}\u{ff}'),
    ]) {
      expect(Base64PngSchema.parse(value)).toBe(value);
    }
  });

  it.each([
    ['whitespace in the middle', 'iVBO Rw0KGgo='],
    ['a newline', 'iVBORw0K\nGgo='],
    ['a trailing newline', `${signature}\n`],
    ['the URL-safe alphabet', 'iVBORw0KGg-_'],
    ['missing padding', 'iVBORw0KGgo'],
    ['padding that is not needed', 'QUJD='],
    ['too much padding', 'QQ==='],
    ['padding in the middle', 'QQ==QQ=='],
    ['trailing bits that are not zero (not canonical)', 'QR=='],
    ['trailing bits that are not zero, one padding', 'QUJ='],
    ['a data URL', `data:image/png;base64,${signature}`],
    ['the empty string', ''],
    ['a length that is not a multiple of 4', 'QUJDR'],
    ['characters outside the alphabet', 'QUJD$$$$'],
    ['a non-ASCII character', 'QUJ\u{FF24}'],
  ])('rejects %s', (_label, value) => {
    expect(accepts(Base64PngSchema, value)).toBe(false);
  });

  it.each([null, undefined, 42, {}, [], ['QQ=='], new Uint8Array(3)])(
    'rejects the non-string %j',
    (value) => {
      expect(accepts(Base64PngSchema, value)).toBe(false);
    },
  );

  it('allows exactly the 2,097,152 bytes of the file limit and not one byte more', () => {
    const limit = LIMITS.body.logoFileBytes;
    const bytesToBase64 = (count: number): string => {
      const full = 'A'.repeat(Math.floor(count / 3) * 4);
      if (count % 3 === 1) return `${full}AA==`;
      if (count % 3 === 2) return `${full}AAA=`;
      return full;
    };
    expect(accepts(Base64PngSchema, bytesToBase64(limit))).toBe(true);
    expect(accepts(Base64PngSchema, bytesToBase64(limit + 1))).toBe(false);
    expect(accepts(Base64PngSchema, bytesToBase64(limit - 1))).toBe(true);
    expect(bytesToBase64(limit).length).toBe(2_796_204);
    expect(accepts(Base64PngSchema, 'A'.repeat(9_437_184))).toBe(false);
  });

  it('refuses a hostile string without a stack overflow: 9 MiB by its length, 2.8 million characters by their content', () => {
    // Over the limit: refused by its length before anything is read.
    expect(accepts(Base64PngSchema, `${'A'.repeat(9_437_180)}$$$$`)).toBe(false);
    // Within the length limit but wrong at the very end: the whole string is scanned, linearly.
    expect(accepts(Base64PngSchema, `${'A'.repeat(2_796_200)}$$$$`)).toBe(false);
    // Well formed but not canonical at the very end: the round trip decides.
    expect(accepts(Base64PngSchema, `${'A'.repeat(2_796_200)}AB==`)).toBe(false);
    expect(accepts(Base64PngSchema, `${'A'.repeat(2_796_200)}AA==`)).toBe(true);
  });
});

describe('BrandingExportSchema (R10, R11, FR-A-093)', () => {
  it('accepts the document of FR-A-093 and returns it unchanged', () => {
    const document = exportDocument();
    expect(BrandingExportSchema.parse(document)).toEqual(document);
  });

  it('accepts an upper-case accent and an unnormalised name (the service normalises on import)', () => {
    expect(
      accepts(BrandingExportSchema, {
        ...exportDocument(),
        accent: '#ABC',
        orgName: ' Acme  Corp ',
      }),
    ).toBe(true);
  });

  it('accepts three images', () => {
    expect(
      accepts(BrandingExportSchema, {
        ...exportDocument(),
        images: { logoLight: 'QQ==', logoDark: 'QUI=', compact: 'QUJD' },
      }),
    ).toBe(true);
  });

  it.each([
    ['schemaVersion 2', { schemaVersion: 2 }],
    ['schemaVersion 0', { schemaVersion: 0 }],
    ['schemaVersion as text', { schemaVersion: '1' }],
    ['schemaVersion 1.5', { schemaVersion: 1.5 }],
    ['an unknown top-level member', { exportedAt: '2026-10-10T12:00:00.000Z' }],
    ['an invalid accent', { accent: 'blue' }],
    ['an invalid name', { orgName: 'Ac\u{200B}me' }],
    ['an images member of the wrong type', { images: [] }],
    [
      'an unknown image',
      { images: { logoLight: null, logoDark: null, compact: null, icon: null } },
    ],
    [
      'an image that is not base64',
      { images: { logoLight: 'not base64!', logoDark: null, compact: null } },
    ],
    [
      'an image as a data URL',
      { images: { logoLight: 'data:image/png;base64,QQ==', logoDark: null, compact: null } },
    ],
    [
      'a missing image member (silent loss of a logo)',
      { images: { logoLight: null, logoDark: null } },
    ],
  ])('rejects %s', (_label, change) => {
    expect(accepts(BrandingExportSchema, { ...exportDocument(), ...change })).toBe(false);
  });

  it.each(['schemaVersion', 'orgName', 'accent', 'images'])(
    'rejects a document without %s',
    (key) => {
      expect(accepts(BrandingExportSchema, without(exportDocument(), key))).toBe(false);
    },
  );

  it.each(['__proto__', 'constructor', 'prototype', 'toString'])(
    'rejects a document with the key %s',
    (key) => {
      const document = JSON.parse(
        `{"schemaVersion":1,"orgName":"Acme","accent":"#0078d4","images":{"logoLight":null,"logoDark":null,"compact":null},"${key}":{"x":1}}`,
      ) as unknown;
      expect(accepts(BrandingExportSchema, document)).toBe(false);
      const nested = JSON.parse(
        `{"schemaVersion":1,"orgName":"Acme","accent":"#0078d4","images":{"logoLight":null,"logoDark":null,"compact":null,"${key}":null}}`,
      ) as unknown;
      expect(accepts(BrandingExportSchema, nested)).toBe(false);
    },
  );

  it('reports the member at fault by path, so an import_invalid problem can point at it', () => {
    const issues = issuesOf(BrandingExportSchema, {
      ...exportDocument(),
      images: { logoLight: 'bad!', logoDark: null, compact: null },
    });
    expect(issues.map((issue) => issue.path)).toContain('images/logoLight');
    expect(
      issuesOf(BrandingExportSchema, { ...exportDocument(), accent: 'x' }).map(
        (issue) => issue.path,
      ),
    ).toEqual(['accent']);
  });
});

describe('ImportQuerySchema (R11)', () => {
  it.each([{}, { dryRun: 'true' }, { dryRun: 'false' }])('accepts %j', (query) => {
    expect(accepts(ImportQuerySchema, query)).toBe(true);
  });

  it.each([
    ['1', { dryRun: '1' }],
    ['TRUE', { dryRun: 'TRUE' }],
    ['yes', { dryRun: 'yes' }],
    ['the empty string', { dryRun: '' }],
    ['a boolean (no coercion: the query is text)', { dryRun: true }],
    ['a repeated parameter', { dryRun: ['true', 'false'] }],
    ['an unknown parameter', { dryRun: 'true', force: '1' }],
  ])('rejects %s', (_label, query) => {
    expect(accepts(ImportQuerySchema, query)).toBe(false);
  });
});

describe('ImportedImageSummarySchema and ImportResultSchema (R11)', () => {
  it('accept the summary of an image that went through the pipeline, with its warnings', () => {
    expect(accepts(ImportedImageSummarySchema, importedImage('a'))).toBe(true);
    expect(
      accepts(ImportedImageSummarySchema, {
        ...importedImage('a'),
        warnings: [{ code: 'svg_content_removed', categories: ['style'] }],
      }),
    ).toBe(true);
  });

  it.each([
    ['a missing hash', without(importedImage('a'), 'hash')],
    ['an upper-case hash', { ...importedImage('a'), hash: sha('a').toUpperCase() }],
    ['bytes of 0', { ...importedImage('a'), bytes: 0 }],
    ['a width of 2000', { ...importedImage('a'), width: 2000 }],
    ['warnings of the wrong shape', { ...importedImage('a'), warnings: ['svg_content_removed'] }],
    ['an extra member', { ...importedImage('a'), url: assetUrl(sha('a')) }],
  ])('ImportedImageSummary rejects %s', (_label, value) => {
    expect(accepts(ImportedImageSummarySchema, value)).toBe(false);
  });

  const dryRun = (): Record<string, unknown> => ({
    dryRun: true,
    applied: false,
    orgName: 'Acme Vereniging',
    accent: '#0078d4',
    images: { logoLight: importedImage('a'), logoDark: null, compact: null },
    branding: null,
  });
  const applied = (): Record<string, unknown> => ({
    ...dryRun(),
    dryRun: false,
    applied: true,
    branding: { ...loadedBranding(), orgName: 'Acme Vereniging' },
  });

  it('accepts a dry run (nothing stored, no branding) and an applied import (the new branding)', () => {
    expect(accepts(ImportResultSchema, dryRun())).toBe(true);
    expect(accepts(ImportResultSchema, applied())).toBe(true);
    expect(ImportResultSchema.parse(applied())).toEqual(applied());
  });

  it.each([
    ['a dry run that says it applied', { applied: true }],
    ['a dry run that carries a branding', { branding: loadedBranding() }],
    ['an applied import with no branding', { dryRun: false, applied: true, branding: null }],
    [
      'an applied import that says it did not apply',
      { dryRun: false, applied: false, branding: loadedBranding() },
    ],
    ['an upper-case accent in the result (the stored form is lower case)', { accent: '#0078D4' }],
    ['an unnormalised name in the result', { orgName: ' Acme ' }],
    ['a missing images member', { images: { logoLight: null, logoDark: null } }],
    ['an unknown member', { warnings: [] }],
  ])('rejects %s', (_label, change) => {
    expect(accepts(ImportResultSchema, { ...dryRun(), ...change })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Web manifest (R13)
// ---------------------------------------------------------------------------------------------

describe('WebManifestSchema (R13, FR-A-094)', () => {
  it('accepts the manifest of the contract: three icons, one maskable', () => {
    expect(WebManifestSchema.parse(webManifest())).toEqual(webManifest());
  });

  it('accepts the degraded manifest: defaults and no icons', () => {
    expect(
      accepts(WebManifestSchema, {
        ...webManifest(),
        name: DEFAULT_ORG_NAME,
        short_name: DEFAULT_ORG_NAME,
        icons: [],
      }),
    ).toBe(true);
  });

  it('accepts a hostile name as data: the manifest is JSON, never markup', () => {
    for (const name of [
      '"><img src=x onerror=alert(1)>',
      '</title><script>alert(1)</script>',
      '$&',
      "$'",
    ]) {
      expect(
        accepts(WebManifestSchema, { ...webManifest(), name, short_name: name.slice(0, 12) }),
        name,
      ).toBe(true);
    }
  });

  it.each([
    ['another display mode', { display: 'fullscreen' }],
    ['another start_url', { start_url: '/dashboard' }],
    ['an absolute start_url', { start_url: 'https://example.com/' }],
    ['another scope', { scope: '/app/' }],
    ['another id', { id: '/app' }],
    ['an upper-case theme colour', { theme_color: '#0078D4' }],
    ['a named theme colour', { theme_color: 'blue' }],
    ['a short background colour', { background_color: '#fff' }],
    ['an empty name', { name: '' }],
    ['an unnormalised name', { name: ' Acme ' }],
    ['a short_name of 13 characters', { short_name: 'Acme Veren-13' }],
    ['an empty short_name', { short_name: '' }],
    ['an unknown member (a lang, a description)', { lang: 'nl' }],
    [
      'four icons',
      {
        icons: [
          ...(webManifest().icons as unknown[]),
          { src: assetUrl(sha('x')), sizes: '192x192', type: 'image/png' },
        ],
      },
    ],
    [
      'an icon from another origin',
      {
        icons: [
          { src: `https://evil.example${assetUrl(sha('x'))}`, sizes: '192x192', type: 'image/png' },
        ],
      },
    ],
    [
      'an icon that is not a branding file',
      { icons: [{ src: '/assets/logo.png', sizes: '192x192', type: 'image/png' }] },
    ],
    [
      'an icon of another size',
      { icons: [{ src: assetUrl(sha('x')), sizes: '48x48', type: 'image/png' }] },
    ],
    [
      'an icon of another type',
      { icons: [{ src: assetUrl(sha('x')), sizes: '192x192', type: 'image/svg+xml' }] },
    ],
    [
      'an icon with another purpose',
      {
        icons: [
          { src: assetUrl(sha('x')), sizes: '192x192', type: 'image/png', purpose: 'monochrome' },
        ],
      },
    ],
  ])('rejects %s', (_label, change) => {
    expect(accepts(WebManifestSchema, { ...webManifest(), ...change })).toBe(false);
  });

  it.each([
    'id',
    'name',
    'short_name',
    'start_url',
    'scope',
    'display',
    'theme_color',
    'background_color',
    'icons',
  ])('needs %s', (key) => {
    expect(accepts(WebManifestSchema, without(webManifest(), key))).toBe(false);
  });

  it('the icon schema accepts the three kinds of the contract', () => {
    for (const icon of webManifest().icons as unknown[])
      expect(accepts(ManifestIconSchema, icon)).toBe(true);
  });

  it('cuts short_name by grapheme clusters: 12 are allowed, a ZWJ emoji counts as one', () => {
    const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
    expect(accepts(WebManifestSchema, { ...webManifest(), short_name: family.repeat(12) })).toBe(
      true,
    );
    expect(accepts(WebManifestSchema, { ...webManifest(), short_name: family.repeat(13) })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Every schema is an OpenAPI component and has no transform; the package boundary
// ---------------------------------------------------------------------------------------------

describe('every branding schema is an OpenAPI component and has no transform (contract 8.1, 8.4)', () => {
  const modules = {
    'schemas/branding.ts': branding,
    'schemas/assets.ts': assets,
    'schemas/export-import.ts': exportImport,
    'schemas/manifest.ts': manifest,
  } as const;

  const schemasOf = (module: Record<string, unknown>): [string, z.ZodType][] =>
    Object.entries(module).filter(
      (entry): entry is [string, z.ZodType] =>
        entry[0].endsWith('Schema') && entry[1] instanceof z.ZodType,
    );

  it('exports the schemas of contract section 8.1 and the ones this task adds, and no others', () => {
    const exported = Object.values(modules).flatMap((module) =>
      schemasOf(module).map(([name]) => name),
    );
    expect(exported.sort()).toEqual(
      [
        // Contract section 8.1.
        'AccentTokenSetSchema',
        'ThemeTokensSchema',
        'AssetRefSchema',
        'IconRefSchema',
        'IconSetSchema',
        'MonogramGlyphSchema',
        'MonogramSchema',
        'BrandingSchema',
        'ApplyBrandingRequestSchema',
        'IfMatchHeaderSchema',
        'AssetSlotSchema',
        'UploadAssetQuerySchema',
        'StagedAssetSchema',
        'UploadWarningSchema',
        'UploadAssetResponseSchema',
        'Base64PngSchema',
        'BrandingExportSchema',
        'ImportQuerySchema',
        'ImportedImageSummarySchema',
        'ImportResultSchema',
        'WebManifestSchema',
        // Additions that two schemas needed in common, or that name a component of the OpenAPI document.
        'OrgNameSchema',
        'OrgNameInputSchema',
        'SvgContentCategorySchema',
        'SvgContentRemovedWarningSchema',
        'AnimationFlattenedWarningSchema',
        'ManifestIconSchema',
      ].sort(),
    );
  });

  const all = Object.values(modules).flatMap((module) => schemasOf(module));

  it.each(all)(
    '%s: .meta({ id }) on every schema, the id is the name without the suffix',
    (name, schema) => {
      expect(schema.meta()?.id, name).toBe(name.replace(/Schema$/, ''));
    },
  );

  it.each(all)(
    '%s: converts to JSON Schema in both directions, which a transform would not allow',
    (name, schema) => {
      expect(() => z.toJSONSchema(schema, { io: 'input' }), name).not.toThrow();
      expect(() => z.toJSONSchema(schema, { io: 'output' }), name).not.toThrow();
    },
  );

  it('the component ids are unique across the four modules (one OpenAPI components section)', () => {
    const ids = all.map(([, schema]) => schema.meta()?.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every strict object says additionalProperties false in the JSON Schema', () => {
    interface Component {
      additionalProperties?: boolean;
      properties?: Record<string, Component>;
    }
    const component = (schema: z.ZodType, id: string, io: 'input' | 'output'): Component => {
      const json = z.toJSONSchema(schema, { io }) as { $defs: Record<string, Component> };
      const found = json.$defs[id];
      if (found === undefined) throw new Error(`no component ${id}`);
      return found;
    };
    const branding = component(BrandingSchema, 'Branding', 'output');
    expect(branding.additionalProperties).toBe(false);
    expect(branding.properties?.logos?.additionalProperties).toBe(false);
    const request = component(ApplyBrandingRequestSchema, 'ApplyBrandingRequest', 'input');
    expect(request.additionalProperties).toBe(false);
    expect(request.properties?.logos?.additionalProperties).toBe(false);
    expect(component(WebManifestSchema, 'WebManifest', 'output').additionalProperties).toBe(false);
    expect(component(BrandingExportSchema, 'BrandingExport', 'input').additionalProperties).toBe(
      false,
    );
  });

  /** The guard over a source text: throws on a transform, a pipe or a coercion. */
  function assertNoTransform(source: string): void {
    const found = /\.(?:transform|pipe|preprocess|overwrite)\s*\(|z\.coerce\b/.exec(source);
    if (found) throw new Error(`a transform is used (${found[0]}): not allowed in a route schema`);
  }

  it.each(Object.keys(modules))('%s uses no transform, pipe or coercion', (path) => {
    const source = readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
    assertNoTransform(source);
  });

  it('the transform guard fails on a schema that transforms (negative fixture)', () => {
    expectGuardFails(assertNoTransform, 'export const X = z.string().transform((v) => v.trim());', {
      reason: 'a transform is used',
    });
    expectGuardFails(assertNoTransform, 'export const X = z.coerce.boolean();', {
      reason: 'a transform is used',
    });
    expectGuardFails(assertNoTransform, 'export const X = A.pipe(B);', {
      reason: 'a transform is used',
    });
  });

  /**
   * The schemas are imported lazily by the web app (Appearance route chunk) and by the OpenAPI
   * document: they must not drag the glyph table, the accent derivation or the tokens along.
   */
  const ALLOWED_IMPORT =
    /^(?:zod|\.\/(?:common|branding|assets)\.js|\.\.\/branding\/org-name\.js|\.\.\/limits\.js)$/u;

  function assertLightImports(source: string): void {
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\sfrom\s+'([^']+)'/gmu),
    ].map((match) => match[1] ?? '');
    const heavy = specifiers.filter((specifier) => !ALLOWED_IMPORT.test(specifier));
    if (heavy.length > 0) throw new Error(`imports beyond the light set: ${heavy.join(', ')}`);
  }

  it.each(Object.keys(modules))(
    '%s imports only zod, its siblings, the name module and the limits',
    (path) => {
      const source = readFileSync(
        fileURLToPath(new URL(`../src/${path}`, import.meta.url)),
        'utf8',
      );
      assertLightImports(source);
    },
  );

  it('the import guard fails on a schema that imports the glyph table or the accent derivation (negative fixture)', () => {
    expectGuardFails(
      assertLightImports,
      "import { GLYPHS } from '../branding/glyphs.generated.js';",
      { reason: 'beyond the light set' },
    );
    expectGuardFails(
      assertLightImports,
      "import { deriveAccentTokens } from '../branding/accent.js';",
      { reason: 'beyond the light set' },
    );
    expectGuardFails(assertLightImports, "import { monogramFor } from '../branding/monogram.js';", {
      reason: 'beyond the light set',
    });
    expectGuardFails(assertLightImports, "import { SURFACES } from '../tokens/index.js';", {
      reason: 'beyond the light set',
    });
  });

  it('is importable by its package subpath, which is how the web app imports it lazily (TA-05)', async () => {
    const lazy = await import('@m365portal/shared/schemas/branding');
    expect(lazy.BrandingSchema).toBe(BrandingSchema);
    const lazyAssets = await import('@m365portal/shared/schemas/assets');
    expect(lazyAssets.UploadAssetResponseSchema).toBe(UploadAssetResponseSchema);
    const lazyExport = await import('@m365portal/shared/schemas/export-import');
    expect(lazyExport.BrandingExportSchema).toBe(BrandingExportSchema);
    const lazyManifest = await import('@m365portal/shared/schemas/manifest');
    expect(lazyManifest.WebManifestSchema).toBe(WebManifestSchema);
  });
});
