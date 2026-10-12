// Step 1, the six environment checks (T-B-130, FR-B-213, EB-14, EB-31, plan 9.4): `public_base_url`,
// `data_dir`, `app_key`, `node_version`, `network` and `time_skew`, each `ok`, `warn` or `fail` with a
// registered result code and a remedy key. Any `fail` blocks step 2 (`connect` needs the environment
// step without `failed`). The result holds names, hosts and numbers; no key, no path, no token, and
// is returned only to the setup actor.
//
// The `NODE_USE_ENV_PROXY` hint is text of the catalogue remedy of `network_unreachable` (U41); nothing
// here reads a proxy variable.
import { parsePublicBaseUrl } from '@m365portal/shared/auth/redirect-uri';
import {
  resultRemedyKey,
  type EnvironmentCheckKey,
  type EnvironmentCheckStatus,
  type ResultCode,
} from '@m365portal/shared/setup/result-codes';
import { isSupportedNodeVersion } from '@m365portal/shared/setup/node-version';
import { withTransaction } from '../db/index.js';
import type { PingHost, PingResult } from '../integrations/registry.js';
import { createStorageProbe, type StorageProbe } from '../lifecycle/storage-probe.js';
import type { SecretsState } from '../ports/secrets.js';
import { auditStepRun, type AuditedStatus } from './audit.js';
import type { SetupServices } from './context.js';
import type { RunActor } from './run-context.js';
import type { StepStatus } from '@m365portal/shared/setup/steps';

/** At most this far apart (host clock and Entra `Date`): ok / warn. More fails. Our thresholds (U35). */
const SKEW_OK_MS = 60_000;
const SKEW_WARN_MS = 300_000;

export interface EnvironmentCheckResult {
  readonly key: EnvironmentCheckKey;
  readonly status: EnvironmentCheckStatus;
  readonly code: ResultCode | null;
  readonly remedyKey: string | null;
  readonly params: Record<string, string | number | boolean>;
}

export interface EnvironmentResult {
  readonly ranAt: string;
  readonly status: 'ok' | 'warning' | 'failed';
  readonly blocking: boolean;
  readonly checks: EnvironmentCheckResult[];
}

export interface EnvironmentOptions {
  readonly nodeVersion?: string;
  readonly storageProbe?: StorageProbe;
  readonly ping?: (host: PingHost) => Promise<PingResult>;
  /** The key state and the round trip; default: the secrets runtime of the module deps. */
  readonly appKey?: { readonly status: SecretsState['status']; readonly selfTest?: () => boolean };
  /** For the test of FR-B-103 only; default `config.publicOrigin`. */
  readonly publicOrigin?: string;
}

function entry(
  key: EnvironmentCheckKey,
  status: EnvironmentCheckStatus,
  code: ResultCode | null = null,
  params: EnvironmentCheckResult['params'] = {},
): EnvironmentCheckResult {
  return {
    key,
    status,
    code: status === 'ok' ? null : code,
    remedyKey: status === 'ok' || code === null ? null : resultRemedyKey(code),
    params,
  };
}

const ROW_STATUS: Readonly<Record<EnvironmentCheckStatus, StepStatus>> = {
  ok: 'succeeded',
  warn: 'warning',
  fail: 'failed',
};

export async function runEnvironmentChecks(
  services: SetupServices,
  actor: RunActor,
  options: EnvironmentOptions = {},
): Promise<EnvironmentResult> {
  const { deps } = services;
  const db = deps.requireDatabase();
  const checks: EnvironmentCheckResult[] = [];

  // 1. public_base_url (FR-B-103): the configuration was accepted at start; this says so again.
  checks.push(
    parsePublicBaseUrl(options.publicOrigin ?? deps.config.publicOrigin).ok
      ? entry('public_base_url', 'ok')
      : entry('public_base_url', 'fail', 'public_base_url_invalid'),
  );

  // 2. data_dir: a file can be written, and the database accepts a write transaction.
  const probe = options.storageProbe ?? createStorageProbe(deps.config.dataDir);
  let writable = probe();
  if (writable) {
    try {
      withTransaction(db, () => undefined);
    } catch {
      writable = false;
    }
  }
  checks.push(
    writable ? entry('data_dir', 'ok') : entry('data_dir', 'fail', 'data_dir_not_writable'),
  );

  // 3. app_key (FR-B-104): present, valid, and a seal and open round trip holds.
  const key = options.appKey ?? {
    status: deps.secrets.state().status,
    selfTest: () => deps.secrets.services()?.selfTest() ?? false,
  };
  if (key.status === 'key_missing') checks.push(entry('app_key', 'fail', 'app_key_missing'));
  else if (key.status === 'key_invalid') checks.push(entry('app_key', 'fail', 'app_key_invalid'));
  else {
    const roundTrip = key.selfTest?.() ?? false;
    checks.push(roundTrip ? entry('app_key', 'ok') : entry('app_key', 'fail', 'app_key_invalid'));
  }

  // 4. node_version
  checks.push(
    isSupportedNodeVersion(options.nodeVersion ?? process.versions.node)
      ? entry('node_version', 'ok')
      : entry('node_version', 'warn', 'node_version_unsupported'),
  );

  // 5. network and 6. time_skew: one request to each host.
  const ping = options.ping ?? ((host: PingHost) => deps.clients.ping(host));
  const [login, graph, exchange] = await Promise.all([
    ping('login.microsoftonline.com'),
    ping('graph.microsoft.com'),
    ping('outlook.office365.com'),
  ]);
  const unreachable = [
    ...(login.reachable ? [] : ['login.microsoftonline.com']),
    ...(graph.reachable ? [] : ['graph.microsoft.com']),
  ];
  if (unreachable.length > 0) {
    checks.push(entry('network', 'fail', 'network_unreachable', { host: unreachable.join(',') }));
  } else if (!exchange.reachable) {
    checks.push(
      entry('network', 'warn', 'network_exchange_unreachable', { host: 'outlook.office365.com' }),
    );
  } else {
    checks.push(entry('network', 'ok'));
  }

  const skewMs = login.dateMs === null ? 0 : login.dateMs - deps.now();
  const magnitude = Math.abs(skewMs);
  const skewParams = { skewSeconds: Math.round(skewMs / 1000) };
  checks.push(
    magnitude <= SKEW_OK_MS
      ? entry('time_skew', 'ok')
      : magnitude <= SKEW_WARN_MS
        ? entry('time_skew', 'warn', 'time_skew_warning', skewParams)
        : entry('time_skew', 'fail', 'time_skew_excessive', skewParams),
  );

  const failed = checks.some((check) => check.status === 'fail');
  const warned = checks.some((check) => check.status === 'warn');
  const result: EnvironmentResult = {
    ranAt: new Date(deps.now()).toISOString(),
    status: failed ? 'failed' : warned ? 'warning' : 'ok',
    blocking: failed,
    checks,
  };

  // The rows and the one audit entry of the step, in one transaction.
  const now = new Date(deps.now()).toISOString();
  withTransaction(db, (tx) => {
    const mode = services.state.read(tx).mode;
    services.steps.ensureRows(tx, mode);
    for (const check of checks) {
      services.steps.write(tx, 'environment', check.key, {
        status: ROW_STATUS[check.status],
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        errorCode: check.code,
        detail:
          check.params.host === undefined
            ? {}
            : { host: String(check.params.host).split(',')[0] ?? '' },
      });
    }
    const status: AuditedStatus = failed ? 'failed' : warned ? 'warning' : 'succeeded';
    auditStepRun(tx, {
      now: deps.now(),
      actor,
      repair: false,
      step: 'environment',
      status,
      attempt: 1,
      code: null,
      codes: checks.flatMap((check) => (check.code === null ? [] : [check.code])),
      mode,
    });
  });
  return result;
}
