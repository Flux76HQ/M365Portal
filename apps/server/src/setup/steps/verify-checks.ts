// The app-only checks of verification (T-B-136, FR-B-309, FR-B-316, EB-09; plan 9.8) as functions that
// the sub-actions of step 4 and `POST /api/v1/connection/verify` both call, so there is one
// implementation:
//
//   V1 a Graph token is obtained with the certificate        (fresh token, `skipCache`)
//   V2 `GET /organization`: one item whose id is the tenant   (pins it the first time)
//   V3 `GET /users?$top=1&$select=id`                          (fresh token inside the client)
//   V5 the Exchange Admin API probe                            (a warning, never a failure)
//
// Every check builds its own client (`ClientsRegistry.probe`), so no token of an earlier attempt can
// answer for it, and closes it. Nothing here decodes a token (FR-B-316): a token is passed to the HTTP
// layer and nowhere else. Errors of the integrations are not caught here: the runner classifies them
// (replication, transient, permanent) and runs the check again; only the verdicts of a successful call
// are returned.
import type { ResultCode } from '@m365portal/shared/setup/result-codes';
import type { ProbeClients } from '../../integrations/registry.js';
import { SetupFailure, type SetupServices } from '../context.js';
import { proofItem, type ProofItem } from '../proof.js';
import type { StepDetail } from '../step-repository.js';
import { confirmTenant } from '../tenant-pin.js';

export interface CheckResult {
  readonly status: 'ok' | 'warning' | 'failed' | 'skipped';
  readonly code?: ResultCode;
  readonly items: readonly ProofItem[];
  readonly detail?: StepDetail;
}

/** Clients for the tenant this install is connecting, built over the certificate that is usable now. */
export function openProbe(services: SetupServices): ProbeClients {
  const { deps } = services;
  const db = deps.requireDatabase();
  const connection = services.connections.read(db);
  const state = services.state.read(db);
  const tenantId = connection?.tenantId ?? state.proposedTenantId;
  const clientId = connection?.appId;
  const secrets = deps.secrets.state();
  if (tenantId === null || tenantId === undefined || clientId === null || clientId === undefined) {
    throw new SetupFailure('token_unavailable');
  }
  if (secrets.status !== 'ok' || secrets.holder === undefined) {
    throw new SetupFailure('token_unavailable');
  }
  return deps.clients.probe({ tenantId, clientId, holder: secrets.holder });
}

const at = (services: SetupServices): string => new Date(services.deps.now()).toISOString();

/** V1. Also the proof of possession of the certificate: an active certificate is read from here on. */
export async function checkToken(services: SetupServices, probe: ProbeClients): Promise<CheckResult> {
  await probe.appTokens.get('graph', { skipCache: true });
  const connection = services.connections.read(services.deps.requireDatabase());
  const certificate = services.deps.secrets
    .services()
    ?.certificates.current(services.deps.requireDatabase());
  const current = certificate?.active ?? certificate?.pending;
  return {
    status: 'ok',
    items: [
      proofItem('check_v1', 'ok', at(services)),
      ...(current === undefined
        ? []
        : [
            proofItem('certificate', 'ok', at(services), {
              thumbprint8: current.thumbprintSha1.slice(0, 8),
              notAfter: current.notAfter,
            }),
          ]),
    ],
    detail: connection?.appId === null || connection?.appId === undefined ? {} : { appId: connection.appId },
  };
}

/** V2. `pin` stores the tenant the first time (setup); a comparison never changes anything. */
export async function checkOrganization(
  services: SetupServices,
  probe: ProbeClients,
  options: { readonly pin: boolean },
): Promise<CheckResult> {
  const organization = await probe.graph.getOrganization();
  const outcome = confirmTenant(services, organization, options);
  if (outcome.kind === 'mismatch') {
    return {
      status: 'failed',
      code: outcome.reason,
      items: [proofItem('check_v2', 'failed', at(services), { code: outcome.reason })],
    };
  }
  return { status: 'ok', items: [proofItem('check_v2', 'ok', at(services))] };
}

/** V3. */
export async function checkUsers(services: SetupServices, probe: ProbeClients): Promise<CheckResult> {
  await probe.graph.probeUsers();
  return { status: 'ok', items: [proofItem('check_v3', 'ok', at(services))] };
}

/** V5: Exchange. Never a failure (EB-09): the Admin API is "not available in all organizations". */
export async function checkExchange(services: SetupServices, probe: ProbeClients): Promise<CheckResult> {
  const connection = services.connections.read(services.deps.requireDatabase());
  if (connection?.exchangeEnabled !== true) {
    return {
      status: 'skipped',
      code: 'exchange_service_principal_missing',
      items: [proofItem('check_v5', 'not_checked', at(services))],
      detail: { exchangeEnabled: false },
    };
  }
  const result = await probe.exchange.probe({ skipCache: true });
  if (result.status === 'ok') {
    return { status: 'ok', items: [proofItem('check_v5', 'ok', at(services))] };
  }
  const code: ResultCode = result.status === 'not_ready' ? 'exchange_not_ready' : 'exchange_unavailable';
  return {
    status: 'warning',
    code,
    items: [proofItem('check_v5', 'warning', at(services), { code })],
  };
}
