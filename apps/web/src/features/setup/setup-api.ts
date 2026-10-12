// The wizard's and the connection page's calls to the server (T-B-300; contract P10 to P26). Every answer
// is parsed with the shared wire schema, so a response that does not fit is an error here and never a
// half-rendered screen. The UI keeps no wizard state of its own: these functions are the whole of what it
// knows (`GET /api/v1/setup/state` once, then the run snapshot).
import {
  EnvironmentResultSchema,
  FinishResponseSchema,
  GroupSearchResponseSchema,
  ManualResponseSchema,
  SetupStateResponseSchema,
  SetupStatusResponseSchema,
  UnlockResponseSchema,
  type FinishRequestSchema,
  type ManualRequestSchema,
} from '@m365portal/shared/schemas/setup';
import {
  ConnectionResponseSchema,
  ProofSchema,
  RunSnapshotSchema,
  RunStatusSchema,
  type AdoptRequestSchema,
  type StartRunRequestSchema,
} from '@m365portal/shared/schemas/connection';
import type { z } from 'zod';
import type { ApiClient } from '../../lib/api';

export type SetupStatus = z.infer<typeof SetupStatusResponseSchema>;
export type SetupStateResponse = z.infer<typeof SetupStateResponseSchema>;
export type EnvironmentResult = z.infer<typeof EnvironmentResultSchema>;
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type StepState = SetupStateResponse['steps'][number];
export type SubActionState = StepState['subActions'][number];
export type LogLine = RunSnapshot['log']['lines'][number];
export type DeviceCodePanelState = NonNullable<RunSnapshot['deviceCode']>;
export type AdoptionPromptState = NonNullable<RunSnapshot['adoption']>;
export type Proof = z.infer<typeof ProofSchema>;
export type ConnectionState = z.infer<typeof ConnectionResponseSchema>;
export type StartRunRequest = z.input<typeof StartRunRequestSchema>;
export type ManualRequest = z.input<typeof ManualRequestSchema>;
export type FinishRequest = z.input<typeof FinishRequestSchema>;
export type AdoptRequest = z.input<typeof AdoptRequestSchema>;

const EMPTY = {} as const;

export const setupKeys = Object.freeze({
  status: ['setup', 'status'] as const,
  state: ['setup', 'state'] as const,
  connection: ['connection'] as const,
});

export const setupApi = (api: ApiClient) => ({
  status: (signal?: AbortSignal) =>
    api.get('/api/v1/setup/status', { schema: SetupStatusResponseSchema, ...(signal ? { signal } : {}) }),
  unlock: (token: string) =>
    api.post('/api/v1/setup/unlock', { body: { token }, schema: UnlockResponseSchema }),
  state: (signal?: AbortSignal) =>
    api.get('/api/v1/setup/state', { schema: SetupStateResponseSchema, ...(signal ? { signal } : {}) }),
  environment: () =>
    api.post('/api/v1/setup/environment', { body: EMPTY, schema: EnvironmentResultSchema }),
  manual: (request: ManualRequest) =>
    api.put('/api/v1/setup/manual', { body: request, schema: ManualResponseSchema }),
  searchGroups: (q: string, signal?: AbortSignal) =>
    api.get('/api/v1/setup/groups', {
      query: { q },
      schema: GroupSearchResponseSchema,
      ...(signal ? { signal } : {}),
    }),
  finish: (request: FinishRequest) =>
    api.post('/api/v1/setup/finish', { body: request, schema: FinishResponseSchema }),
  endSession: () => api.delete('/api/v1/setup/session'),
  /** The public certificate for manual mode: a same-origin download link, never a fetch. */
  certificateHref: '/api/v1/setup/certificate.cer',
});

export const connectionApi = (api: ApiClient) => ({
  get: (signal?: AbortSignal) =>
    api.get('/api/v1/connection', { schema: ConnectionResponseSchema, ...(signal ? { signal } : {}) }),
  snapshot: (after: number, signal?: AbortSignal) =>
    api.get('/api/v1/connection/runs/current', {
      query: { after },
      schema: RunSnapshotSchema,
      ...(signal ? { signal } : {}),
    }),
  start: (request: StartRunRequest) =>
    api.post('/api/v1/connection/runs', { body: request, schema: RunStatusSchema }),
  retryNow: () =>
    api.post('/api/v1/connection/runs/current/retry-now', { body: EMPTY, schema: RunStatusSchema }),
  cancel: () =>
    api.post('/api/v1/connection/runs/current/cancel', { body: EMPTY, schema: RunStatusSchema }),
  adopt: (request: AdoptRequest) =>
    api.post('/api/v1/connection/adopt', { body: request, schema: RunStatusSchema }),
  verify: () => api.post('/api/v1/connection/verify', { body: EMPTY, schema: ProofSchema }),
});
