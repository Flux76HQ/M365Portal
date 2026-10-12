// T-B-018 (service half), FR-B-107, SC-B-011 part: creating a certificate writes the sealed key and
// the public certificate and the audit entry in ONE transaction, and nothing of the private key or
// of APP_KEY is ever in the data directory in clear, write-ahead log and backups included.
//
// The scanner is itself a guard: a data directory that contains a PEM body, the key or APP_KEY in
// any of the forms the scan knows fails it (negative fixtures at the end).
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectGuardFails } from '@m365portal/shared/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { appendAudit } from '../../src/audit/index.js';
import { takeBackup } from '../../src/db/backup.js';
import type { DatabaseHandle } from '../../src/db/index.js';
import {
  lazyCertificateFactory,
  type CertificateFactory,
} from '../../src/secrets/certificate-factory.js';
import {
  CertificatePendingError,
  CertificateService,
} from '../../src/secrets/certificate-service.js';
import { SecretStore, keyRingOf } from '../../src/secrets/secret-store.js';
import { initSealedBox } from '../../src/secrets/sealed-box.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { countingRandom, migratedDatabase, throwawayKey } from './support.js';

beforeAll(async () => {
  await initSealedBox();
});

const ACTOR = { kind: 'setup', id: 'setup' } as const;

interface Harness {
  readonly db: DatabaseHandle;
  readonly dataDir: string;
  readonly appKey: Uint8Array;
  readonly captured: Buffer[];
  readonly service: CertificateService;
  readonly changes: number[];
}

async function harness(
  options: {
    audit?: typeof appendAudit;
  } = {},
): Promise<Harness> {
  const { database, dataDir } = await migratedDatabase();
  const appKey = throwawayKey();
  const captured: Buffer[] = [];
  const factory: CertificateFactory = {
    async generate(request) {
      const result = await lazyCertificateFactory.generate(request);
      captured.push(Buffer.from(result.pkcs8Der));
      return result;
    },
  };
  const clock = createFakeClock();
  const random = countingRandom(11);
  const changes: number[] = [];
  const service = new CertificateService({
    store: new SecretStore({ keys: keyRingOf(appKey), random }),
    factory,
    clock: { now: () => clock.nowMs() },
    random,
    ...(options.audit === undefined ? {} : { appendAudit: options.audit }),
    onChange: () => changes.push(changes.length),
  });
  return { db: database, dataDir, appKey, captured, service, changes };
}

const count = (db: DatabaseHandle, table: 'secret' | 'certificate' | 'audit_log'): number =>
  (db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('CertificateService.create', () => {
  it('writes the sealed key, a pending certificate and the audit entry together', async () => {
    const { db, service, appKey, changes } = await harness();
    const created = await service.create(db, ACTOR);

    expect(created.state).toBe('pending');
    expect(created.thumbprintSha1).toMatch(/^[0-9a-f]{40}$/);
    expect(created.subject).toBe('CN=M365Portal 01234567');

    const secretRow = db.sqlite.prepare('SELECT * FROM secret').get() as {
      id: string;
      purpose: string;
      key_id: string;
      blob: Buffer;
      retired_at: string | null;
    };
    expect(secretRow.purpose).toBe('certificate_key');
    expect(secretRow.blob[0]).toBe(0x01);
    expect(secretRow.retired_at).toBeNull();
    expect(secretRow.key_id).toMatch(/^[0-9a-f]{16}$/);
    expect(secretRow.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const certificateRow = db.sqlite.prepare('SELECT * FROM certificate').get() as {
      secret_id: string;
      state: string;
      thumbprint_sha1: string;
      public_der: Buffer;
    };
    expect(certificateRow.secret_id).toBe(secretRow.id);
    expect(certificateRow.state).toBe('pending');
    expect(certificateRow.thumbprint_sha1).toBe(created.thumbprintSha1);

    const audit = db.sqlite
      .prepare(
        "SELECT actor_kind, actor_id, action, target_type, outcome, detail FROM audit_log WHERE action = 'secrets.certificate.create'",
      )
      .all() as {
      actor_kind: string;
      actor_id: string;
      target_type: string;
      outcome: string;
      detail: string;
    }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_kind: 'setup',
      actor_id: 'setup',
      target_type: 'certificate',
      outcome: 'success',
    });
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toEqual({
      thumbprintSha1: created.thumbprintSha1,
      notAfter: created.notAfter,
    });
    // The audit entry holds no key, no blob and no PEM.
    expect(audit[0]?.detail).not.toMatch(/PRIVATE|BEGIN/);
    expect(Buffer.from(secretRow.blob).includes(Buffer.from(appKey))).toBe(false);
    expect(changes).toHaveLength(1);
  });

  it('rolls everything back when the audit append fails between the two inserts and the end', async () => {
    const { db, service, changes } = await harness({
      audit: () => {
        throw new Error('injected fault');
      },
    });
    await expect(service.create(db, ACTOR)).rejects.toThrow('injected fault');
    expect(count(db, 'secret')).toBe(0);
    expect(count(db, 'certificate')).toBe(0);
    expect(count(db, 'audit_log')).toBe(0);
    expect(changes).toHaveLength(0);
  });

  it('refuses a second certificate while one is pending, and leaves no second secret behind', async () => {
    const { db, service } = await harness();
    await service.create(db, ACTOR);
    await expect(service.create(db, ACTOR)).rejects.toThrow(CertificatePendingError);
    expect(count(db, 'secret')).toBe(1);
    expect(count(db, 'certificate')).toBe(1);
  });

  it('refuses a missing setup_state row: the subject needs the install id', async () => {
    const { database } = await migratedDatabase({ setupState: false });
    const { service } = await harness();
    await expect(service.create(database, ACTOR)).rejects.toThrow(/install id/);
  });
});

describe('activation and the holder', () => {
  it('activates the pending certificate, retires the old active one and loads a working holder', async () => {
    const { db, service, changes } = await harness();
    const first = await service.create(db, ACTOR);
    service.activate(db, first.id);
    const second = await service.create(db, ACTOR);
    expect(service.current(db).pending?.id).toBe(second.id);
    service.activate(db, second.id);

    const states = db.sqlite
      .prepare('SELECT id, state FROM certificate ORDER BY created_at, rowid')
      .all();
    expect(states).toEqual([
      { id: first.id, state: 'retired' },
      { id: second.id, state: 'active' },
    ]);
    expect(changes.length).toBeGreaterThanOrEqual(4);

    const holder = service.loadHolder(db, 'active');
    expect(holder?.thumbprintSha1).toBe(second.thumbprintSha1);
    const jws = await holder?.signCompact({ alg: 'PS256' }, new TextEncoder().encode('{}'));
    expect(jws?.split('.')).toHaveLength(3);
  });

  it('refuses to activate a certificate that is not pending', async () => {
    const { db, service } = await harness();
    const first = await service.create(db, ACTOR);
    service.activate(db, first.id);
    expect(() => service.activate(db, first.id)).toThrow(/pending/);
    expect(() => service.activate(db, '99999999-9999-4999-8999-999999999999')).toThrow(/pending/);
  });

  it('loads the pending certificate when none is active yet, and nothing when there is none', async () => {
    const { db, service } = await harness();
    expect(service.loadHolder(db, 'current')).toBeUndefined();
    const created = await service.create(db, ACTOR);
    expect(service.loadHolder(db, 'active')).toBeUndefined();
    expect(service.loadHolder(db, 'current')?.thumbprintSha1).toBe(created.thumbprintSha1);
  });
});

// ---------------------------------------------------------------------------------------------
// The scan of the data directory
// ---------------------------------------------------------------------------------------------

/** Every file below `root`, backups and journal files included. */
function filesBelow(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...filesBelow(path));
    else out.push(path);
  }
  return out;
}

/** The forms in which a secret of 32 bytes or more could be written: raw window, hex, base64, url-safe base64. */
function forms(secret: Uint8Array): Buffer[] {
  const bytes = Buffer.from(secret);
  const window = bytes.subarray(8, 8 + 24);
  const out: Buffer[] = [window, Buffer.from(window.toString('hex'))];
  // Three base64 alignments of the window; the first and last characters depend on the neighbours.
  for (let offset = 0; offset < 3; offset += 1) {
    const slice = bytes.subarray(8 + offset, 8 + offset + 24);
    const text = slice.toString('base64').slice(2, -2);
    out.push(Buffer.from(text), Buffer.from(text.replaceAll('+', '-').replaceAll('/', '_')));
  }
  if (bytes.length <= 64) {
    out.push(Buffer.from(bytes.toString('hex')), Buffer.from(bytes.toString('base64')));
  }
  return out;
}

/** Throws when a file under `root` holds a PEM marker or one of the forms of a given secret. */
function assertNoPlaintext(root: string, secrets: readonly Uint8Array[]): void {
  const needles = secrets.flatMap(forms);
  for (const file of filesBelow(root)) {
    const content = readFileSync(file);
    if (content.includes('-----BEGIN')) throw new Error(`a PEM marker is in ${file}`);
    for (const [index, needle] of needles.entries()) {
      if (content.includes(needle)) throw new Error(`secret form ${String(index)} is in ${file}`);
    }
  }
}

describe('no plaintext on disk', () => {
  it('after create, activation, a backup and more writes, no file holds a PEM marker, the key or APP_KEY', async () => {
    const { db, dataDir, service, captured, appKey } = await harness();
    const first = await service.create(db, ACTOR);
    service.activate(db, first.id);
    await service.create(db, ACTOR);
    // A backup copy, as the migration wrapper and the rotation take them.
    await takeBackup(db.sqlite, { backupsDir: join(dataDir, 'backups'), from: 0, to: 1 });
    // The files that exist are the database, its -wal and -shm and the backup.
    const names = filesBelow(dataDir).map((path) => path.slice(dataDir.length + 1));
    expect(names.some((name) => name.endsWith('-wal'))).toBe(true);
    expect(names.some((name) => name.startsWith('backups/'))).toBe(true);

    expect(captured).toHaveLength(2);
    assertNoPlaintext(dataDir, [...captured, appKey]);
  });

  it('is a guard that fails for a data directory containing a PEM body (negative)', async () => {
    const { dataDir, captured, service, db, appKey } = await harness();
    await service.create(db, ACTOR);
    // The frame is assembled from parts so that no PEM-shaped text sits in this source file.
    const frame = (edge: 'BEGIN' | 'END'): string =>
      ['-----' + edge, 'PRIVATE', 'KEY-----'].join(' ');
    const body = (captured[0] ?? Buffer.alloc(0)).toString('base64');
    const pem = `${frame('BEGIN')}\n${body}\n${frame('END')}\n`;
    mkdirSync(join(dataDir, 'tmp'), { recursive: true });
    writeFileSync(join(dataDir, 'tmp', 'leftover.pem'), pem);
    expectGuardFails(() => {
      assertNoPlaintext(dataDir, [...captured, appKey]);
    }, undefined);
  });

  it('is a guard that fails for a file holding APP_KEY as hex or base64 (negative)', async () => {
    const { dataDir, appKey, captured } = await harness();
    writeFileSync(join(dataDir, 'notes.txt'), `key=${Buffer.from(appKey).toString('base64')}\n`);
    expectGuardFails(() => {
      assertNoPlaintext(dataDir, [appKey]);
    }, undefined);
    writeFileSync(join(dataDir, 'notes.txt'), `key=${Buffer.from(appKey).toString('hex')}\n`);
    expectGuardFails(() => {
      assertNoPlaintext(dataDir, [appKey, ...captured]);
    }, undefined);
  });
});
