// Sample answers of the setup and connection routes, built with the shared schemas, so that a test
// fails when the wire format and a fixture disagree and not because a hand-written sample drifted.
import { loadNamespace, LAZY_NAMESPACES } from '@m365portal/shared/i18n';
import {
  ConnectionResponseSchema,
  RunSnapshotSchema,
  RunStatusSchema,
} from '@m365portal/shared/schemas/connection';
import {
  EnvironmentResultSchema,
  SetupStateResponseSchema,
} from '@m365portal/shared/schemas/setup';
import {
  STEP_KEYS,
  subActionsOf,
  type SetupMode,
  type StepKey,
  type StepStatus,
} from '@m365portal/shared/setup/steps';
import type { ResultCode } from '@m365portal/shared/setup/result-codes';
import type { z } from 'zod';

export const T0 = Date.parse('2026-10-12T10:00:00.000Z');
export const iso = (offsetMs = 0): string => new Date(T0 + offsetMs).toISOString();

export const TENANT_ID = '3f2b6a52-7c1e-4a8e-9a3d-0c5f4d1b2e77';
export const APP_ID = '8d1a9c0e-1f3b-4b9a-8f55-2f3b9c1d7a10';
export const APP_OBJECT_ID = '0b6f3a1e-2c4d-4e5f-8a7b-9c1d2e3f4a5b';
export const SP_ID = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';
export const OWNER_ID = '7c1e4a8e-9a3d-4c5f-8d1b-2e773f2b6a52';
export const GROUP_ID = '9a3d0c5f-4d1b-4e77-8f2b-6a527c1e4a8e';

/** Both languages of every lazy namespace, loaded once: a test then reads any of them. */
export async function loadAllLazyNamespaces(): Promise<void> {
  for (const namespace of LAZY_NAMESPACES) {
    await loadNamespace('en', namespace);
    await loadNamespace('nl', namespace);
  }
}

type SubOverrides = Record<string, Partial<StepState['subActions'][number]>>;
type StepState = z.infer<typeof SetupStateResponseSchema>['steps'][number];

/** The five steps. `statuses` sets the step status; every sub-action of the step gets it too. */
export function stepsOf(
  statuses: Partial<Record<StepKey, StepStatus>> = {},
  subs: SubOverrides = {},
  mode: SetupMode = 'automatic',
): StepState[] {
  return STEP_KEYS.map((step) => {
    const status = statuses[step] ?? 'pending';
    return {
      step,
      status,
      subActions: subActionsOf(step, mode).map((key) => ({
        key,
        status,
        attempt: status === 'pending' ? 0 : 1,
        startedAt: status === 'pending' ? null : iso(-60_000),
        finishedAt: status === 'pending' || status === 'running' || status === 'waiting' ? null : iso(-30_000),
        errorCode: null,
        hint: null,
        waiting: null,
        manual: false,
        ...subs[key],
      })),
    };
  });
}

export function sampleSetupState(
  overrides: Partial<z.input<typeof SetupStateResponseSchema>> = {},
): z.infer<typeof SetupStateResponseSchema> {
  return SetupStateResponseSchema.parse({
    state: 'in_progress',
    mode: 'automatic',
    defaultLanguage: null,
    steps: stepsOf(),
    tenant: { proposedTenantId: null, tenantId: null, name: null, initialDomain: null },
    application: null,
    certificate: null,
    designatedOwner: null,
    exchangeEnabled: true,
    proof: null,
    publicBaseUrl: 'https://panel.example.com',
    session: { idleExpiresAt: iso(30 * 60_000), absoluteExpiresAt: iso(4 * 3600_000) },
    ...overrides,
  });
}

export function sampleRunStatus(
  overrides: Partial<z.input<typeof RunStatusSchema>> = {},
): z.infer<typeof RunStatusSchema> {
  return RunStatusSchema.parse({
    id: '11111111-2222-4333-8444-555555555555',
    kind: 'setup',
    mode: 'continue',
    steps: ['connect', 'configure', 'verify'],
    status: 'running',
    startedAt: iso(-10_000),
    finishedAt: null,
    cancelRequested: false,
    ...overrides,
  });
}

export function sampleSnapshot(
  overrides: Partial<z.input<typeof RunSnapshotSchema>> = {},
): z.infer<typeof RunSnapshotSchema> {
  return RunSnapshotSchema.parse({
    serverTime: iso(),
    run: null,
    steps: stepsOf(),
    deviceCode: null,
    adoption: null,
    log: { lines: [], lastSeq: 0, hasMore: false, truncated: false },
    ...overrides,
  });
}

export function logLine(
  seq: number,
  messageKey: string,
  params: Record<string, string | number | boolean> = {},
  level: 'info' | 'warn' | 'error' = 'info',
) {
  return { seq, ts: iso(seq * 1000), step: 'connect', level, messageKey, params };
}

export function sampleEnvironment(
  overrides: Partial<Record<string, { status: 'ok' | 'warn' | 'fail'; code?: ResultCode }>> = {},
): z.infer<typeof EnvironmentResultSchema> {
  const keys = ['public_base_url', 'data_dir', 'app_key', 'node_version', 'network', 'time_skew'];
  const checks = keys.map((key) => {
    const override = overrides[key];
    const status = override?.status ?? 'ok';
    return {
      key,
      status,
      code: status === 'ok' ? null : (override?.code ?? null),
      remedyKey: status === 'ok' ? null : `setup.remedy.${String(override?.code)}`,
      params: {},
    };
  });
  const failed = checks.some((check) => check.status === 'fail');
  const warned = checks.some((check) => check.status === 'warn');
  return EnvironmentResultSchema.parse({
    ranAt: iso(),
    status: failed ? 'failed' : warned ? 'warning' : 'ok',
    blocking: failed,
    checks,
  });
}

export function sampleConnection(
  overrides: Partial<z.input<typeof ConnectionResponseSchema>> = {},
): z.infer<typeof ConnectionResponseSchema> {
  return ConnectionResponseSchema.parse({
    state: 'completed',
    mode: 'automatic',
    tenant: { tenantId: TENANT_ID, name: 'Contoso', initialDomain: 'contoso.onmicrosoft.com' },
    application: { appId: APP_ID, objectId: APP_OBJECT_ID, displayName: 'M365Portal' },
    certificate: {
      thumbprintSha1: 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678',
      notAfter: iso(300 * 86_400_000),
      daysLeft: 300,
      level: 'ok',
    },
    pendingCertificate: null,
    exchange: { enabled: true },
    permissionSetVersion: 1,
    redirectUris: ['https://panel.example.com/auth/callback'],
    secrets: { status: 'ok' },
    proof: null,
    verifiedAt: iso(-3600_000),
    runActive: false,
    ...overrides,
  });
}
