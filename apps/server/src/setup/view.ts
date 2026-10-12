// The views of the wizard (P13) and of the connection page (P19) as one function each, built from the
// repositories and nothing else: no secret and no Microsoft free text reaches them (every label is
// clipped, every status comes from a registry). The two share the pieces below.
import type { ConnectionResponseSchema } from '@m365portal/shared/schemas/connection';
import type { SetupStateResponseSchema } from '@m365portal/shared/schemas/setup';
import type { z } from 'zod';
import type { DatabaseHandle } from '../db/index.js';
import { certificateExpiry } from '../connection/cert-expiry.js';
import type { SetupServices } from './context.js';
import { ownerLabelsOf } from './owner-labels.js';
import { readProof } from './proof.js';

export type SetupStateView = z.infer<typeof SetupStateResponseSchema>;
export type ConnectionView = z.infer<typeof ConnectionResponseSchema>;

const DEFAULT_APPLICATION_NAME = 'M365Portal';

/** The states of the secrets runtime as the contract names them (P19). */
const SECRETS_WIRE = {
  ok: 'ok',
  key_missing: 'app_key_missing',
  key_invalid: 'app_key_invalid',
  certificate_unreadable: 'certificate_unreadable',
  no_certificate: 'no_certificate',
} as const;

export function applicationOf(
  services: SetupServices,
  db: DatabaseHandle,
): { appId: string; objectId: string | null; displayName: string } | null {
  const connection = services.connections.read(db);
  if (connection?.appId == null) return null;
  const named = db.sqlite
    .prepare("SELECT name FROM setup_object WHERE kind = 'application' ORDER BY created_at LIMIT 1")
    .pluck()
    .get() as string | undefined;
  return {
    appId: connection.appId,
    objectId: connection.appObjectId,
    displayName: named ?? DEFAULT_APPLICATION_NAME,
  };
}

function certificatesOf(services: SetupServices, db: DatabaseHandle) {
  const current = services.deps.secrets.services()?.certificates.current(db);
  return { active: current?.active, pending: current?.pending };
}

export async function setupStateView(
  services: SetupServices,
  session: { readonly idleExpiresAt: string; readonly absoluteExpiresAt: string },
): Promise<SetupStateView> {
  const db = services.deps.requireDatabase();
  const state = services.state.read(db);
  const connection = services.connections.read(db);
  const certificate = certificatesOf(services, db);
  const shown = certificate.pending ?? certificate.active;
  const owner = state.designatedOwnerOid;
  return {
    state: state.state,
    mode: state.mode,
    defaultLanguage: state.defaultLanguage === 'nl' || state.defaultLanguage === 'en' ? state.defaultLanguage : null,
    steps: services.steps.stepStates(db, state.mode),
    tenant: {
      proposedTenantId: state.proposedTenantId,
      tenantId: connection?.tenantId ?? null,
      name: connection?.tenantName ?? null,
      initialDomain: connection?.initialDomain ?? null,
    },
    application: applicationOf(services, db),
    certificate:
      shown === undefined
        ? null
        : {
            thumbprintSha1: shown.thumbprintSha1,
            notAfter: shown.notAfter,
            state: shown === certificate.pending ? 'pending' : 'active',
          },
    designatedOwner: owner === null ? null : { oid: owner, ...(await ownerLabelsOf(services, owner)) },
    exchangeEnabled: connection?.exchangeEnabled ?? false,
    proof: readProof(services.connections, db),
    publicBaseUrl: services.deps.config.publicOrigin,
    session,
  };
}

export function connectionView(services: SetupServices, runActive: boolean): ConnectionView {
  const db = services.deps.requireDatabase();
  const state = services.state.read(db);
  const connection = services.connections.read(db);
  const certificate = certificatesOf(services, db);
  const secrets = services.deps.secrets.state();
  const now = services.deps.now();
  return {
    state: state.state,
    mode: state.mode,
    tenant:
      connection?.tenantId == null
        ? null
        : {
            tenantId: connection.tenantId,
            name: connection.tenantName,
            initialDomain: connection.initialDomain,
          },
    application: applicationOf(services, db),
    certificate:
      certificate.active === undefined
        ? null
        : {
            thumbprintSha1: certificate.active.thumbprintSha1,
            notAfter: certificate.active.notAfter,
            ...certificateExpiry(certificate.active.notAfter, now),
          },
    pendingCertificate:
      certificate.pending === undefined
        ? null
        : { thumbprintSha1: certificate.pending.thumbprintSha1, notAfter: certificate.pending.notAfter },
    exchange: { enabled: connection?.exchangeEnabled ?? false },
    permissionSetVersion: connection?.permissionSetVersion ?? 1,
    redirectUris: [...(connection?.redirectUris ?? [])],
    secrets: { status: SECRETS_WIRE[secrets.status] },
    proof: readProof(services.connections, db),
    verifiedAt: connection?.verifiedAt ?? null,
    runActive,
  };
}
