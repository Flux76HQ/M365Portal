// Reduced motion (FR-A-122, E-18): under `prefers-reduced-motion: reduce` nothing animates. The
// stylesheet sets `animation: none` and `transition: none`, so no animation object exists at all;
// the Motion-driven pieces collapse their transitions to zero. The test records every animation that
// exists in any animation frame (not only the last moment) while it drives the interface.
// Runs in the `reduced-motion` project.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

declare global {
  interface Window {
    __animationsSeen: string[];
  }
}

/** Records, every animation frame, the animations that exist (CSS animations, transitions, Motion's WAAPI). */
async function recordAnimations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__animationsSeen = [];
    const sample = (): void => {
      for (const animation of document.getAnimations()) {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        const where =
          target instanceof Element
            ? `${target.tagName.toLowerCase()}[${target.getAttribute('data-slot') ?? ''}]`
            : '?';
        const name =
          'animationName' in animation
            ? (animation as unknown as { animationName: string }).animationName
            : 'transitionProperty' in animation
              ? `transition ${(animation as unknown as { transitionProperty: string }).transitionProperty}`
              : animation.id;
        window.__animationsSeen.push(`${name} on ${where}`);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function seen(page: Page): Promise<string[]> {
  return page.evaluate(() => [...new Set(window.__animationsSeen)]);
}

test('the browser reports the preference, and the stylesheet answers it', async ({ page, app }) => {
  await app.goto('/design');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
  const style = await page.getByRole('button', { name: 'Open a dialog' }).evaluate((element) => {
    const computed = getComputedStyle(element);
    return { animation: computed.animationName, transition: computed.transitionDuration };
  });
  expect(style.animation).toBe('none');
  expect(style.transition.split(',').every((value) => parseFloat(value) === 0)).toBe(true);
});

test('document.getAnimations() stays empty through dialogs, palette, menus, toasts, tooltips and theme changes', async ({
  page,
  app,
}) => {
  await recordAnimations(page);
  await app.goto('/design');
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);

  // Palette.
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.type('appear');
  await expect(page.getByRole('option', { name: /Appearance/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Dialog, confirm dialog and details panel.
  await page.getByRole('button', { name: 'Open a dialog' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sample dialog' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Got it' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete a contact' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open the details panel' }).click();
  await expect(page.getByRole('dialog', { name: 'Sample details' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Toasts of every tone, a menu, a select and a tooltip.
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

  // Theme and language switches, the sidebar toggle and a client-side navigation.
  await page
    .getByRole('radiogroup', { name: 'Theme' })
    .getByRole('radio', { name: 'Dark' })
    .click();
  await page
    .getByRole('radiogroup', { name: 'Theme' })
    .getByRole('radio', { name: 'Light' })
    .click();
  await page.getByRole('button', { name: 'Language' }).click();
  await page.getByRole('menuitemradio', { name: 'Nederlands' }).click();
  await page.getByRole('button', { name: 'Zijbalk invouwen' }).click();
  await page.getByRole('button', { name: 'Zijbalk uitvouwen' }).click();
  await page.getByRole('link', { name: 'Gebruikers' }).first().click();
  await expect(page).toHaveURL(/\/users$/);

  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(await seen(page), 'an animation existed in at least one frame').toEqual([]);
});

test('the Appearance page (live preview, save, toast) does not animate either', async ({
  page,
  app,
}) => {
  await recordAnimations(page);
  await app.goto('/settings/appearance');
  const name = page.getByRole('textbox', { name: /^Organisation name/ });
  await name.fill('Calm Co');
  await page.getByRole('textbox', { name: 'Accent colour (hex code)' }).fill('#336699');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.locator('[data-slot="toast-title"]', { hasText: 'Appearance saved' }).first(),
  ).toBeVisible();
  // Leave the preview instance as it was.
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reset appearance' }).click();
  await expect(
    page
      .locator('[data-slot="toast-title"]', { hasText: 'Appearance reset to the defaults' })
      .first(),
  ).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(await seen(page)).toEqual([]);
});

test.describe('the recorder itself', () => {
  test('sees an animation when motion is allowed (so an empty list means something)', async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await recordAnimations(page);
    await app.goto('/design');
    await page.getByRole('button', { name: 'Open a dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'Sample dialog' })).toBeVisible();
    await expect.poll(() => seen(page).then((list) => list.length)).toBeGreaterThan(0);
  });
});
