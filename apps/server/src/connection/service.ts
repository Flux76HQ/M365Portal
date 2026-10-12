// The connection service (T-B-139, T-B-142; contract P19 and P26): the connection page's data and the
// app-only verification of Settings. The runs themselves are the engine's; this file only reads and
// re-checks.
//
// `verifyConnection` re-runs V1, V2 (a comparison: it never changes the pinned tenant), V3 and V5 with
// a fresh client each (so a fresh token each), one after the other, in a budget of 60 seconds and
// without a waiting loop: a failed check is a result, a Graph wait too long for the budget is
// 503 `graph_throttled`. It replaces the app-only items of the stored proof and keeps the delegated
// ones (V4, V6, the object checks) as they were.
import type { ResultCode } from '@m365portal/shared/setup/result-codes';
import { appendAudit } from '../audit/index.js';
import { withTransaction } from '../db/index.js';
import { ProblemError } from '../http/problem.js';
import {
  GraphThrottledError,
  IntegrationError,
  NotConnectedError,
  SecretsUnavailableError,
} from '../ports/errors.js';
import type { SetupRuntime } from '../setup/runtime.js';
import {
  checkExchange,
  checkOrganization,
  checkToken,
  checkUsers,
  openProbe,
  type CheckResult,
} from '../setup/steps/verify-checks.js';
import {
  mergeProof,
  proofItem,
  readProof,
  writeProof,
  type Proof,
  type ProofItem,
  type ProofKey,
} from '../setup/proof.js';
import type { RunActor } from '../setup/run-context.js';
import { connectionView, type ConnectionView } from '../setup/view.js';

export const VERIFY_BUDGET_MS = 60_000;

export function connectionSnapshot(runtime: SetupRuntime): ConnectionView {
  return connectionView(runtime.services, runtime.engine.busy());
}

interface Check {
  readonly key: ProofKey;
  readonly failCode: ResultCode;
  readonly run: (probe: ReturnType<typeof openProbe>) => Promise<CheckResult>;
}

export async function verifyConnection(
  runtime: SetupRuntime,
  actor: RunActor,
  audit: { readonly requestId: string; readonly clientIp?: string | undefined },
): Promise<Proof> {
  const { services, engine, deps } = runtime;
  const db = deps.requireDatabase();
  if (engine.busy()) throw new ProblemError('setup_step_busy');

  const connection = services.connections.read(db);
  if (connection?.tenantId == null || connection.appId == null)
    throw new ProblemError('setup_step_not_ready');
  const secrets = deps.secrets.services();
  if (secrets === undefined) throw new ProblemError('secrets_unavailable');
  if (secrets.certificates.current(db).active === undefined)
    throw new ProblemError('setup_step_not_ready');

  const checks: readonly Check[] = [
    { key: 'check_v1', failCode: 'token_unavailable', run: (probe) => checkToken(services, probe) },
    {
      key: 'check_v2',
      failCode: 'graph_error',
      run: (probe) => checkOrganization(services, probe, { pin: false }),
    },
    { key: 'check_v3', failCode: 'graph_error', run: (probe) => checkUsers(services, probe) },
    { key: 'check_v5', failCode: 'graph_error', run: (probe) => checkExchange(services, probe) },
  ];

  const startedAt = deps.now();
  const items: ProofItem[] = [];
  const codes: string[] = [];
  for (const check of checks) {
    if (deps.now() - startedAt >= VERIFY_BUDGET_MS) {
      items.push(proofItem(check.key, 'not_checked', new Date(deps.now()).toISOString()));
      continue;
    }
    let probe;
    try {
      probe = openProbe(services);
    } catch {
      items.push(
        proofItem(check.key, 'failed', new Date(deps.now()).toISOString(), {
          code: check.failCode,
        }),
      );
      codes.push(check.failCode);
      continue;
    }
    try {
      const result = await check.run(probe);
      items.push(...result.items);
      if (result.status === 'failed' && result.code !== undefined) codes.push(result.code);
    } catch (error) {
      if (error instanceof SecretsUnavailableError) throw new ProblemError('secrets_unavailable');
      if (
        error instanceof GraphThrottledError &&
        (error.retryAfterMs ?? 0) > VERIFY_BUDGET_MS - (deps.now() - startedAt)
      ) {
        throw new ProblemError('graph_throttled');
      }
      if (!(error instanceof IntegrationError) && !(error instanceof NotConnectedError))
        throw error;
      items.push(
        proofItem(check.key, 'failed', new Date(deps.now()).toISOString(), {
          code: check.failCode,
        }),
      );
      codes.push(check.failCode);
    } finally {
      probe.close();
    }
  }

  const failed = items.some((item) => item.status === 'failed');
  const nowIso = new Date(deps.now()).toISOString();
  return withTransaction(db, (tx) => {
    const merged = mergeProof(readProof(services.connections, tx), items, {
      generatedAt: nowIso,
      mode: services.state.read(tx).mode,
    });
    writeProof(services.connections, tx, merged);
    if (!failed) services.connections.update(tx, { verifiedAt: nowIso });
    // The action names the actor kinds it accepts: during the wizard (actor `setup`) the verification
    // is shown in the proof and the step rows, and writes no `connection.verify` entry.
    if (actor.kind === 'user') {
      appendAudit(tx, {
        ts: nowIso,
        actorKind: 'user',
        actorId: actor.id,
        action: 'connection.verify',
        targetType: 'connection',
        outcome: failed ? 'error' : 'success',
        requestId: audit.requestId,
        ...(audit.clientIp === undefined ? {} : { clientIp: audit.clientIp }),
        detail: {
          checks: items.map((item) => `${item.key}:${item.status}`).slice(0, 16),
          codes: [...new Set(codes)].slice(0, 16),
        },
      });
    }
    return merged;
  });
}
