// Unit tests of the self-hosted font rule. The negatives are the point: a check that cannot fail is
// worth nothing (baseline section 2).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSelfHostedFont } from './self-hosted-font.mjs';

const ORIGIN = 'http://localhost:4173';
const ok = (path) => isSelfHostedFont(`${ORIGIN}${path}`, ORIGIN);

test('the latin and latin-ext subsets served from /assets are self-hosted', () => {
  assert.equal(ok('/assets/inter-latin-wght-normal-Dx4kXJAl.woff2'), true);
  assert.equal(ok('/assets/inter-latin-ext-wght-normal-DO1Apj_S.woff2'), true);
});

test('other subsets, other directories and other file types are not', () => {
  assert.equal(ok('/assets/inter-cyrillic-wght-normal-abc.woff2'), false);
  assert.equal(ok('/fonts/inter-latin-wght-normal-abc.woff2'), false);
  assert.equal(ok('/assets/inter-latin-wght-normal-abc.woff'), false);
  assert.equal(ok('/assets/evil/inter-latin-wght-normal-abc.woff2'), false);
});

test('an external font URL fails, even with a path that looks self-hosted', () => {
  assert.equal(
    isSelfHostedFont('https://fonts.gstatic.com/s/inter/v13/UcC73Fwr.woff2', ORIGIN),
    false,
  );
  assert.equal(
    isSelfHostedFont('https://fonts.gstatic.com/assets/inter-latin-wght-normal-x.woff2', ORIGIN),
    false,
  );
});
