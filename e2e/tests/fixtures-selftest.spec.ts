// Self-test of the fixtures (T-A-320, TA-08): a guard nobody has seen fail is an assumption.
//
// Phase B (T-B-370) adds: a request from page scripts to a Microsoft host, the topology (three
// processes, the principals and their storage states, the expired assignment, `norole`), and a
// global setup whose seeding fails and must fail the run instead of skipping.
//
// For each thing the `guard` fixture is meant to catch there are two tests:
//   - "detects": provokes it, reads it with `guard.take(kind)` and checks it is the right kind with
//     the right text (this proves the fixture fails for the right reason);
//   - "fails the test": provokes it and does NOT read it; `test.fail()` expects the fixture teardown
//     to fail the test (this proves nothing swallows the failure).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';
import { expect, test, type ProblemKind } from '../fixtures.js';
import { repoRoot } from '../servers.js';
import { e2ePort } from '../support/ports.js';
import {
  PRINCIPALS,
  STORED_PRINCIPAL_NAMES,
  type StoredPrincipalName,
} from '../support/principals.js';

interface Provocation {
  readonly name: string;
  readonly kind: ProblemKind;
  readonly text: RegExp;
  run(page: Page, appGoto: () => Promise<unknown>): Promise<void>;
}

const provocations: readonly Provocation[] = [
  {
    name: 'an inline script without a nonce (securitypolicyviolation)',
    kind: 'violation',
    text: /script-src/,
    async run(page) {
      await page.route('**/*', async (route) => {
        if (route.request().resourceType() !== 'document') return route.fallback();
        const response = await route.fetch();
        const body = (await response.text()).replace(
          '</head>',
          '<script>window.__injected = true;</script></head>',
        );
        // The headers of the real response stay, so the page's CSP applies to the patched body.
        await route.fulfill({ response, body });
      });
      await page.goto('/');
      await page.waitForLoadState('load');
    },
  },
  {
    name: 'a console.error',
    kind: 'console',
    text: /boom from the self-test/,
    async run(page, appGoto) {
      await appGoto();
      await page.evaluate(() => {
        console.error('boom from the self-test');
      });
    },
  },
  {
    name: 'a console warning that mentions Permissions-Policy',
    kind: 'console',
    text: /Permissions-Policy/,
    async run(page, appGoto) {
      await appGoto();
      await page.evaluate(() => {
        console.warn("Error with Permissions-Policy header: Unrecognized feature: 'self-test'.");
      });
    },
  },
  {
    name: 'an uncaught exception (pageerror)',
    kind: 'pageerror',
    text: /uncaught from the self-test/,
    async run(page, appGoto) {
      await appGoto();
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error('uncaught from the self-test');
        }, 0);
      });
      await page.waitForTimeout(100);
    },
  },
  {
    name: 'an unexpected same-origin 4xx response',
    kind: 'status',
    text: /^404 .*\/api\/v1\/no-such-route-selftest$/,
    async run(page, appGoto) {
      await appGoto();
      await page.evaluate(() => fetch('/api/v1/no-such-route-selftest'));
    },
  },
  {
    name: 'a request from page scripts to a Microsoft host',
    kind: 'origin',
    text: /^page request to a Microsoft host: GET https:\/\/graph\.microsoft\.com\/v1\.0\/me$/,
    async run(page) {
      // From a blank page, which has no policy: the panel's own CSP (connect-src 'self') would stop
      // such a request before it is made, which is the better outcome but gives the guard nothing to see.
      await page.goto('about:blank');
      await page.evaluate(() =>
        fetch('https://graph.microsoft.com/v1.0/me', { mode: 'no-cors' }).catch(() => undefined),
      );
    },
  },
  {
    name: 'a request to another origin',
    kind: 'origin',
    text: /^GET http:\/\/example\.invalid\/selftest$/,
    async run(page) {
      await page.route('http://example.invalid/**', (route) => route.abort());
      await page.goto('about:blank');
      await page.evaluate(() => fetch('http://example.invalid/selftest').catch(() => undefined));
    },
  },
];

const KINDS: readonly ProblemKind[] = ['violation', 'pageerror', 'console', 'status', 'origin'];

for (const provocation of provocations) {
  test(`the guard detects ${provocation.name}`, async ({ page, app, guard }) => {
    await provocation.run(page, () => app.goto('/'));
    const found = guard.take(provocation.kind);
    expect(found.map((problem) => problem.text).join('\n')).toMatch(provocation.text);
    // Whatever else the provocation caused (a CSP violation also logs a console error) is read
    // too, and nothing may be left over: the test must not fail in the teardown.
    for (const kind of KINDS) guard.take(kind);
    expect(guard.problems).toEqual([]);
  });

  test.describe(`the guard fails the test on ${provocation.name}`, () => {
    test.fail();
    test('a test that ignores it is reported as failed', async ({ page, app }) => {
      await provocation.run(page, () => app.goto('/'));
    });
  });
}

test('an allowed response is neither a status problem nor a console line', async ({
  page,
  app,
  guard,
}) => {
  guard.allowResponse({ status: 404, url: '/api/v1/allowed-selftest' });
  await app.goto('/');
  await page.evaluate(() => fetch('/api/v1/allowed-selftest'));
  expect(guard.problems).toEqual([]);
});

test('a clean page passes and the dark theme is really dark (P19)', async ({ page, app }) => {
  await app.goto('/');
  await app.expectTheme('light');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await app.expectTheme('dark');
});

test('the topology answers and the stop and start helpers work on the same DATA_DIR', async ({
  app,
}) => {
  test.slow();
  for (const instance of ['a', 'b'] as const) {
    expect((await fetch(`${app.origin(instance)}/healthz`)).status).toBe(200);
  }
  await app.servers.stop('b');
  await expect(fetch(`${app.origin('b')}/healthz`)).rejects.toThrow();
  await app.servers.start('b');
  expect((await fetch(`${app.origin('b')}/healthz`)).status).toBe(200);
});

test.describe('the principals (CB17)', () => {
  const EXPECTED_ROLES: Record<StoredPrincipalName, readonly string[]> = {
    owner: ['owner'],
    administrator: ['admin'],
    operator: ['operator'],
    helpdesk: ['helpdesk'],
    reader: ['reader'],
    norole: [],
    // The assignment was moved into the past in the database after the sign-in: the API refuses a
    // past expiry, so global-setup creates it with a future one and updates the row. The session
    // stays; the rights are gone.
    'expired-assignment': [],
    'group-member': ['helpdesk'],
  };

  for (const name of STORED_PRINCIPAL_NAMES) {
    test.describe(name, () => {
      test.use({ principal: name });
      test(`${name} is who the storage state says`, async ({ request, app }) => {
        const response = await request.get(app.url('/api/v1/me'));
        const me = (await response.json()) as {
          actor: { kind: string; label: string };
          roles: { key: string }[];
          permissions: string[];
        };
        if (name === 'norole') {
          // A Global Administrator without a role has no session at all (OV-15).
          expect(me.actor.kind).toBe('anonymous');
          expect(me.permissions).toEqual([]);
          return;
        }
        expect(me.actor.kind).toBe('user');
        expect(me.actor.label).toBe(PRINCIPALS[name].displayName);
        expect(me.roles.map((role) => role.key)).toEqual(EXPECTED_ROLES[name]);
        if (name === 'expired-assignment') expect(me.permissions).toEqual([]);
        else expect(me.permissions.length).toBeGreaterThan(0);
      });
    });
  }

  test.describe('anonymous', () => {
    test.use({ principal: 'anonymous' });
    test('norole signing in again ends on /no-access with no session', async ({ page, app }) => {
      await app.signInAs('norole', { expect: 'settled' });
      await expect(page).toHaveURL(/\/no-access\?reason=no_role/);
      const me = (await (await page.request.get(app.url('/api/v1/me'))).json()) as {
        actor: { kind: string };
      };
      expect(me.actor.kind).toBe('anonymous');
    });

    test('a Microsoft navigation is how a sign-in works and is not a problem', async ({
      page,
      app,
      guard,
    }) => {
      await app.signInAs('reader');
      await app.ready();
      await expect(page.getByRole('button', { name: /Account menu of Rita Reader/ })).toBeVisible();
      expect(guard.problems).toEqual([]);
    });
  });
});

test.describe('the global setup', () => {
  test('a failing seed fails the run loudly, and leaves nothing behind', async () => {
    test.slow();
    // Its own block of ports, so that it can start beside the topology of this run.
    const port = e2ePort() + 10;
    const before = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith('m365portal-e2e-')),
    );
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'e2e/support/global-setup-probe.ts'],
      {
        cwd: repoRoot,
        env: { ...process.env, E2E_PORT: String(port), E2E_SABOTAGE_SEED: 'unlock' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code, output).toBe(1);
    expect(output).toContain('SETUP_FAILED: setup unlock on instance a answered');
    expect(output).not.toContain('SETUP_OK');
    const left = readdirSync(tmpdir()).filter(
      (name) => name.startsWith('m365portal-e2e-') && !before.has(name),
    );
    expect(left, 'the failed run removed its run directory').toEqual([]);
    expect(existsSync(`${tmpdir()}/${left[0] ?? 'none'}`)).toBe(false);
    // ... and the processes of the failed run are gone: its ports no longer answer.
    for (const offset of [0, 1, 2]) {
      await expect(fetch(`http://127.0.0.1:${String(port + offset)}/healthz`)).rejects.toThrow();
    }
  });
});
