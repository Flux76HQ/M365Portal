// The memory of one run (T-B-129, plan 9.6 "Run context"): resolved role ids, the identifiers the
// sub-actions hand to each other, the cancel flag, the adoption the operator has to confirm and the
// moments that decide whether a 404 or a 403 is replication. Discarded with the run. Nothing here is a
// secret; the bootstrap object lives in the engine, not here.
import type { ExchangeRoleKey } from '@m365portal/shared/setup/graph-roles';
import type { AdoptionPrompt } from './wire.js';

export type RunKind = 'setup' | 'repair';
export type RunMode = 'continue' | 'reconcile';
export type RunStep = 'connect' | 'configure' | 'verify';
export type RunStatusName =
  'running' | 'waiting' | 'succeeded' | 'warning' | 'failed' | 'cancelled';

/** Who started the run: the setup actor, or a signed-in user (repair, after completion). */
export interface RunActor {
  readonly kind: 'setup' | 'user';
  readonly id: string;
}

export interface RunRequest {
  readonly steps: readonly RunStep[];
  readonly kind: RunKind;
  readonly mode: RunMode;
  readonly tenantHint?: string | undefined;
  readonly applicationName?: string | undefined;
  readonly exchangeRole?: ExchangeRoleKey | undefined;
}

export interface Adoption {
  readonly prompt: AdoptionPrompt;
  /** Set by `POST /connection/adopt`. */
  confirmed: boolean;
  acknowledgedForeign: boolean;
}

export class RunContext {
  readonly id: string;
  readonly kind: RunKind;
  readonly mode: RunMode;
  readonly steps: readonly RunStep[];
  readonly actor: RunActor;
  readonly startedAt: number;
  readonly tenantHint: string | undefined;
  readonly applicationName: string;
  readonly exchangeRole: ExchangeRoleKey;

  status: RunStatusName = 'running';
  finishedAt: number | null = null;
  cancelRequested = false;
  /** Resolves when the run is cancelled: a sub-action that waits on a third party races against it. */
  readonly cancellation: Promise<void>;
  #resolveCancellation: () => void = () => undefined;

  /** Application role ids by role name, resolved at run time (FR-B-302). */
  roleIds: Record<string, string> = {};
  /** Every application role of the two resources, id to value. */
  roleNames: Record<string, string> = {};
  /** The service principal ids of the resources and of the runtime application. */
  graphSpId: string | undefined;
  exchangeSpId: string | undefined;
  /** The adoption waiting for the operator, if any. */
  adoption: Adoption | undefined;

  /** When this run last created an object / made a grant / uploaded a certificate (ms). */
  lastCreatedAt: number | undefined;
  lastGrantAt: number | undefined;
  lastCertificateAt: number | undefined;

  /** Wakes the current wait (Retry now, cancel). */
  wake: (() => void) | undefined;
  /** Wakes the operator wait (adopt, cancel). */
  operatorWake: (() => void) | undefined;
  /** Set while a sub-action waits for replication or transient retries. */
  waitingSub: { readonly step: string; readonly sub: string } | undefined;

  constructor(options: {
    readonly id: string;
    readonly request: RunRequest;
    readonly actor: RunActor;
    readonly startedAt: number;
    readonly applicationName: string;
    readonly exchangeRole: ExchangeRoleKey;
  }) {
    this.id = options.id;
    this.kind = options.request.kind;
    this.mode = options.request.mode;
    this.steps = options.request.steps;
    this.actor = options.actor;
    this.startedAt = options.startedAt;
    this.tenantHint = options.request.tenantHint;
    this.applicationName = options.applicationName;
    this.exchangeRole = options.exchangeRole;
    this.cancellation = new Promise<void>((resolve) => {
      this.#resolveCancellation = resolve;
    });
  }

  /** Ask the run to stop at its next checkpoint, and wake whoever waits on it. */
  requestCancel(): void {
    this.cancelRequested = true;
    this.#resolveCancellation();
    this.wake?.();
    this.operatorWake?.();
  }

  /** Mark the moment an object was created (opens the 404 and 400 replication reading). */
  markCreated(now: number): void {
    this.lastCreatedAt = now;
  }
  markGrant(now: number): void {
    this.lastGrantAt = now;
  }
  markCertificateUploaded(now: number): void {
    this.lastCertificateAt = now;
  }
}
