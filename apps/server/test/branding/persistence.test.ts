// T-A-093 (SC-A-008 part, E-01, US-3): branding survives a restart.
//
// A real HTTP server on a free port (`startServer`, the real `appModules`), a real data directory:
// upload a logo, apply a name, an accent and the logo, stop the server, start it again on the same
// `DATA_DIR`. Then:
//   - `GET /api/v1/branding` returns the identical document (revision, tokens, icons, timestamps);
//   - every image of that document is served again, byte for byte the same;
//   - the page shell and the manifest carry the stored name;
//   - the `__drizzle_migrations` row count has not changed (a restart migrates nothing);
//   - the audit chain verifies (`verifyChain`, and `dist/cli.js verify-audit` of the built bundle),
//     and holds the rows of the first run, once, with no second `branding.init`.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrandingSchema } from '@m365portal/shared/schemas/branding';
import { UploadAssetResponseSchema } from '@m365portal/shared/schemas/assets';
import { describe, expect, it, onTestFinished } from 'vitest';
import { verifyChain } from '../../src/audit/index.js';
import { DATABASE_FILE_NAME, openDatabase } from '../../src/db/index.js';
import { startServer, type RunningServer } from '../../src/start.js';
import { freePort } from '../helpers/built-server.js';
import { createHttpClient, readJson, type HttpClient } from '../helpers/http-client.js';
import { createLogCapture } from '../helpers/log-capture.js';
import { createTempDataDir } from '../helpers/temp-data-dir.js';
import { distinctPng } from './branding-fixture.js';

const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');

interface Run {
  readonly running: RunningServer;
  readonly client: HttpClient;
  readonly origin: string;
}

async function startOn(dataDir: string): Promise<Run> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const running = await startServer({
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PUBLIC_BASE_URL: origin,
      PREVIEW_MODE: 'true',
      LOG_LEVEL: 'warn',
    },
    stderr: createLogCapture(),
    logDestination: createLogCapture(),
    paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
    umask: () => undefined,
  });
  let stopped = false;
  onTestFinished(async () => {
    if (!stopped) await running.stop();
  });
  const original = running.stop.bind(running);
  (running as { stop: RunningServer['stop'] }).stop = async (signal) => {
    stopped = true;
    return original(signal);
  };
  return {
    running,
    origin,
    client: createHttpClient({ fetch: (request) => fetch(request), baseUrl: origin, origin }),
  };
}

function databaseFacts(dataDir: string): {
  migrations: number;
  actions: string[];
  verdict: ReturnType<typeof verifyChain>;
} {
  const database = openDatabase({ path: join(dataDir, DATABASE_FILE_NAME) });
  try {
    const migrations = (
      database.sqlite.prepare('SELECT count(*) AS n FROM "__drizzle_migrations"').get() as {
        n: number;
      }
    ).n;
    const actions = (
      database.sqlite.prepare('SELECT action FROM audit_log ORDER BY seq').all() as {
        action: string;
      }[]
    ).map((row) => row.action);
    return { migrations, actions, verdict: verifyChain(database.sqlite) };
  } finally {
    database.close();
  }
}

describe('branding survives a restart (real HTTP, one DATA_DIR)', () => {
  it('serves the same branding and the same images after stop and start, and the audit chain verifies', async () => {
    const dataDir = (await createTempDataDir()).path;
    const first = await startOn(dataDir);

    // Upload a logo and make it the light logo, with a name and an accent.
    const png = await distinctPng(7, 96);
    const form = new FormData();
    form.set('file', new Blob([png]), 'logo.png');
    const staged = await first.client.post('/api/v1/branding/assets?slot=logoLight', {
      body: form,
    });
    expect(staged.status).toBe(201);
    const { asset } = UploadAssetResponseSchema.parse(await readJson(staged));
    const current = await first.client.get('/api/v1/branding');
    const applied = await first.client.put('/api/v1/branding', {
      headers: { 'if-match': current.headers.get('etag') ?? '' },
      json: {
        orgName: 'Zandbergen Online \u{1F680}',
        accent: '#0B7A75',
        logos: { light: asset.hash, dark: null, compact: null },
      },
    });
    expect(applied.status, await applied.clone().text()).toBe(200);
    const before = await (await first.client.get('/api/v1/branding')).text();
    const branding = BrandingSchema.parse(JSON.parse(before));
    expect(branding.orgName).toBe('Zandbergen Online \u{1F680}');
    expect(branding.logos.light?.url).toBe(asset.url);
    const imageUrls = [
      branding.logos.light?.url,
      branding.icons.favicon32.url,
      branding.icons.appleTouch180.url,
      branding.icons.pwa192.url,
      branding.icons.pwa512.url,
      branding.icons.maskable512.url,
    ].filter((url): url is string => url !== undefined);
    const served: Record<string, string> = {};
    for (const url of imageUrls) {
      const response = await first.client.get(url);
      expect(response.status, url).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      served[url] = createHash('sha256').update(bytes).digest('hex');
      expect(url).toBe(`/branding/${served[url]}.png`);
    }
    const factsBefore = databaseFacts(dataDir);
    expect(await first.running.stop()).toBe(0);

    const second = await startOn(dataDir);
    const after = await (await second.client.get('/api/v1/branding')).text();
    expect(after).toBe(before);
    for (const url of imageUrls) {
      const response = await second.client.get(url);
      expect(response.status, url).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(createHash('sha256').update(bytes).digest('hex'), url).toBe(served[url]);
    }
    const page = await (await second.client.get('/', { headers: { accept: 'text/html' } })).text();
    expect(page).toContain('<title>Zandbergen Online \u{1F680}</title>');
    const manifest = await readJson<{ name: string }>(
      await second.client.get('/manifest.webmanifest'),
    );
    expect(manifest.name).toBe('Zandbergen Online \u{1F680}');
    await second.running.stop();

    const factsAfter = databaseFacts(dataDir);
    expect(factsAfter.migrations).toBe(factsBefore.migrations);
    expect(factsAfter.actions).toEqual(factsBefore.actions);
    expect(factsAfter.actions.filter((action) => action === 'branding.init')).toHaveLength(1);
    expect(factsAfter.actions).toContain('branding.asset.stage');
    expect(factsAfter.actions).toContain('branding.apply');
    expect(factsAfter.verdict).toMatchObject({ ok: true, triggersMissing: [] });
    expect(factsAfter.verdict.checked).toBe(factsAfter.actions.length);
  });

  it('a start on a data directory with a stored branding makes no second default row', async () => {
    const dataDir = (await createTempDataDir()).path;
    const first = await startOn(dataDir);
    const before = await (await first.client.get('/api/v1/branding')).text();
    await first.running.stop();
    const second = await startOn(dataDir);
    expect(await (await second.client.get('/api/v1/branding')).text()).toBe(before);
    await second.running.stop();
    expect(databaseFacts(dataDir).actions).toEqual(['branding.init']);
  });
});
