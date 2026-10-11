import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { APP_VERSION, parseVersion } from '../src/version.js';
import { buildLayout, spawnServer, type BuiltLayout } from './helpers/built-server.js';

const VERSION_FILE = new URL('../../../VERSION', import.meta.url);

describe('version', () => {
  it('APP_VERSION is MAJOR.MINOR.PATCH', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('parseVersion trims a trailing newline', () => {
    expect(parseVersion('1.2.3\n')).toBe('1.2.3');
  });

  it.each(['', '1.2', 'v1.2.3', '1.2.3-rc.1', 'latest'])('parseVersion rejects "%s"', (value) => {
    expect(() => parseVersion(value)).toThrow('VERSION must contain MAJOR.MINOR.PATCH');
  });
});

describe('the embedded version (FR-A-163, FR-A-187, PD-23)', () => {
  const versionFile = readFileSync(VERSION_FILE, 'utf8').trim();

  it('under the source (tsx, Vitest) the constant is the VERSION file', () => {
    expect(APP_VERSION).toBe(versionFile);
  });

  describe('in the build', () => {
    let layout: BuiltLayout;

    beforeAll(async () => {
      layout = await buildLayout();
    }, 120_000);

    afterAll(async () => {
      await layout.remove();
    });

    it('the bundle holds the version as a constant, with no VERSION file next to it', () => {
      const bundle = readFileSync(join(layout.dist, 'index.js'), 'utf8');
      expect(bundle).toContain(JSON.stringify(versionFile));
      expect(bundle).not.toContain('__APP_VERSION__');
      expect(() => readFileSync(join(layout.root, 'VERSION'))).toThrow();
    });

    it('/healthz of the running bundle answers that version', async () => {
      const server = await spawnServer({ layout });
      onTestFinished(async () => {
        server.kill();
        await server.exited;
      });
      await server.listening();
      const response = await server.get('/healthz');
      expect(JSON.parse(response.body)).toEqual({ status: 'ok', version: versionFile });
    });

    it('a build whose VERSION file is not MAJOR.MINOR.PATCH is refused (negative)', () => {
      expect(() => parseVersion('0.2')).toThrow('VERSION must contain MAJOR.MINOR.PATCH');
    });
  });
});
