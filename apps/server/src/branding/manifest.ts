// The web manifest (T-A-090; FR-A-094; R13; E-12): a pure function from a branding to the manifest
// document. The organisation name is a value of an object that `JSON.stringify` serialises, never a
// piece of text that is concatenated, so a hostile name can only ever be one JSON string. The short
// name is the shared `shortOrgName` (a cut at a grapheme boundary); the server holds no second cut.
//
// The result is checked against the shared `WebManifestSchema` before it leaves: if a member were
// ever wrong (a name that is not normalised, an icon url that is not a branding file) the route fails
// instead of sending a manifest the browser would silently half-read.
import { shortOrgName } from '@m365portal/shared/branding/org-name';
import type { Branding } from '@m365portal/shared/schemas/branding';
import {
  WebManifestSchema,
  type ManifestIcon,
  type WebManifest,
} from '@m365portal/shared/schemas/manifest';
import { SURFACES } from '@m365portal/shared/tokens';
import { ProblemError } from '../http/problem.js';
import type { DegradedBranding } from './defaults.js';
import type { BrandingService } from './service.js';

/**
 * The applied branding, or `undefined` while storage is unusable (degraded mode, FR-A-013). A 503
 * `storage_unavailable` is the only failure that means "degraded"; anything else is a bug and
 * propagates. Shared by the manifest, the icon redirects and the shell.
 */
export function appliedBranding(service: Pick<BrandingService, 'get'>): Branding | undefined {
  try {
    return service.get();
  } catch (error) {
    if (error instanceof ProblemError && error.code === 'storage_unavailable') return undefined;
    throw error;
  }
}

/** The part of a branding the manifest reads. A degraded branding has no icons. */
export type ManifestSource = Pick<Branding, 'revision' | 'orgName'> & {
  readonly tokens: { readonly light: Pick<Branding['tokens']['light'], 'accent'> };
  readonly icons?: Pick<Branding['icons'], 'pwa192' | 'pwa512' | 'maskable512'>;
};

export function buildManifest(source: ManifestSource | DegradedBranding): WebManifest {
  const icons: ManifestIcon[] =
    'icons' in source && source.icons !== undefined
      ? [
          { src: source.icons.pwa192.url, sizes: '192x192', type: 'image/png' },
          { src: source.icons.pwa512.url, sizes: '512x512', type: 'image/png' },
          {
            src: source.icons.maskable512.url,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ]
      : [];
  return WebManifestSchema.parse({
    id: '/',
    name: source.orgName,
    short_name: shortOrgName(source.orgName),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: source.tokens.light.accent,
    background_color: SURFACES.light.page,
    icons,
  });
}
