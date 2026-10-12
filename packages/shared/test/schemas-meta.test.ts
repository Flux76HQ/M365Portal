// T-B-194: FR-B-413, TB-14, XB7. The wire shape of `GET /api/v1/me`, also the boot data of the HTML
// shell: the actor (four kinds), permissions (sorted, once each), roles, the session summary, the setup
// state, the two feature flags, the admin-consent link, and no `preview` anywhere.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PERMISSIONS } from '../src/permissions.js';
import {
  ActorSummarySchema,
  CsrfResponseSchema,
  FeaturesSchema,
  MeResponseSchema,
  SessionSummarySchema,
  SetupSummarySchema,
} from '../src/schemas/meta.js';
import { SETUP_STATES } from '../src/setup/steps.js';
import { expectGuardFails } from '../src/testing/index.js';

const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const GUID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const session = {
  expiresAt: '2026-10-12T18:00:00.000Z',
  idleExpiresAt: '2026-10-12T10:30:00.000Z',
  mfa: true,
  stepUpValidUntil: null,
  groupsStale: false,
};
const anonymous = {
  actor: { kind: 'anonymous', id: 'anonymous', label: 'Anonymous' },
  permissions: [],
  roles: [],
  session: null,
  setup: { state: 'completed' },
  features: { showcase: false, breakGlass: false },
  adminConsentUrl: null,
  defaultLanguage: null,
  version: '0.2.1',
  publicOrigin: 'http://localhost:9300',
  storageAvailable: true,
};
const user = {
  ...anonymous,
  actor: { kind: 'user', id: GUID, label: 'Alex Example' },
  permissions: ['settings:branding', 'users:read'],
  roles: [{ key: 'admin' }],
  session,
};

describe('MeResponseSchema (FR-B-413)', () => {
  it('has exactly the members of the contract', () => {
    expect(Object.keys(MeResponseSchema.shape).sort()).toEqual(
      [
        'actor',
        'permissions',
        'roles',
        'session',
        'setup',
        'features',
        'adminConsentUrl',
        'defaultLanguage',
        'version',
        'publicOrigin',
        'storageAvailable',
      ].sort(),
    );
    expect(Object.keys(FeaturesSchema.shape).sort()).toEqual(['breakGlass', 'showcase']);
    expect(Object.keys(SessionSummarySchema.shape).sort()).toEqual(
      ['expiresAt', 'groupsStale', 'idleExpiresAt', 'mfa', 'stepUpValidUntil'].sort(),
    );
    expect(Object.keys(SetupSummarySchema.shape)).toEqual(['state']);
  });

  it('accepts the anonymous, user, setup and break-glass shapes', () => {
    expect(accepts(MeResponseSchema, anonymous)).toBe(true);
    expect(accepts(MeResponseSchema, user)).toBe(true);
    expect(
      accepts(MeResponseSchema, {
        ...anonymous,
        actor: { kind: 'setup', id: 'setup', label: 'Setup' },
        permissions: ['settings:branding', 'settings:connection'],
        setup: { state: 'in_progress' },
      }),
    ).toBe(true);
    expect(
      accepts(MeResponseSchema, {
        ...anonymous,
        actor: { kind: 'break_glass', id: 'break-glass', label: 'Break-glass' },
        permissions: ['rbac:manage'],
        session: { ...session, idleExpiresAt: session.expiresAt },
        features: { showcase: false, breakGlass: true },
      }),
    ).toBe(true);
  });

  it('accepts the stored default language nl, en or null', () => {
    for (const defaultLanguage of ['nl', 'en', null]) {
      expect(accepts(MeResponseSchema, { ...anonymous, defaultLanguage }), String(defaultLanguage)).toBe(true);
    }
  });

  it('accepts every catalogue permission, in sorted order', () => {
    expect(accepts(MeResponseSchema, { ...user, permissions: [...PERMISSIONS].sort() })).toBe(true);
  });

  it('accepts every setup state and a consent link of https', () => {
    for (const state of SETUP_STATES) {
      expect(accepts(MeResponseSchema, { ...anonymous, setup: { state } }), state).toBe(true);
    }
    expect(
      accepts(MeResponseSchema, {
        ...anonymous,
        adminConsentUrl: `https://login.microsoftonline.com/${GUID}/adminconsent?client_id=${GUID}`,
      }),
    ).toBe(true);
  });

  it('accepts an https origin, a custom port and an IPv6 host as the public origin', () => {
    for (const publicOrigin of [
      'https://panel.example.org',
      'http://localhost:18080',
      'http://[::1]:18080',
    ]) {
      expect(accepts(MeResponseSchema, { ...anonymous, publicOrigin }), publicOrigin).toBe(true);
    }
  });

  it('accepts storageAvailable false (degraded mode) and a session that stepped up', () => {
    expect(accepts(MeResponseSchema, { ...anonymous, storageAvailable: false })).toBe(true);
    expect(
      accepts(MeResponseSchema, {
        ...user,
        session: { ...session, stepUpValidUntil: '2026-10-12T10:10:00.000Z' },
      }),
    ).toBe(true);
  });

  it.each([
    ['an unknown actor kind', { actor: { kind: 'preview', id: 'preview', label: 'Preview' } }],
    ['an actor without a label', { actor: { kind: 'anonymous', id: 'anonymous' } }],
    ['a permission outside the catalogue', { permissions: ['users:write'] }],
    ['a wildcard permission', { permissions: ['*'] }],
    ['a repeated permission', { permissions: ['users:read', 'users:read'] }],
    ['unsorted permissions', { permissions: ['users:read', 'settings:branding'] }],
    ['permissions as a set-like object', { permissions: { 'users:read': true } }],
    ['a role that is not a key', { roles: [{ key: 'Not A Key' }] }],
    ['a repeated role', { roles: [{ key: 'admin' }, { key: 'admin' }] }],
    ['a role with more members', { roles: [{ key: 'admin', permissions: [] }] }],
    ['features with preview', { features: { showcase: false, breakGlass: false, preview: false } }],
    ['features without breakGlass', { features: { showcase: false } }],
    ['features with a non-boolean', { features: { showcase: 'no', breakGlass: false } }],
    ['a session without mfa', { session: { ...session, mfa: undefined } }],
    [
      'a session with an offset timestamp',
      { session: { ...session, expiresAt: '2026-10-12T18:00:00+02:00' } },
    ],
    ['a session with an extra member', { session: { ...session, id: 'x' } }],
    ['an unknown setup state', { setup: { state: 'done' } }],
    ['a setup with an extra member', { setup: { state: 'completed', step: 1 } }],
    ['a consent link over http', { adminConsentUrl: 'http://login.microsoftonline.com/x' }],
    ['a consent link that is a script', { adminConsentUrl: 'javascript:alert(1)' }],
    ['an empty consent link', { adminConsentUrl: '' }],
    ['an unsupported default language', { defaultLanguage: 'de' }],
    ['an upper-case default language', { defaultLanguage: 'NL' }],
    ['an origin with a path', { publicOrigin: 'http://localhost:9300/panel' }],
    ['an origin with a trailing slash', { publicOrigin: 'http://localhost:9300/' }],
    ['an origin that is not a URL', { publicOrigin: 'localhost' }],
    ['a script URL as origin', { publicOrigin: 'javascript:alert(1)' }],
    ['an origin with credentials', { publicOrigin: 'http://user:pw@localhost:9300' }],
    ['an empty version', { version: '' }],
    ['storageAvailable as text', { storageAvailable: 'yes' }],
    ['an extra member', { token: 'x' }],
    ['a top-level preview member', { preview: false }],
  ])('rejects %s', (_label, change) => {
    expect(accepts(MeResponseSchema, { ...user, ...change })).toBe(false);
  });

  it.each([
    'actor',
    'permissions',
    'roles',
    'session',
    'setup',
    'features',
    'adminConsentUrl',
    'defaultLanguage',
    'version',
    'publicOrigin',
    'storageAvailable',
  ])('rejects a response without %s', (key) => {
    const rest = Object.fromEntries(Object.entries(user).filter(([name]) => name !== key));
    expect(accepts(MeResponseSchema, rest)).toBe(false);
  });

  it('names no preview anywhere: a schema that has it fails (negative)', () => {
    const mentionsPreview = (schema: z.ZodType): void => {
      if (JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' })).includes('preview')) {
        throw new Error('the schema still has a preview member or kind');
      }
    };
    mentionsPreview(MeResponseSchema);
    const withPreview = z.strictObject({ features: z.strictObject({ preview: z.boolean() }) });
    expectGuardFails(mentionsPreview, withPreview);
  });

  it('describes the parts on their own', () => {
    expect(
      accepts(ActorSummarySchema, { kind: 'break_glass', id: 'break-glass', label: 'B' }),
    ).toBe(true);
    expect(accepts(ActorSummarySchema, { kind: 'admin', id: 'a', label: 'A' })).toBe(false);
    expect(accepts(FeaturesSchema, { showcase: true, breakGlass: false })).toBe(true);
    expect(accepts(FeaturesSchema, { showcase: true })).toBe(false);
  });
});

describe('CsrfResponseSchema (R5, unchanged)', () => {
  const example = {
    token: 'v1.1760000000.1760028800.Q3x1aB9_-fA.7bKw0Zk',
    expiresAt: '2025-10-09T16:00:00.000Z',
  };

  it('accepts a token with an expiry timestamp', () => {
    expect(accepts(CsrfResponseSchema, example)).toBe(true);
  });

  it.each([
    ['no token', { expiresAt: example.expiresAt }],
    ['an empty token', { ...example, token: '' }],
    ['a token with a space', { ...example, token: 'v1.abc def' }],
    ['an extra member', { ...example, binding: 'session' }],
  ])('rejects %s', (_label, value) => {
    expect(accepts(CsrfResponseSchema, value)).toBe(false);
  });
});
