// T-B-008, FR-B-213 `node_version`, CB4: the wizard's environment check compares the running Node
// with ONE constant, `NODE_ENGINES_RANGE`. The test reads the `engines.node` range of the root
// `package.json` (the only `engines` field of the workspace; `apps/server/package.json` has none)
// and the `.nvmrc` major, so the constant, the manifest and the CI/Docker Node cannot drift.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NODE_ENGINES_RANGE,
  NODE_MAJOR,
  NODE_MINIMUM,
  isSupportedNodeVersion,
} from '../src/setup/node-version.js';
import { expectGuardFails } from '../src/testing/index.js';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

const rootManifest = JSON.parse(read('../../../package.json')) as { engines?: { node?: string } };
const nvmrc = read('../../../.nvmrc').trim();

describe('NODE_ENGINES_RANGE', () => {
  it('equals the engines.node range of the root package.json', () => {
    expect(rootManifest.engines?.node).toBe(NODE_ENGINES_RANGE);
  });

  it('is satisfied by the major of .nvmrc (the Node of CI and of the image)', () => {
    expect(nvmrc).toMatch(/^\d+$/);
    expect(Number(nvmrc)).toBe(NODE_MAJOR);
  });

  it('is satisfied by the Node that runs this test', () => {
    expect(isSupportedNodeVersion(process.versions.node)).toBe(true);
  });

  it('is built from the two parts the check compares', () => {
    const [major, minor, patch] = NODE_MINIMUM;
    expect(NODE_ENGINES_RANGE).toBe(
      `>=${String(major)}.${String(minor)}.${String(patch)} <${String(NODE_MAJOR + 1)}`,
    );
  });
});

describe('isSupportedNodeVersion', () => {
  it.each([
    ['22.19.0', true],
    ['22.19.1', true],
    ['22.22.0', true],
    ['v22.20.3', true],
    ['22.99.99', true],
    ['22.18.9', false],
    ['22.0.0', false],
    ['21.7.3', false],
    ['20.19.5', false],
    ['23.0.0', false],
    ['24.1.0', false],
    ['22.19', false],
    ['22', false],
    ['', false],
    ['latest', false],
    ['22.19.0-rc.1', false],
    ['022.19.0', false],
    ['22.19.0.1', false],
  ])('%j is supported: %s', (version, supported) => {
    expect(isSupportedNodeVersion(version)).toBe(supported);
  });
});

describe('the Node version guard (negative fixtures)', () => {
  function assertMatchesManifest(manifest: { engines?: { node?: string } }): void {
    if (manifest.engines?.node !== NODE_ENGINES_RANGE) {
      throw new Error(
        `engines.node is ${String(manifest.engines?.node)}, the constant is ${NODE_ENGINES_RANGE}`,
      );
    }
  }

  it('accepts the real manifest', () => {
    expect(() => {
      assertMatchesManifest(rootManifest);
    }).not.toThrow();
  });

  it('fails when the manifest range moves without the constant', () => {
    expectGuardFails(
      assertMatchesManifest,
      { engines: { node: '>=22.20.0 <23' } },
      { reason: 'engines.node is >=22.20.0 <23' },
    );
    expectGuardFails(assertMatchesManifest, {}, { reason: 'engines.node is undefined' });
  });
});
