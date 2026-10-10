import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const version = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();

test('GET /healthz answers ok with the version of the VERSION file', async ({ page }) => {
  const response = await page.goto('/healthz');

  expect(response?.status()).toBe(200);
  expect(await response?.json()).toEqual({ status: 'ok', version });
});
