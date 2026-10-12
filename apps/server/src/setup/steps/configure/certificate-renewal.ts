// Certificate renewal (T-B-142, FR-B-220, EB-13; plan 9.11). A repair run renews the certificate when the
// active one is within the warning window (60 days or fewer) or has expired, in this order:
//
//   1. reuse the `pending` certificate or create one (at most one active and one pending exist);
//   2. `PATCH` the complete existing key-credential list plus the new credential (nothing is dropped);
//   3. read the application back and compare the SHA-1 (`ensureUploaded`);
//   4. acquire an app-only token with the NEW certificate on a client of its own: this proves possession
//      and that the credential has propagated (a refusal inside the propagation window is replication,
//      the runner waits and runs the sub-action again from the top, which resumes at step 4);
//   5. only then, in one transaction, retire the old certificate, activate the new one and point
//      `tenant_connection.certificate_id` at it (the clients reload with the secrets state);
//   6. `PATCH` the list without credentials that have expired or belong to a retired certificate;
//      credentials that are not ours stay.
//
// A failure before step 5 leaves the old certificate active and the new one pending for the next attempt.
// A certificate that has lapsed cannot be renewed by the panel on its own (it cannot get a token): the
// administrator's sign-in of the repair run is what makes this possible at all. `addKey` self-rotation is
// Phase D (ODB-08). Deleting the retired certificate and its sealed secret is left to the secrets
// module's retention (the row is `retired` and its secret carries `retired_at`).
import { createHash } from 'node:crypto';
import { certificateExpiry } from '../../../connection/cert-expiry.js';
import { SetupFailure, type SubActionContext, type SubActionOutcome } from '../../context.js';
import type { ApplicationPatch, TenantProvisioner } from '../../../ports/provisioner.js';
import { certificateServicesOf, ensureUploaded } from './certificate.js';
import { provisionerOf, recordChange } from './common.js';

/** Does this run have to renew? Only a repair run does, and only for a certificate that needs it. */
export function renewalNeeded(ctx: SubActionContext): boolean {
  if (ctx.run.kind !== 'repair') return false;
  const current = certificateServicesOf(ctx).certificates.current(ctx.db);
  if (current.active === undefined) return false;
  return certificateExpiry(current.active.notAfter, ctx.now()).level !== 'ok';
}

const sha1Hex = (der: string): string =>
  createHash('sha1').update(Buffer.from(der, 'base64')).digest('hex');

async function dropRetired(
  ctx: SubActionContext,
  provisioner: TenantProvisioner,
  objectId: string,
): Promise<number> {
  const retired = new Set(
    (
      ctx.db.sqlite
        .prepare("SELECT thumbprint_sha1 FROM certificate WHERE state = 'retired'")
        .pluck()
        .all() as string[]
    ).map((thumbprint) => thumbprint.toLowerCase()),
  );
  const existing = await provisioner.readKeyCredentials(objectId);
  ctx.checkpoint();
  const now = ctx.now();
  const keep = existing.filter((entry) => {
    if (entry.key === null) throw new SetupFailure('graph_error');
    const ended = entry.endDateTime !== null && Date.parse(entry.endDateTime) <= now;
    return !ended && !retired.has(sha1Hex(entry.key));
  });
  if (keep.length === existing.length) return 0;
  const patch = {
    keyCredentials: keep.map((entry) => ({
      type: entry.type,
      usage: entry.usage,
      key: entry.key,
      displayName: entry.displayName,
      startDateTime: entry.startDateTime,
      endDateTime: entry.endDateTime,
    })),
  } as unknown as ApplicationPatch;
  await provisioner.patchApplication(objectId, patch);
  return existing.length - keep.length;
}

export async function renewCertificate(
  ctx: SubActionContext,
  objectId: string,
): Promise<SubActionOutcome> {
  const { services, run } = ctx;
  const provisioner = provisionerOf(ctx);
  const secrets = certificateServicesOf(ctx);

  // 1. The new certificate: the pending one of an attempt that did not finish, else a fresh one.
  let { active, pending } = secrets.certificates.current(ctx.db);
  if (active === undefined) throw new SetupFailure('token_unavailable');
  if (pending === undefined) {
    pending = await secrets.certificates.create(ctx.db, run.actor);
    ctx.log('setup.log.certificate_generated', { thumbprint8: pending.thumbprintSha1.slice(0, 8) });
  }
  ctx.checkpoint();
  const thumbprint8 = pending.thumbprintSha1.slice(0, 8).toLowerCase();

  // 2 and 3. Upload next to the old credential, read back.
  await ensureUploaded(ctx, provisioner, objectId, pending);

  // 4. Possession: a token with the new certificate, on a client that holds only that certificate.
  const connection = services.connections.read(ctx.db);
  if (connection?.tenantId == null || connection.appId == null)
    throw new SetupFailure('token_unavailable');
  const holder = secrets.certificates.loadHolder(ctx.db, 'pending');
  if (holder === undefined) throw new SetupFailure('token_unavailable');
  const probe = services.deps.clients.probe({
    tenantId: connection.tenantId,
    clientId: connection.appId,
    holder,
  });
  try {
    await probe.appTokens.get('graph', { skipCache: true });
  } finally {
    probe.close();
  }
  ctx.checkpoint();

  // 5. The switch, in one transaction inside the certificate service; the tenant connection follows.
  active = secrets.certificates.activate(ctx.db, pending.id);
  recordChange(ctx, {
    kind: 'application',
    tenantObjectId: objectId,
    name: 'certificate',
    origin: 'created',
    op: 'update',
    tenantFields: { certificateId: active.id },
    hintKey: 'setup.hint.certificate',
    hintDetail: { thumbprint8, objectId },
    log: { key: 'setup.log.certificate_uploaded', params: {} },
  });

  // 6. The credentials that are over.
  const dropped = await dropRetired(ctx, provisioner, objectId);
  return {
    status: 'succeeded',
    detail: { thumbprint8, objectId, count: dropped },
    hintKey: 'setup.hint.certificate',
    drift: ['certificate'],
  };
}
