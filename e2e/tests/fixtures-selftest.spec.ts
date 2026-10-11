// Self-test of the fixtures (T-A-320, TA-08): a guard nobody has seen fail is an assumption.
//
// For each thing the `guard` fixture is meant to catch there are two tests:
//   - "detects": provokes it, reads it with `guard.take(kind)` and checks it is the right kind with
//     the right text (this proves the fixture fails for the right reason);
//   - "fails the test": provokes it and does NOT read it; `test.fail()` expects the fixture teardown
//     to fail the test (this proves nothing swallows the failure).
import type { Page } from '@playwright/test';
import { expect, test, type ProblemKind } from '../fixtures.js';

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

test('the two instances answer and the stop and start helpers work on the same DATA_DIR', async ({
  app,
}) => {
  test.slow();
  const before = await fetch(`${app.origin('anonymous')}/healthz`);
  expect(before.status).toBe(200);
  await app.servers.stop('anonymous');
  await expect(fetch(`${app.origin('anonymous')}/healthz`)).rejects.toThrow();
  await app.servers.start('anonymous');
  expect((await fetch(`${app.origin('anonymous')}/healthz`)).status).toBe(200);
});
