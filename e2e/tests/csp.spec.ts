// CSP and Trusted Types in a real browser (FR-A-042, FR-A-040 browser half, SC-A-005, US-4.3).
//
// Zero `securitypolicyviolation` events across all routes and interactions. The `guard` fixture
// fails any test that sees one; the tests below also state it, and prove with deliberate sinks that
// the policy really is enforced (a guard that cannot fire proves nothing).
import { ROUTES } from '../routes.js';
import { NO_ACCESS_REASONS, SIGNIN_ERROR_CODES } from '@m365portal/shared/auth/signin-errors';
import { allowLockedSetup, expect, test } from '../fixtures.js';
import { readState } from '../servers.js';
import { originOf } from '../support/ports.js';
import {
  allowStaleCsrfAfterUnlock,
  passEnvironment,
  startDeviceSignIn,
  unlock,
} from '../support/wizard-page.js';

test.describe('zero violations', () => {
  for (const route of ROUTES) {
    test(`${route} loads, scrolls and switches theme and language without a violation`, async ({
      page,
      app,
      guard,
    }) => {
      allowLockedSetup(guard);
      await app.goto(route);
      await page.mouse.wheel(0, 600);
      await page.getByRole('radio', { name: 'Dark' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.getByRole('radio', { name: 'Light' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await page.getByRole('button', { name: 'Language' }).click();
      await page.getByRole('menuitemradio', { name: 'Nederlands' }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await page.getByRole('button', { name: 'Taal' }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      expect(guard.problems).toEqual([]);
    });
  }

  test('the dialog, the palette, the shortcuts overview and the scroll lock', async ({
    page,
    app,
    guard,
  }) => {
    await app.goto('/design');

    // Command palette: Ctrl+K opens, Esc closes.
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    // Inside the dialog: the demo table's "Rows per page" select is a combobox too, and it appears when
    // the sample data arrives, at a moment that depends on how fast the page got here.
    await expect(page.getByRole('dialog').getByRole('combobox')).toBeFocused();
    await page.keyboard.type('appear');
    await expect(page.getByRole('option', { name: /Appearance/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Shortcuts overview.
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // A modal dialog locks the scroll of the page behind it (CSSOM, not an inline attribute).
    await page.getByRole('button', { name: 'Open a dialog' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sample dialog' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-scroll-locked', /.+/);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
    await dialog.getByRole('button', { name: 'Got it' }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).overflow))
      .not.toBe('hidden');

    // Confirm dialog and details panel.
    await page.getByRole('button', { name: 'Delete a contact' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Open the details panel' }).click();
    await expect(page.getByRole('dialog', { name: 'Sample details' })).toBeVisible();
    await page.keyboard.press('Escape');

    expect(guard.problems).toEqual([]);
  });

  test('toasts of every tone and the select, menu and tooltip popovers', async ({
    page,
    app,
    guard,
  }) => {
    await app.goto('/design');
    for (const name of ['Success toast', 'Info toast', 'Warning toast', 'Error toast']) {
      await page.getByRole('button', { name }).click();
    }
    await expect(
      page.getByText('A toast reports the result of something you did.').first(),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Open a menu' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');

    await page
      .getByRole('combobox', { name: /Field label/ })
      .first()
      .click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'What is this?' }).hover();
    await expect(page.getByRole('tooltip').first()).toBeVisible();

    expect(guard.problems).toEqual([]);
  });

  test('the Appearance form, its preview and its dialogs', async ({ page, app, guard }) => {
    await app.goto('/settings/appearance');
    await page.getByRole('textbox', { name: /^Organisation name/ }).fill('Contoso <b>test</b>');
    await page.getByRole('textbox', { name: 'Accent colour (hex code)' }).fill('#cc3300');
    await page.getByRole('textbox', { name: 'Accent colour (hex code)' }).blur();
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await page.keyboard.press('Escape');
    expect(guard.problems).toEqual([]);
  });
});

test.describe('the policy is enforced', () => {
  test('the HTML response carries the Trusted Types directives', async ({ app, page }) => {
    const response = await app.goto('/', { raw: true });
    const csp = (await response?.headerValue('content-security-policy')) ?? '';
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toMatch(/trusted-types m365portal-sw(;|$)/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    await page.waitForLoadState('load');
  });

  test('assigning innerHTML throws under Trusted Types and is reported as a violation', async ({
    page,
    app,
    guard,
  }) => {
    await app.goto('/');
    const message = await page.evaluate(() => {
      try {
        document.body.innerHTML = '<img src=x>';
        return 'no error';
      } catch (error) {
        return (error as Error).name + ': ' + (error as Error).message;
      }
    });
    expect(message).toMatch(/^TypeError: .*TrustedHTML/);
    expect(await page.evaluate(() => document.querySelectorAll('img[src="x"]').length)).toBe(0);
    const violations = guard.take('violation');
    expect(violations.map((v) => v.text).join('\n')).toMatch(/require-trusted-types-for/);
    guard.take('console');
    expect(guard.problems).toEqual([]);
  });

  test('eval, an unlisted policy name and an inline style attribute are refused', async ({
    page,
    app,
    guard,
  }) => {
    await app.goto('/');
    const results = await page.evaluate(() => {
      const out: Record<string, string> = {};
      try {
        (
          window as unknown as {
            trustedTypes?: { createPolicy(name: string, rules: object): unknown };
          }
        ).trustedTypes?.createPolicy('not-on-the-list', { createHTML: (value: string) => value });
        out.policy = 'allowed';
      } catch (error) {
        out.policy = (error as Error).name;
      }
      const el = document.createElement('div');
      el.setAttribute('style', 'color: red');
      document.body.append(el);
      return out;
    });
    // CDP-evaluated code is exempt from the eval rule, so eval runs from a timer callback, which is
    // an ordinary task of the page.
    await page.evaluate(() => {
      setTimeout(() => {
        try {
          (0, eval)('1 + 1');
          (window as unknown as Record<string, string>).__evalResult = 'allowed';
        } catch (error) {
          (window as unknown as Record<string, string>).__evalResult = (error as Error).name;
        }
      }, 0);
    });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Record<string, string>).__evalResult))
      .toBe('EvalError');
    expect(results.policy).toBe('TypeError');
    // The inline style attribute was reported; CSSOM writes are not (the app relies on them).
    const violations = guard.take('violation').map((v) => v.text);
    expect(violations.some((text) => /^(style-src|require-trusted)/.test(text))).toBe(true);
    for (const kind of ['console', 'pageerror'] as const) guard.take(kind);
    await page.evaluate(() => {
      document.body.style.setProperty('--csp-probe', '1');
    });
    expect(guard.problems).toEqual([]);
  });
});

// ---- Phase B (T-B-377): the new routes and states -----------------------------------------------------
// The guard fails every test on a `securitypolicyviolation` and on a request from page scripts to a
// Microsoft host; each test also states that nothing was seen.

test.describe('Phase B: sign-in, no-access, break-glass', () => {
  test.use({ principal: 'anonymous' });

  for (const code of SIGNIN_ERROR_CODES) {
    test(`/signin?error=${code} renders without a violation`, async ({ page, app, guard }) => {
      await app.goto(`/signin?error=${code}`);
      await expect(page.locator('[data-slot="signin-error"]')).toHaveAttribute('data-code', code);
      await page.getByRole('radio', { name: 'Dark' }).click();
      await page.getByRole('radio', { name: 'Light' }).click();
      expect(guard.problems).toEqual([]);
    });
  }

  for (const reason of NO_ACCESS_REASONS) {
    test(`/no-access?reason=${reason} renders without a violation`, async ({
      page,
      app,
      guard,
    }) => {
      await app.goto(`/no-access?reason=${reason}&ref=0123456789abcdef`);
      await expect(
        page.getByRole('heading', { level: 1, name: 'No access to the panel' }),
      ).toBeVisible();
      expect(guard.problems).toEqual([]);
    });
  }

  test('the whole sign-in, with its interstitial, causes no violation and no script request to Microsoft', async ({
    app,
    guard,
  }) => {
    await app.signInAs('helpdesk');
    await app.ready();
    expect(guard.problems).toEqual([]);
  });

  test('/break-glass renders without a violation', async ({ page, app, guard }) => {
    await app.goto('/break-glass');
    await expect(page.getByRole('heading', { level: 1, name: 'Break-glass access' })).toBeVisible();
    expect(guard.problems).toEqual([]);
  });
});

test.describe('Phase B: Settings pages', () => {
  for (const route of [
    '/settings',
    '/settings/appearance',
    '/settings/connection',
    '/settings/access',
  ]) {
    test(`${route} for the owner renders without a violation`, async ({ page, app, guard }) => {
      await app.goto(route);
      await page.waitForLoadState('networkidle');
      await page.mouse.wheel(0, 800);
      expect(guard.problems).toEqual([]);
    });
  }

  test('the break-glass banner and the restore page cause no violation', async ({
    page,
    app,
    guard,
  }) => {
    test.slow();
    await page.context().clearCookies();
    await app.goto('/break-glass');
    await page.getByLabel('Username').fill(readState().secrets.breakGlass.username);
    await page.getByLabel('Password').fill(readState().secrets.breakGlass.password);
    await page.getByRole('button', { name: 'Sign in with break-glass access' }).click();
    await page.waitForURL(/\/settings\/restore-access$/);
    await app.ready();
    await expect(page.getByTestId('break-glass-banner')).toBeVisible();
    expect(guard.problems).toEqual([]);
  });
});

test.describe('Phase B: the wizard', () => {
  test.use({ principal: 'anonymous', ownClientAddress: false });

  test('the token form, the steps, the device code and the copy action cause no violation', async ({
    page,
    app,
    guard,
    context,
  }) => {
    test.slow();
    allowStaleCsrfAfterUnlock(guard);
    await app.servers.resetEmpty();
    await context.grantPermissions(['clipboard-write'], {
      origin: originOf('b'),
    });
    await app.goto('/setup', { instance: 'b' });
    await expect(page.getByLabel('Setup token')).toBeVisible();
    expect(guard.problems, 'the token form').toEqual([]);

    await unlock(page);
    await passEnvironment(page);
    expect(guard.problems, 'the steps').toEqual([]);

    await startDeviceSignIn(page);
    await page.getByRole('button', { name: 'Copy the code' }).click();
    await expect(page.getByText('Code copied')).toBeVisible();
    // (Reading the clipboard back is not allowed by the Permissions-Policy: only writing is, by design.)
    expect(guard.problems, 'the device code and the copy action').toEqual([]);

    await page.getByRole('button', { name: 'Cancel the sign-in' }).click();
    await page.getByRole('button', { name: 'Set up by hand' }).click();
    await expect(page.getByRole('heading', { level: 3, name: 'Set up by hand' })).toBeVisible();
    expect(guard.problems, 'manual mode').toEqual([]);
  });
});
