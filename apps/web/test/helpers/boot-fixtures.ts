// Sample `me` and `branding` for tests, built from the real producers of the shared package
// (`deriveAccentTokens`, `monogramFor`), so that a test fails when the schema and its producer
// disagree and not because a hand-written sample drifted. The boot-data block is rendered the way the
// server renders it (shell.ts of the branding module): the JSON with `<`, U+2028 and U+2029 escaped.
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { monogramFor } from '@m365portal/shared/branding/monogram';
import { DEFAULT_ORG_NAME } from '@m365portal/shared/branding/org-name';
import { PERMISSIONS, type Permission } from '@m365portal/shared/permissions';
import { BrandingSchema, type Branding } from '@m365portal/shared/schemas/branding';
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import type { MeResponse } from '../../src/lib/boot-data';
import { createHash } from 'node:crypto';

const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex');
const iconRef = (seed: string) => ({ hash: sha(seed), url: `/branding/${sha(seed)}.png` });

export const SAMPLE_VERSION = '0.1.0';
export const SAMPLE_ORIGIN = 'https://panel.example.com';

export interface SampleMeOptions {
  readonly permissions?: readonly Permission[];
  readonly preview?: boolean;
  readonly showcase?: boolean;
  readonly version?: string;
  readonly publicOrigin?: string;
}

/** The anonymous actor by default; `preview: true` is the preview actor with every permission. */
export function sampleMe(options: SampleMeOptions = {}): MeResponse {
  const preview = options.preview ?? false;
  return MeResponseSchema.parse({
    actor: preview
      ? { kind: 'preview', id: 'preview', label: 'Preview' }
      : { kind: 'anonymous', id: 'anonymous', label: 'Anonymous' },
    permissions: options.permissions ?? (preview ? [...PERMISSIONS] : []),
    features: { showcase: options.showcase ?? false, preview },
    version: options.version ?? SAMPLE_VERSION,
    publicOrigin: options.publicOrigin ?? SAMPLE_ORIGIN,
    storageAvailable: true,
  });
}

/** The default branding of a fresh installation: name M365Portal, no logos, monogram icons. */
export function sampleBranding(orgName: string = DEFAULT_ORG_NAME): Branding {
  return BrandingSchema.parse({
    revision: 1,
    orgName,
    isDefaultName: orgName === DEFAULT_ORG_NAME,
    accent: '#0078d4',
    tokens: deriveAccentTokens('#0078d4'),
    logos: { light: null, dark: null, compact: null },
    compactDerived: false,
    icons: {
      favicon32: iconRef('favicon32'),
      appleTouch180: iconRef('appleTouch180'),
      pwa192: iconRef('pwa192'),
      pwa512: iconRef('pwa512'),
      maskable512: iconRef('maskable512'),
    },
    monogram: monogramFor(orgName),
    updatedAt: '2026-10-10T12:00:00.000Z',
  });
}

/** JSON for a `<script type="application/json">`: `<`, U+2028 and U+2029 are escaped. */
export function escapeForScript(json: string): string {
  return json
    .replaceAll('<', '\\u003c')
    .replaceAll(String.fromCodePoint(0x2028), '\\u2028')
    .replaceAll(String.fromCodePoint(0x2029), '\\u2029');
}

/** Puts the boot-data block (or any text) into `doc`, where the app looks for it. */
export function installBootBlock(doc: Document, text: string): HTMLScriptElement {
  doc.getElementById('m365-boot')?.remove();
  const script = doc.createElement('script');
  script.type = 'application/json';
  script.id = 'm365-boot';
  script.textContent = text;
  doc.head.append(script);
  return script;
}

/** Puts `<meta property="csp-nonce" nonce=...>` into `doc`. */
export function installNonceMeta(doc: Document, nonce: string): HTMLMetaElement {
  doc.querySelector('meta[property="csp-nonce"]')?.remove();
  const meta = doc.createElement('meta');
  meta.setAttribute('property', 'csp-nonce');
  meta.setAttribute('nonce', nonce);
  doc.head.append(meta);
  return meta;
}
