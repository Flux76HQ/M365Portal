// Hostile organisation names (FR-A-132, E-07, E-12, H-44; SC-A-008): a name is data. The two names of
// the brief are saved and then looked for everywhere the name appears (tab title, manifest, sidebar,
// header, toasts, dialogs, the page source the server sent). No script runs, no element is created, no
// dialog opens, the CSP reports nothing (the fixture), and a right-to-left name sits in an isolating
// element so that it cannot reorder the text around it.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { openAppearance, restoreDefaults, save, toast } from '../branding-helpers.js';

const NAMES = [
  '"><img src=x onerror=alert(1)>',
  '</title><script>alert(1)</script>',
  // Canaries that leave a trace in the page when they run, in case a dialog is blocked or not shown.
  '"><img src=x onerror=window.__pwned=1>',
  '<svg/onload=window.__pwned=2>',
  '{{7*7}} ${7*7} <b>bold</b>',
] as const;

test.beforeEach(async ({ app }) => {
  await app.servers.restart('a');
});

test.afterEach(async ({ request, app }) => {
  await restoreDefaults(request, app);
});

/** Counts the dialogs (alert, confirm, prompt) the page raises, and dismisses them. */
function watchDialogs(page: Page): string[] {
  const raised: string[] = [];
  page.on('dialog', (dialog) => {
    raised.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return raised;
}

async function pwned(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned);
}

for (const name of NAMES) {
  test.describe(`the name ${JSON.stringify(name)}`, () => {
    test('is inert in the title, the manifest, the sidebar, the toasts and the dialogs', async ({
      page,
      app,
      request,
      guard,
    }) => {
      const dialogs = watchDialogs(page);
      const fields = await openAppearance(page, app);
      const scriptsBefore = await page.locator('script').count();

      await fields.name.fill(name);
      // The live preview draws it as text, before anything is saved.
      await expect(fields.previewLight.locator('[data-slot="org-name"]').first()).toHaveText(name);
      await save(page);
      await expect(toast(page, 'Appearance saved')).toBeVisible();

      // Tab title: the literal text.
      await expect(page).toHaveTitle(`Appearance - ${name}`);
      // Sidebar and header: text, not markup.
      await expect(fields.sidebarName).toHaveText(name);
      await expect(
        page.locator('main img[src="x"], header img[src="x"], aside img[src="x"]'),
      ).toHaveCount(0);
      expect(await page.locator('script').count(), 'no script element was added').toBe(
        scriptsBefore,
      );

      // Dialogs that name the organisation: Reset and Leave.
      await fields.reset.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Appearance of ${name}`);
      expect(await dialog.locator('img, script, svg[onload]').count()).toBe(0);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await fields.name.fill(`${name} edit`);
      await page.getByRole('link', { name: 'Dashboard' }).first().click();
      const leave = page.getByRole('alertdialog');
      await expect(leave).toBeVisible();
      await leave.getByRole('button', { name: 'Stay on this page' }).click();
      await fields.discard.click();

      // The manifest is one JSON string.
      const response = await request.get(app.url('/manifest.webmanifest'));
      expect(response.headers()['content-type']).toContain('manifest+json');
      const manifest = (await response.json()) as { name: string };
      expect(manifest.name).toBe(name);

      // The page the server sends: the name is escaped in the title and in the embedded data.
      const html = await (
        await request.get(app.url('/'), { headers: { Accept: 'text/html' } })
      ).text();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<svg/onload');
      const titleElement = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '';
      expect(titleElement).not.toMatch(/[<>"]/);
      // The embedded JSON stays one script element whatever the name holds.
      expect((html.match(/<\/script>/g) ?? []).length).toBe(
        (html.match(/<script\b/g) ?? []).length,
      );

      // A reload draws everything again from the server's data.
      await page.reload();
      await app.ready();
      await expect(fields.sidebarName).toHaveText(name);
      await expect(page).toHaveTitle(`Appearance - ${name}`);

      expect(dialogs, 'no alert, confirm or prompt opened').toEqual([]);
      expect(await pwned(page), 'no canary ran').toBeUndefined();
      expect(guard.problems, 'no CSP violation, console error or page error').toEqual([]);
    });
  });
}

test.describe('the name in the other places of the app', () => {
  test('is inert on the dashboard, the palette, the header on a phone and the offline-free routes', async ({
    page,
    app,
    guard,
  }) => {
    const dialogs = watchDialogs(page);
    const name = NAMES[0];
    const fields = await openAppearance(page, app);
    await fields.name.fill(name);
    await save(page);

    for (const route of ['/', '/users', '/settings', '/design', '/no-access', '/nope']) {
      await app.goto(route);
      await expect(fields.sidebarName).toHaveText(name);
      await expect(page.locator('img[src="x"]')).toHaveCount(0);
    }
    await page.keyboard.press('Control+k');
    await page.keyboard.type('appear');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await app.goto('/');
    await expect(page.locator('header [data-slot="org-name"]').first()).toHaveText(name);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('dialog', { name: 'Navigation menu' })).toBeVisible();
    await page.keyboard.press('Escape');

    expect(dialogs).toEqual([]);
    expect(await pwned(page)).toBeUndefined();
    expect(guard.problems).toEqual([]);
  });

  test('is inert next to the actor label and in Dutch', async ({ page, app, guard }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('m365portal.locale', 'nl');
    });
    const dialogs = watchDialogs(page);
    const fields = await openAppearance(page, app);
    await fields.name.fill(NAMES[1]);
    await fields.previewLight.waitFor();
    const saved = page.waitForResponse(
      (response) => response.request().method() === 'PUT' && response.status() === 200,
    );
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await saved;
    await page.getByRole('button', { name: 'Standaardwaarden herstellen' }).click();
    await expect(page.getByRole('alertdialog')).toContainText(`Uiterlijk van ${NAMES[1]}`);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Annuleren' }).click();
    expect(dialogs).toEqual([]);
    expect(guard.problems).toEqual([]);
  });
});

test.describe('a right-to-left name', () => {
  const ARABIC = 'مرحبا بالعالم';
  const HEBREW = 'שלום עולם Ltd (1)';

  for (const name of [ARABIC, HEBREW]) {
    test(`${name} sits in an isolating element, and the text around it stays in order`, async ({
      page,
      app,
    }) => {
      const fields = await openAppearance(page, app);
      await fields.name.fill(name);
      await save(page);
      await expect(fields.sidebarName).toHaveText(name);

      // The element that holds the name isolates it from its surroundings (<bdi> or unicode-bidi).
      const isolation = await fields.sidebarName.evaluate((element) => {
        const chain: { tag: string; bidi: string; dir: string | null }[] = [];
        for (
          let node: Element | null = element;
          node !== null && chain.length < 3;
          node = node.parentElement
        ) {
          chain.push({
            tag: node.tagName.toLowerCase(),
            bidi: getComputedStyle(node).unicodeBidi,
            dir: node.getAttribute('dir'),
          });
        }
        return chain;
      });
      const isolated = isolation.some(
        (entry) => entry.tag === 'bdi' || entry.bidi.includes('isolate') || entry.dir === 'auto',
      );
      expect(isolated, `no isolating element around the name: ${JSON.stringify(isolation)}`).toBe(
        true,
      );

      // The preview pane draws it in an isolating element as well.
      await expect(fields.previewLight.locator('[data-slot="org-name"]').first()).toHaveText(name);
      // The interface itself stays left to right (E-07).
      expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe('ltr');
      expect(await page.evaluate(() => document.documentElement.dir)).not.toBe('rtl');
    });

    // D-3 (reported in chunk-s9b.md): the name is interpolated into the sentence of the Reset dialog
    // ("Appearance of {name}") as plain text. E-07 says every RTL name renders inside an isolating
    // element so the surrounding UI is not reordered. This test stays red until the dialog isolates it.
    test(`D-3: ${name} is isolated in the sentence of the Reset dialog`, async ({ page, app }) => {
      const fields = await openAppearance(page, app);
      await fields.name.fill(name);
      await save(page);
      await fields.reset.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(name);
      const object = dialog.locator('[data-slot="confirm-object"]');
      const isolated = await object.evaluate((element, rtl) => {
        const text = element.textContent;
        const hasMarks = /[\u2066-\u2069]/.test(text);
        const wrapper = [...element.querySelectorAll('bdi, [dir], *')].find(
          (child) =>
            child.textContent.includes(rtl) &&
            child !== element &&
            (child.tagName === 'BDI' ||
              child.getAttribute('dir') === 'auto' ||
              getComputedStyle(child).unicodeBidi.includes('isolate')),
        );
        return hasMarks || wrapper !== undefined;
      }, name);
      expect(
        isolated,
        'the name inside "Appearance of ..." has no isolating element or isolate marks',
      ).toBe(true);
    });
  }
});
