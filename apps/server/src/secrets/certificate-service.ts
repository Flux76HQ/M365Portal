// The certificate service (FR-B-106, FR-B-107, plan 7.3): creates the self-signed certificate, keeps
// the sealed private key and the public certificate in two rows, and builds the holder from them.
//
// `create` generates first (asynchronously, outside any transaction: an RSA key takes a moment and a
// transaction must not wait on it), then does ONE transaction: the `secret` row (the sealed PKCS#8),
// the `certificate` row in state `pending`, and the audit entry `secrets.certificate.create`. A fault
// anywhere in that transaction rolls all three back. The PKCS#8 buffer is zeroed by the sealing, and
// again in `finally`.
//
// `activate` makes the pending certificate the active one and retires the previous active one
// (data-model I-B6: at most one of each). The setup engine and the repair flow call it; they audit
// the tenant side themselves (`setup.object.change`).
//
// Nothing here logs, and no error carries key material.
import type { AuditActorKind } from '../audit/index.js';
import { appendAudit } from '../audit/index.js';
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import type { Clock, RandomSource } from '../ports/clock.js';
import { CertificateHolder, createCertificateHolder } from './certificate-holder.js';
import { CertificateKeyMismatchError } from './certificate-holder.js';
import type { CertificateFactory } from './certificate-factory.js';
import { randomGuid } from './guid.js';
import { wipe } from './sealed-box.js';
import type { SecretStore } from './secret-store.js';

export type CertificateState = 'pending' | 'active' | 'retired';

export interface CertificateSummary {
  readonly id: string;
  readonly secretId: string;
  readonly thumbprintSha1: string;
  readonly thumbprintSha256: string;
  readonly subject: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly state: CertificateState;
  readonly createdAt: string;
}

/** Who creates the certificate: the setup actor in the wizard, a signed-in user in repair. */
export interface CertificateActor {
  readonly kind: Extract<AuditActorKind, 'setup' | 'user'>;
  readonly id: string;
}

export class CertificatePendingError extends Error {
  readonly code = 'certificate_pending_exists';

  constructor() {
    super('a certificate is already pending');
    this.name = 'CertificatePendingError';
  }
}

export class CertificateStateError extends Error {
  readonly code = 'certificate_not_pending';

  constructor() {
    super('only a pending certificate can be activated');
    this.name = 'CertificateStateError';
  }
}

export class InstallIdMissingError extends Error {
  readonly code = 'install_id_missing';

  constructor() {
    super('the install id is missing: setup_state has no row');
    this.name = 'InstallIdMissingError';
  }
}

export interface CertificateServiceOptions {
  readonly store: SecretStore;
  readonly factory: CertificateFactory;
  readonly clock: Clock;
  readonly random: RandomSource;
  /** The audit writer; the test replaces it to inject a fault. */
  readonly appendAudit?: typeof appendAudit;
  /** Called after a certificate was created or activated: the secrets module refreshes its state. */
  readonly onChange?: () => void;
}

interface CertificateRow {
  readonly id: string;
  readonly secret_id: string;
  readonly thumbprint_sha1: string;
  readonly thumbprint_sha256: string;
  readonly subject: string;
  readonly not_before: string;
  readonly not_after: string;
  readonly public_der: Buffer;
  readonly state: CertificateState;
  readonly created_at: string;
}

const SELECT_COLUMNS =
  'id, secret_id, thumbprint_sha1, thumbprint_sha256, subject, not_before, not_after, public_der, state, created_at';

function summaryOf(row: CertificateRow): CertificateSummary {
  return {
    id: row.id,
    secretId: row.secret_id,
    thumbprintSha1: row.thumbprint_sha1,
    thumbprintSha256: row.thumbprint_sha256,
    subject: row.subject,
    notBefore: row.not_before,
    notAfter: row.not_after,
    state: row.state,
    createdAt: row.created_at,
  };
}

export class CertificateService {
  readonly #options: CertificateServiceOptions;

  constructor(options: CertificateServiceOptions) {
    this.#options = options;
  }

  #installId(db: DatabaseHandle): string {
    const row = db.sqlite.prepare('SELECT install_id FROM setup_state WHERE id = 1').get() as
      { install_id: string } | undefined;
    if (row === undefined) throw new InstallIdMissingError();
    return row.install_id;
  }

  #hasPending(db: DatabaseHandle): boolean {
    return (
      db.sqlite.prepare("SELECT 1 AS found FROM certificate WHERE state = 'pending'").get() !==
      undefined
    );
  }

  /** Generate a certificate and store it as `pending`. */
  async create(db: DatabaseHandle, actor: CertificateActor): Promise<CertificateSummary> {
    if (this.#hasPending(db)) throw new CertificatePendingError();
    const installId = this.#installId(db);
    const now = this.#options.clock.now();
    const generated = await this.#options.factory.generate({
      installId,
      now,
      random: this.#options.random,
    });
    try {
      const audit = this.#options.appendAudit ?? appendAudit;
      const createdAt = new Date(now).toISOString();
      const certificateId = randomGuid(this.#options.random);
      const summary = withTransaction(db, (tx) => {
        if (this.#hasPending(tx)) throw new CertificatePendingError();
        const secretId = this.#options.store.seal(tx, {
          purpose: 'certificate_key',
          plaintext: generated.pkcs8Der,
          createdAt,
        });
        tx.sqlite
          .prepare(
            'INSERT INTO certificate (id, secret_id, thumbprint_sha1, thumbprint_sha256, subject, not_before, not_after, public_der, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            certificateId,
            secretId,
            generated.thumbprintSha1,
            generated.thumbprintSha256,
            generated.subject,
            generated.notBefore,
            generated.notAfter,
            generated.publicDer,
            'pending',
            createdAt,
          );
        audit(tx, {
          ts: createdAt,
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'secrets.certificate.create',
          targetType: 'certificate',
          targetId: certificateId,
          outcome: 'success',
          detail: { thumbprintSha1: generated.thumbprintSha1, notAfter: generated.notAfter },
        });
        return {
          id: certificateId,
          secretId,
          thumbprintSha1: generated.thumbprintSha1,
          thumbprintSha256: generated.thumbprintSha256,
          subject: generated.subject,
          notBefore: generated.notBefore,
          notAfter: generated.notAfter,
          state: 'pending' as const,
          createdAt,
        };
      });
      this.#options.onChange?.();
      return summary;
    } finally {
      generated.pkcs8Der.fill(0);
    }
  }

  /** Pending becomes active; the previous active certificate is retired. */
  activate(db: DatabaseHandle, id: string): CertificateSummary {
    const now = new Date(this.#options.clock.now()).toISOString();
    const summary = withTransaction(db, (tx) => {
      const row = tx.sqlite
        .prepare(`SELECT ${SELECT_COLUMNS} FROM certificate WHERE id = ? AND state = 'pending'`)
        .get(id) as CertificateRow | undefined;
      if (row === undefined) throw new CertificateStateError();
      const previous = tx.sqlite
        .prepare("SELECT id, secret_id FROM certificate WHERE state = 'active'")
        .get() as { id: string; secret_id: string } | undefined;
      if (previous !== undefined) {
        tx.sqlite.prepare("UPDATE certificate SET state = 'retired' WHERE id = ?").run(previous.id);
        tx.sqlite
          .prepare('UPDATE secret SET retired_at = ? WHERE id = ?')
          .run(now, previous.secret_id);
      }
      tx.sqlite.prepare("UPDATE certificate SET state = 'active' WHERE id = ?").run(id);
      return summaryOf({ ...row, state: 'active' });
    });
    this.#options.onChange?.();
    return summary;
  }

  /** The active and the pending certificate, if any. */
  current(db: DatabaseHandle): {
    readonly active?: CertificateSummary;
    readonly pending?: CertificateSummary;
  } {
    const rows = db.sqlite
      .prepare(`SELECT ${SELECT_COLUMNS} FROM certificate WHERE state IN ('active', 'pending')`)
      .all() as CertificateRow[];
    const active = rows.find((row) => row.state === 'active');
    const pending = rows.find((row) => row.state === 'pending');
    return {
      ...(active === undefined ? {} : { active: summaryOf(active) }),
      ...(pending === undefined ? {} : { pending: summaryOf(pending) }),
    };
  }

  /** Is there a certificate that is not retired? Decides whether the key is required at all. */
  exists(db: DatabaseHandle): boolean {
    return (
      db.sqlite.prepare("SELECT 1 AS found FROM certificate WHERE state != 'retired'").get() !==
      undefined
    );
  }

  /**
   * The holder of the active certificate (`active`), of the pending one (`pending`), or of the
   * active one and else the pending one (`current`); `undefined` when there is none. Throws
   * `SecretDecryptError` when the key does not open the row, `SecretNotFoundError`,
   * `CertificateKeyMismatchError` for a row that does not hold a usable certificate.
   */
  loadHolder(
    db: DatabaseHandle,
    which: 'active' | 'pending' | 'current',
  ): CertificateHolder | undefined {
    const wanted = which === 'current' ? ['active', 'pending'] : [which];
    const row = wanted
      .map(
        (state) =>
          db.sqlite
            .prepare(`SELECT ${SELECT_COLUMNS} FROM certificate WHERE state = ?`)
            .get(state) as CertificateRow | undefined,
      )
      .find((candidate) => candidate !== undefined);
    if (row === undefined) return undefined;
    const opened = this.#options.store.open(db, row.secret_id);
    const pkcs8Der = Buffer.from(opened);
    wipe(opened);
    const holder = createCertificateHolder({
      pkcs8Der,
      publicDer: Buffer.from(row.public_der),
      notAfter: row.not_after,
    });
    if (holder.thumbprintSha1 !== row.thumbprint_sha1) throw new CertificateKeyMismatchError();
    return holder;
  }
}
