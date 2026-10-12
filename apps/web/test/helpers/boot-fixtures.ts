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
import type { SetupState } from '@m365portal/shared/setup/steps';
import type { MeResponse } from '../../src/lib/boot-data';
import { createHash } from 'node:crypto';

const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex');
const iconRef = (seed: string) => ({ hash: sha(seed), url: `/branding/${sha(seed)}.png` });

export const SAMPLE_VERSION = '0.1.0';
export const SAMPLE_ORIGIN = 'https://panel.example.com';

export type SampleActorKind = 'anonymous' | 'user' | 'setup' | 'break_glass';

export interface SampleSession {
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
  readonly mfa: boolean;
  readonly stepUpValidUntil: string | null;
  readonly groupsStale: boolean;
}

export interface SampleMeOptions {
  /** Who the actor is; `anonymous` by default. */
  readonly kind?: SampleActorKind;
  /** The display name of a signed-in actor (data, never translated). */
  readonly label?: string;
  readonly permissions?: readonly Permission[];
  readonly roles?: readonly string[];
  /** Defaults: none for anonymous and setup, a session for user and break-glass. */
  readonly session?: Partial<SampleSession> | null;
  readonly setupState?: SetupState;
  readonly showcase?: boolean;
  /** `features.breakGlass` */
  readonly breakGlass?: boolean;
  readonly adminConsentUrl?: string | null;
  readonly version?: string;
  readonly publicOrigin?: string;
  readonly storageAvailable?: boolean;
}

/** A session that ends well after the tests (2026-10-12 is the date of the repository). */
export const SAMPLE_SESSION: SampleSession = Object.freeze({
  expiresAt: '2026-10-12T20:00:00.000Z',
  idleExpiresAt: '2026-10-12T13:00:00.000Z',
  mfa: true,
  stepUpValidUntil: null,
  groupsStale: false,
});

/** The anonymous actor with no permission by default (setup completed); `kind` picks another actor. */
export function sampleMe(options: SampleMeOptions = {}): MeResponse {
  // Permissions imply a person who holds them: a signed-in user unless the test says otherwise.
  const kind = options.kind ?? ((options.permissions?.length ?? 0) > 0 ? 'user' : 'anonymous');
  const hasSession = kind === 'user' || kind === 'break_glass';
  const session =
    options.session === undefined
      ? hasSession
        ? SAMPLE_SESSION
        : null
      : options.session === null
        ? null
        : { ...SAMPLE_SESSION, ...options.session };
  const labels: Record<SampleActorKind, string> = {
    anonymous: 'Anonymous',
    user: 'Alice Example',
    setup: 'Setup',
    break_glass: 'Break-glass',
  };
  const ids: Record<SampleActorKind, string> = {
    anonymous: 'anonymous',
    user: '11111111-1111-4111-8111-111111111111',
    setup: 'setup',
    break_glass: 'break_glass',
  };
  return MeResponseSchema.parse({
    actor: { kind, id: ids[kind], label: options.label ?? labels[kind] },
    permissions: [...(options.permissions ?? [])].sort(),
    roles: (options.roles ?? []).map((key) => ({ key })),
    session,
    setup: { state: options.setupState ?? 'completed' },
    features: { showcase: options.showcase ?? false, breakGlass: options.breakGlass ?? false },
    adminConsentUrl: options.adminConsentUrl ?? null,
    version: options.version ?? SAMPLE_VERSION,
    publicOrigin: options.publicOrigin ?? SAMPLE_ORIGIN,
    storageAvailable: options.storageAvailable ?? true,
  });
}

/** A signed-in user with every permission (the actor most Phase A page tests want) and the role owner. */
export function sampleSignedInMe(options: Omit<SampleMeOptions, 'kind'> = {}): MeResponse {
  return sampleMe({
    permissions: [...PERMISSIONS],
    roles: ['owner'],
    ...options,
    kind: 'user',
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
