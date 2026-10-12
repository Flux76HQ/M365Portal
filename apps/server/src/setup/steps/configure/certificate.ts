// Sub-action `certificate` (T-B-134, FR-B-306, FR-B-107 request half, EB-10; plan 9.5, 9.11).
//
//   1. The certificate is generated and sealed FIRST (state `pending`): the private key is created in
//      memory, sealed under `APP_KEY` in the same transaction as the certificate row, and wiped.
//   2. The application's key credentials are read (`GET /applications/{id}?$select=keyCredentials`),
//      the only read that returns `key`. If our certificate is already there (its SHA-1 is among the
//      thumbprints), nothing is written.
//   3. Otherwise `PATCH /applications/{id}` carries the COMPLETE intended list: PATCH replaces the
//      collection, so every existing entry is re-sent exactly as read (including `key`) plus ours:
//      `{type: AsymmetricX509Cert, usage: Verify, key, displayName, startDateTime, endDateTime}` with
//      at most 360 days of validity and NO `customKeyIdentifier` (Entra derives the SHA-1). An entry
//      that came back without `key` stops the step with `graph_error` rather than risk dropping it
//      (whether re-sending preserves it is U47). `addKey` is not used.
//   4. The application is read again: the SHA-1 thumbprint of our certificate must be among the key
//      credentials (case-insensitive), else `thumbprint_mismatch`.
//   5. Only then the certificate becomes `active`, and `tenant_connection.certificate_id` points at it.
//
// A 400 on the PATCH of an application that was read a moment earlier is not replication; it may be an
// app-management policy that refuses the credential's lifetime (EB-10, U19): the step ends
// `policy_refused` with only the allow-listed Graph error code. Only the public certificate leaves the
// process; the private key is never in a request, a log line or an audit entry.
import { buildKeyCredentialEntry } from '@m365portal/shared/setup/desired-state';
import { GraphBadRequestError } from '../../../ports/errors.js';
import type { ApplicationPatch } from '../../../ports/provisioner.js';
import { SetupFailure, type SubActionContext, type SubActionDefinition } from '../../context.js';
import { ensureResolved, provisionerOf, recordChange } from './common.js';

type CertificateServices = NonNullable<ReturnType<SubActionContext['services']['deps']['secrets']['services']>>;

function secretsOf(ctx: SubActionContext): CertificateServices {
  const { secrets } = ctx.services.deps;
  const services = secrets.services();
  if (services === undefined) {
    throw new SetupFailure(secrets.state().status === 'key_invalid' ? 'app_key_invalid' : 'app_key_missing');
  }
  return services;
}

export const certificateSubAction: SubActionDefinition = {
  step: 'configure',
  key: 'certificate',

  async run(ctx) {
    const { services, run } = ctx;
    const provisioner = provisionerOf(ctx);
    const secrets = secretsOf(ctx);
    await ensureResolved(ctx);
    const objectId = services.connections.read(ctx.db)?.appObjectId;
    if (objectId === null || objectId === undefined) throw new SetupFailure('graph_error');

    // 1. Generate and seal first.
    let current = secrets.certificates.current(ctx.db);
    let certificate = current.active ?? current.pending;
    if (certificate === undefined) {
      certificate = await secrets.certificates.create(ctx.db, run.actor);
      ctx.log('setup.log.certificate_generated', { thumbprint8: certificate.thumbprintSha1.slice(0, 8) });
    }
    ctx.checkpoint();
    const thumbprint = certificate.thumbprintSha1.toUpperCase();
    const thumbprint8 = certificate.thumbprintSha1.slice(0, 8).toLowerCase();

    // 2. What the application holds now.
    ctx.log('setup.log.read', { what: 'key_credentials' });
    const present = async (): Promise<boolean> => {
      const inventory = await provisioner.inspectApplication(objectId);
      return (inventory.keyCredentials ?? []).some(
        (credential) => credential.thumbprintSha1?.toUpperCase() === thumbprint,
      );
    };

    let changed = false;
    if (!(await present())) {
      changed = true;
      const existing = await provisioner.readKeyCredentials(objectId);
      ctx.checkpoint();
      const list = existing.map((entry) => {
        if (entry.key === null) throw new SetupFailure('graph_error');
        return {
          type: entry.type,
          usage: entry.usage,
          key: entry.key,
          displayName: entry.displayName,
          startDateTime: entry.startDateTime,
          endDateTime: entry.endDateTime,
        };
      });
      const ours = buildKeyCredentialEntry({
        certificateBase64: Buffer.from(
          ctx.db.sqlite.prepare('SELECT public_der FROM certificate WHERE id = ?').pluck().get(certificate.id) as Buffer,
        ).toString('base64'),
        thumbprintSha1: certificate.thumbprintSha1,
        notBefore: new Date(certificate.notBefore),
        notAfter: new Date(certificate.notAfter),
      });
      // Existing entries are re-sent as they came; the type allows only what Graph returned for them.
      const patch = { keyCredentials: [...list, ours] } as unknown as ApplicationPatch;
      try {
        await provisioner.patchApplication(objectId, patch);
      } catch (failure) {
        if (failure instanceof GraphBadRequestError) {
          throw new SetupFailure('policy_refused', failure.graphCode === undefined ? {} : { graphErrorCode: failure.graphCode });
        }
        throw failure;
      }
      run.markCertificateUploaded(ctx.now());
      ctx.log('setup.log.certificate_uploaded');
      ctx.checkpoint();
      // 4. Read it back.
      if (!(await present())) {
        throw new SetupFailure('thumbprint_mismatch', { thumbprint8 });
      }
    }

    // 5. The certificate becomes active only after the read-back.
    if (certificate.state === 'pending') {
      certificate = secrets.certificates.activate(ctx.db, certificate.id);
      changed = true;
    }
    current = secrets.certificates.current(ctx.db);
    const activeId = current.active?.id ?? certificate.id;
    // Only a change is recorded and audited (FR-B-208): a run over a finished tenant writes nothing.
    if (changed || services.connections.read(ctx.db)?.certificateId !== activeId) {
      recordChange(ctx, {
        kind: 'application',
        tenantObjectId: objectId,
        name: 'certificate',
        origin: 'created',
        op: 'update',
        tenantFields: { certificateId: activeId },
        hintKey: 'setup.hint.certificate',
        hintDetail: { thumbprint8, objectId },
      });
    }
    return {
      status: 'succeeded',
      detail: { thumbprint8, objectId },
      hintKey: 'setup.hint.certificate',
    };
  },
};

