// The preview mode is gone (FR-B-102, TB-09). This is the migrated Phase A `preview-banner.spec.ts`
// (FR-A-032, E-17, FR-A-036; "migrated, not deleted", FR-B-708): there is no preview feature left to
// test, only its absence.
//
//   - no banner on any route, for a signed-in person and for a visitor;
//   - no `features.preview` in `GET /api/v1/me` and no `preview` actor kind;
//   - a request that names a non-loopback Host, or carries a forwarding header, gains nothing;
//   - the retired variables `PREVIEW_MODE` and `PREVIEW_MODE_ALLOW_REMOTE` are ignored by the server.
import { CLIENT_ROUTES, UNKNOWN_ROUTE } from '../routes.js';
import { allowLockedSetup, expect, test } from '../fixtures.js';
import { restartServer } from '../servers.js';

const ROUTES = [...CLIENT_ROUTES, UNKNOWN_ROUTE];

interface MeBody {
  actor: { kind: string };
  permissions: string[];
  features: Record<string, boolean>;
}

const BANNER_TEXT = 'nothing here is protected by a sign-in';

test.describe('signed in as the owner', () => {
  for (const route of ROUTES) {
    test(`shows no preview banner on ${route}`, async ({ page, app, guard }) => {
      allowLockedSetup(guard);
      await app.goto(route);
      await expect(page.getByText(BANNER_TEXT)).toHaveCount(0);
      await expect(page.getByText('Preview mode')).toHaveCount(0);
    });
  }

  test('/api/v1/me names a user and has no preview feature', async ({ request, app }) => {
    const me = (await (await request.get(app.url('/api/v1/me'))).json()) as MeBody;
    expect(me.actor.kind).toBe('user');
    expect(me.features).not.toHaveProperty('preview');
    expect(Object.keys(me.features).sort()).toEqual(['breakGlass', 'showcase']);
  });
});

test.describe('a visitor without a session', () => {
  test.use({ principal: 'anonymous' });

  for (const route of ROUTES) {
    test(`never shows the preview banner on ${route}`, async ({ page, app, guard }) => {
      allowLockedSetup(guard);
      await app.goto(route);
      await expect(page.getByText(BANNER_TEXT)).toHaveCount(0);
      await expect(page.getByText('Preview mode')).toHaveCount(0);
    });
  }

  test('/api/v1/me has no permissions and no preview feature', async ({ request, app }) => {
    const me = (await (await request.get(app.url('/api/v1/me'))).json()) as MeBody;
    expect(me.actor.kind).toBe('anonymous');
    expect(me.permissions).toEqual([]);
    expect(me.features).not.toHaveProperty('preview');
  });

  test('a non-loopback Host gains nothing (FR-A-036 is moot: there is no preview actor to hand out)', async ({
    request,
    app,
  }) => {
    const response = await request.get(app.url('/api/v1/me'), {
      headers: { Host: 'panel.example.com' },
    });
    expect(response.status()).toBe(200);
    const me = (await response.json()) as MeBody;
    expect(me.permissions).toEqual([]);
    expect(me.actor.kind).toBe('anonymous');
    expect(me.features).not.toHaveProperty('preview');
  });

  test('a forwarding header gains nothing either', async ({ request, app }) => {
    const response = await request.get(app.url('/api/v1/me'), {
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    });
    const me = (await response.json()) as MeBody;
    expect(me.permissions).toEqual([]);
    expect(me.actor.kind).toBe('anonymous');
  });

  test('a request over a loopback Host is no preview actor either', async ({ request, app }) => {
    const me = (await (await request.get(app.url('/api/v1/me'))).json()) as MeBody;
    expect(me.actor.kind).not.toBe('preview');
    expect(me.permissions).toEqual([]);
  });
});

test.describe('the retired variables are ignored', () => {
  test.afterAll(async () => {
    await restartServer('a');
  });

  test('PREVIEW_MODE=true and PREVIEW_MODE_ALLOW_REMOTE=true change nothing', async ({
    request,
    app,
    page,
  }) => {
    test.slow();
    await restartServer('a', { PREVIEW_MODE: 'true', PREVIEW_MODE_ALLOW_REMOTE: 'true' });
    // No cookie: the request is anonymous whatever the retired variables say.
    const anonymous = await request.get(app.url('/api/v1/me'), {
      headers: { cookie: '' },
    });
    const me = (await anonymous.json()) as MeBody;
    expect(me.actor.kind).toBe('anonymous');
    expect(me.permissions).toEqual([]);
    expect(me.features).not.toHaveProperty('preview');
    await app.goto('/');
    await expect(page.getByText('Preview mode')).toHaveCount(0);
  });
});
