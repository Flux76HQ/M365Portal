// T-B-019, FR-B-108, EB-12, SC-B-011 part: the secrets state at start, in `/readyz` and in the
// degraded mode. The server is started in process through the real `startServer` with the secrets
// module (and a probe module that keeps the `ModuleDeps` it was given), against data directories
// that were prepared the way an installed system looks: a completed setup, a certificate sealed
// under a throwaway key.
//
// What this file proves: the five states (`ok`, `key_missing`, `key_invalid`,
// `certificate_unreadable`, `no_certificate`); that the process stays up in every one of them
// (`/healthz` 200, the static UI served); that `/readyz` fails the `secrets` check with the right
// code once setup is completed or a certificate exists, and only then; that the previous key opens
// rows still on it and says so once; and that no key ever reaches a log line, stderr or a response.
// Sign-in and break-glass answer from the same state (the registry and the auth module read
// `deps.secrets`); their own tests are in S-B2 and S-B4.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReadyzResponseSchema } from '@m365portal/shared/schemas/health';
import { describe, expect, it, onTestFinished } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { databasePathOf, openDatabase } from '../../src/db/index.js';
import type { AppModuleFactory, ModuleDeps } from '../../src/module.js';
import { secretsModule } from '../../src/secrets/module.js';
import { lazyCertificateFactory } from '../../src/secrets/certificate-factory.js';
import { CertificateService } from '../../src/secrets/certificate-service.js';
import { SecretStore, keyRingOf } from '../../src/secrets/secret-store.js';
import { initSealedBox } from '../../src/secrets/sealed-box.js';
import { startServer } from '../../src/start.js';
import { freePort, httpRequest } from '../helpers/built-server.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createLogCapture } from '../helpers/log-capture.js';
import { createTempDataDir } from '../helpers/temp-data-dir.js';
import { countingRandom, INSTALL_ID, throwawayKey } from './support.js';

const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');

const b64 = (key: Uint8Array): string => Buffer.from(key).toString('base64');
const hexOf = (key: Uint8Array): string => Buffer.from(key).toString('hex');

interface Prepared {
  readonly dataDir: string;
}

/** A data directory as an installation leaves it: migrated, `setup_state`, optionally a certificate. */
async function prepare(options: {
  state: 'unconfigured' | 'completed';
  certificate?: { key: Uint8Array; activate: boolean };
}): Promise<Prepared> {
  await initSealedBox();
  const dir = await createTempDataDir();
  const database = openDatabase({ path: databasePathOf(dir.path) });
  try {
    await runMigrations(database.sqlite, {
      migrationsFolder: MIGRATIONS,
      backupsDir: join(dir.path, 'backups'),
    });
    database.sqlite
      .prepare(
        "INSERT INTO setup_state (id, state, mode, install_id, completed_at, updated_at) VALUES (1, ?, 'automatic', ?, ?, '2026-10-10T12:00:00.000Z')",
      )
      .run(
        options.state,
        INSTALL_ID,
        options.state === 'completed' ? '2026-10-10T12:00:00.000Z' : null,
      );
    if (options.certificate !== undefined) {
      const clock = createFakeClock();
      const random = countingRandom(5);
      const service = new CertificateService({
        store: new SecretStore({ keys: keyRingOf(options.certificate.key), random }),
        factory: lazyCertificateFactory,
        clock: { now: () => clock.nowMs() },
        random,
      });
      const created = await service.create(database, { kind: 'setup', id: 'setup' });
      if (options.certificate.activate) service.activate(database, created.id);
    }
  } finally {
    database.close();
  }
  return { dataDir: dir.path };
}

interface Booted {
  readonly port: number;
  readonly deps: () => ModuleDeps;
  readonly logs: ReturnType<typeof createLogCapture>;
  readonly stderr: ReturnType<typeof createLogCapture>;
  readonly clock: ReturnType<typeof createFakeClock>;
  stop(): Promise<number>;
}

async function boot(dataDir: string, env: Record<string, string> = {}): Promise<Booted> {
  let captured: ModuleDeps | undefined;
  const probe: AppModuleFactory = (deps) => {
    captured = deps;
    return { id: 'probe', routes: () => [] };
  };
  const port = await freePort();
  const logs = createLogCapture();
  const stderr = createLogCapture();
  const clock = createFakeClock();
  const running = await startServer({
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PUBLIC_BASE_URL: `http://localhost:${String(port)}`,
      LOG_LEVEL: 'debug',
      ...env,
    },
    stderr,
    logDestination: logs,
    modules: [secretsModule, probe],
    clock: { now: () => clock.nowMs(), monotonic: () => clock.nowMs() },
    paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
    umask: () => undefined,
  });
  let stopped: Promise<number> | undefined;
  const stop = (): Promise<number> => (stopped ??= running.stop());
  onTestFinished(async () => {
    await stop();
  });
  return {
    port,
    deps: () => {
      if (captured === undefined) throw new Error('the probe module was not built');
      return captured;
    },
    logs,
    stderr,
    clock,
    stop,
  };
}

async function readyz(server: Booted): Promise<{
  status: number;
  checks: Record<string, string>;
  body: string;
}> {
  // The answer is cached for 2 seconds on the injected clock.
  server.clock.advance(5000);
  const result = await httpRequest(server.port, '/readyz');
  const parsed = ReadyzResponseSchema.parse(JSON.parse(result.body));
  return {
    status: result.status,
    checks: Object.fromEntries(parsed.checks.map((check) => [check.name, check.code ?? 'ok'])),
    body: result.body,
  };
}

async function expectStaysUp(server: Booted): Promise<void> {
  expect((await httpRequest(server.port, '/healthz')).status).toBe(200);
  const page = await httpRequest(server.port, '/', { headers: { accept: 'text/html' } });
  expect(page.status).toBe(200);
}

describe('a healthy installation', () => {
  it('state ok: the holder of the active certificate, /readyz ready, the key id logged and no key anywhere', async () => {
    const key = throwawayKey();
    const { dataDir } = await prepare({
      state: 'completed',
      certificate: { key, activate: true },
    });
    const server = await boot(dataDir, { APP_KEY: b64(key) });
    const state = server.deps().secrets.state();
    expect(state.status).toBe('ok');
    expect(state.holder?.publicCertificateDer().length).toBeGreaterThan(300);
    const jws = await state.holder?.signCompact({ alg: 'PS256' }, new TextEncoder().encode('{}'));
    expect(jws?.split('.')).toHaveLength(3);

    const ready = await readyz(server);
    expect(ready.status).toBe(200);
    expect(ready.checks).toEqual({ data_dir: 'ok', database: 'ok', schema: 'ok', secrets: 'ok' });

    const everything = `${server.logs.text()}${server.stderr.text()}${ready.body}`;
    for (const form of [b64(key), hexOf(key), Buffer.from(key).toString('base64url')]) {
      expect(everything).not.toContain(form);
    }
    expect(
      server.logs.lines().some((line) => line.event === 'secrets_state' && line.status === 'ok'),
    ).toBe(true);
  });

  it('APP_KEY_FILE works, with one trailing newline trimmed', async () => {
    const key = throwawayKey();
    const { dataDir } = await prepare({
      state: 'completed',
      certificate: { key, activate: true },
    });
    const path = join((await createTempDataDir()).path, 'app-key');
    writeFileSync(path, `${b64(key)}\n`);
    const server = await boot(dataDir, { APP_KEY_FILE: path });
    expect(server.deps().secrets.state().status).toBe('ok');
  });
});

describe('the degraded states of an installed system (EB-12)', () => {
  it('APP_KEY missing: key_missing, /healthz 200, the UI served, /readyz 503 secrets app_key_missing', async () => {
    const key = throwawayKey();
    const { dataDir } = await prepare({
      state: 'completed',
      certificate: { key, activate: true },
    });
    const server = await boot(dataDir);
    expect(server.deps().secrets.state().status).toBe('key_missing');
    expect(server.deps().secrets.state().holder).toBeUndefined();
    await expectStaysUp(server);
    const ready = await readyz(server);
    expect(ready.status).toBe(503);
    expect(ready.checks).toEqual({
      data_dir: 'ok',
      database: 'ok',
      schema: 'ok',
      secrets: 'app_key_missing',
    });
  });

  it('APP_KEY_FILE unreadable is key_missing, not an exit', async () => {
    const key = throwawayKey();
    const { dataDir } = await prepare({
      state: 'completed',
      certificate: { key, activate: true },
    });
    const server = await boot(dataDir, { APP_KEY_FILE: join(dataDir, 'no-such-key-file') });
    expect(server.deps().secrets.state().status).toBe('key_missing');
    await expectStaysUp(server);
    expect((await readyz(server)).checks.secrets).toBe('app_key_missing');
    // The path is not repeated in the log with an error text.
    expect(server.logs.text()).not.toMatch(/ENOENT/);
  });

  it('a key file over 1,024 bytes is key_invalid', async () => {
    const key = throwawayKey();
    const { dataDir } = await prepare({
      state: 'completed',
      certificate: { key, activate: true },
    });
    const path = join((await createTempDataDir()).path, 'big-key');
    writeFileSync(path, `${b64(key)}${' '.repeat(2000)}`);
    const server = await boot(dataDir, { APP_KEY_FILE: path });
    expect(server.deps().secrets.state().status).toBe('key_invalid');
    expect((await readyz(server)).checks.secrets).toBe('app_key_invalid');
  });

  it('a key that does not open the certificate: key_invalid, /readyz app_key_invalid, nothing else breaks', async () => {
    const key = throwawayKey();
    const wrong = throwawayKey();
    const { dataDir } = await prepare({
      state: 'completed',
      certificate: { key, activate: true },
    });
    const server = await boot(dataDir, { APP_KEY: b64(wrong) });
    expect(server.deps().secrets.state().status).toBe('key_invalid');
    await expectStaysUp(server);
    const ready = await readyz(server);
    expect(ready.status).toBe(503);
    expect(ready.checks.secrets).toBe('app_key_invalid');
    const everything = `${server.logs.text()}${server.stderr.text()}${ready.body}`;
    for (const form of [b64(key), b64(wrong), hexOf(wrong), hexOf(key)]) {
      expect(everything).not.toContain(form);
    }
  });

  it('an unreadable certificate row: certificate_unreadable, /readyz certificate_unreadable', async () => {
    const key = throwawayKey();
    const { dataDir } = await prepare({
      state: 'completed',
      certificate: { key, activate: true },
    });
    const database = openDatabase({ path: databasePathOf(dataDir) });
    database.sqlite
      .prepare("UPDATE certificate SET public_der = zeroblob(300) WHERE state = 'active'")
      .run();
    database.close();
    const server = await boot(dataDir, { APP_KEY: b64(key) });
    expect(server.deps().secrets.state().status).toBe('certificate_unreadable');
    await expectStaysUp(server);
    const ready = await readyz(server);
    expect(ready.status).toBe(503);
    expect(ready.checks.secrets).toBe('certificate_unreadable');
  });

  it('state completed and a valid key but no certificate at all: no_certificate fails readiness', async () => {
    const { dataDir } = await prepare({ state: 'completed' });
    const server = await boot(dataDir, { APP_KEY: b64(throwawayKey()) });
    expect(server.deps().secrets.state().status).toBe('no_certificate');
    const ready = await readyz(server);
    expect(ready.status).toBe(503);
    expect(ready.checks.secrets).toBe('certificate_unreadable');
  });
});

describe('before setup has completed', () => {
  it('no key and no certificate: /readyz stays 200, the state says key_missing for the wizard', async () => {
    const { dataDir } = await prepare({ state: 'unconfigured' });
    const server = await boot(dataDir);
    expect(server.deps().secrets.state().status).toBe('key_missing');
    const ready = await readyz(server);
    expect(ready.status).toBe(200);
    expect(ready.checks.secrets).toBe('ok');
    await expectStaysUp(server);
  });

  it('a key and no certificate: no_certificate, /readyz 200, the services are there for the wizard', async () => {
    const { dataDir } = await prepare({ state: 'unconfigured' });
    const server = await boot(dataDir, { APP_KEY: b64(throwawayKey()) });
    expect(server.deps().secrets.state().status).toBe('no_certificate');
    expect(server.deps().secrets.services()?.selfTest()).toBe(true);
    expect((await readyz(server)).status).toBe(200);
  });

  it('a certificate exists (pending) and the key is missing: readiness fails even though setup is not completed', async () => {
    const key = throwawayKey();
    const { dataDir } = await prepare({
      state: 'unconfigured',
      certificate: { key, activate: false },
    });
    const server = await boot(dataDir);
    expect(server.deps().secrets.state().status).toBe('key_missing');
    const ready = await readyz(server);
    expect(ready.status).toBe(503);
    expect(ready.checks.secrets).toBe('app_key_missing');
  });

  it('a pending certificate gives a holder, so the wizard can verify with it', async () => {
    const key = throwawayKey();
    const { dataDir } = await prepare({
      state: 'unconfigured',
      certificate: { key, activate: false },
    });
    const server = await boot(dataDir, { APP_KEY: b64(key) });
    expect(server.deps().secrets.state().status).toBe('ok');
    expect(server.deps().secrets.state().holder).toBeDefined();
  });

  it('creating and activating a certificate while running refreshes the state and the holder', async () => {
    const key = throwawayKey();
    const { dataDir } = await prepare({ state: 'unconfigured' });
    const server = await boot(dataDir, { APP_KEY: b64(key) });
    const deps = server.deps();
    expect(deps.secrets.state().status).toBe('no_certificate');
    const services = deps.secrets.services();
    if (services === undefined) throw new Error('no services');
    const database = deps.requireDatabase();
    const created = await services.certificates.create(database, { kind: 'setup', id: 'setup' });
    expect(deps.secrets.state().status).toBe('ok');
    expect(deps.secrets.state().holder?.publicCertificateDer().length).toBeGreaterThan(300);
    services.certificates.activate(database, created.id);
    expect(deps.secrets.state().status).toBe('ok');
  });
});

describe('the previous key (FR-B-109)', () => {
  it('opens a certificate still sealed under it and logs app_key_previous_in_use once, with key ids only', async () => {
    const oldKey = throwawayKey();
    const newKey = throwawayKey();
    const { dataDir } = await prepare({
      state: 'completed',
      certificate: { key: oldKey, activate: true },
    });
    const server = await boot(dataDir, { APP_KEY: b64(newKey), APP_KEY_PREVIOUS: b64(oldKey) });
    expect(server.deps().secrets.state().status).toBe('ok');
    const warnings = server.logs.lines().filter((line) => line.event === 'app_key_previous_in_use');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe('warn');
    expect(JSON.stringify(warnings[0])).toMatch(/[0-9a-f]{16}/);
    const everything = `${server.logs.text()}${server.stderr.text()}`;
    for (const form of [b64(oldKey), b64(newKey), hexOf(oldKey), hexOf(newKey)]) {
      expect(everything).not.toContain(form);
    }
  });

  it('without the previous key the same data directory is key_invalid', async () => {
    const oldKey = throwawayKey();
    const { dataDir } = await prepare({
      state: 'completed',
      certificate: { key: oldKey, activate: true },
    });
    const server = await boot(dataDir, { APP_KEY: b64(throwawayKey()) });
    expect(server.deps().secrets.state().status).toBe('key_invalid');
    expect(server.logs.lines().some((line) => line.event === 'app_key_previous_in_use')).toBe(
      false,
    );
  });
});

describe('shutdown', () => {
  it('drops the state and the key: the holder is not reachable afterwards', async () => {
    const key = throwawayKey();
    const { dataDir } = await prepare({
      state: 'completed',
      certificate: { key, activate: true },
    });
    const server = await boot(dataDir, { APP_KEY: b64(key) });
    const deps = server.deps();
    expect(deps.secrets.state().status).toBe('ok');
    await server.stop();
    expect(deps.secrets.state().status).toBe('key_missing');
    expect(deps.secrets.services()).toBeUndefined();
  });
});
