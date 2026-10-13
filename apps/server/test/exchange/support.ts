// Test support for the Exchange worker tests (T-D-112 to T-D-114). Not a test file: Vitest runs
// `*.test.ts` only. Everything is deterministic: a fake clock and scheduler, a seeded random source,
// the worker stand-in over the fake Exchange state, an in-memory scratch file system.
import {
  ExchangeWorkerSession,
  type ExchangeLog,
  type SessionLimits,
} from '../../src/integrations/exchange/pwsh/session.js';
import { PwshExchangeClient } from '../../src/integrations/exchange/pwsh/pwsh-client.js';
import type {
  ExchangeCredential,
  ExchangeCredentialSource,
  HandoverConfig,
  ScratchFileSystem,
} from '../../src/integrations/exchange/pwsh/key-handover.js';
import {
  FakeExchangeState,
  createStandInLauncher,
  type StandInFiles,
  type StandInLauncher,
} from '../fakes/fake-tenant/exchange/index.js';
import { createTime, sequenceRandom, settle, track, type Time } from '../integrations/support.js';

/** A PEM block assembled at run time, so no PEM-shaped text sits in this source file; 64-column body. */
function pemOf(label: string, bytes: Uint8Array): string {
  const body = (
    Buffer.from(bytes)
      .toString('base64')
      .match(/.{1,64}/g) ?? []
  ).join('\n');
  return ['-----BEGIN ' + label + '-----', body, '-----END ' + label + '-----', ''].join('\n');
}

/** Recognisable key bytes (and a certificate that is not one): the canary the no-key-on-disk scans look for. */
export const CANARY_KEY_BYTES: Uint8Array = Uint8Array.from(
  Array.from({ length: 96 }, (_, n) => (n * 7 + 13) % 251),
);
export const CANARY_CERTIFICATE_BYTES: Uint8Array = Uint8Array.from(
  Array.from({ length: 96 }, (_, n) => (n * 11 + 5) % 251),
);
export const CANARY_PRIVATE_KEY_PEM = pemOf('PRIVATE KEY', CANARY_KEY_BYTES);
export const CANARY_CERTIFICATE_PEM = pemOf('CERTIFICATE', CANARY_CERTIFICATE_BYTES);

const APP_ID = '11111111-2222-4333-8444-555555555555';
const ORGANIZATION = 'contoso-fake.onmicrosoft.com';

/** The credential source: counts its loads, can fail. */
export class CountingCredentials implements ExchangeCredentialSource {
  loads = 0;
  #failure: Error | undefined;

  load(): Promise<ExchangeCredential> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    this.loads += 1;
    return Promise.resolve({
      appId: APP_ID,
      organization: ORGANIZATION,
      certificatePem: CANARY_CERTIFICATE_PEM,
      privateKeyPem: CANARY_PRIVATE_KEY_PEM,
    });
  }

  failWith(error: Error): void {
    this.#failure = error;
  }
}

/** A scratch file system in memory: the fallback's directories and the files the stand-in plays the script's part with. */
export class MemoryScratch implements ScratchFileSystem, StandInFiles {
  readonly #files = new Map<string, Uint8Array>();
  readonly #directories = new Map<string, number | undefined>();
  readonly #created: string[] = [];
  readonly #tmpfs: boolean;

  constructor(options: { readonly tmpfs?: boolean } = {}) {
    this.#tmpfs = options.tmpfs !== false;
  }

  makeDirectory(path: string): void {
    if (this.#directories.has(path)) throw new Error('exists');
    this.#directories.set(path, 0o700);
    this.#created.push(path);
  }

  removeTree(path: string): void {
    this.#directories.delete(path);
    for (const key of [...this.#files.keys()])
      if (key.startsWith(`${path}/`)) this.#files.delete(key);
    for (const key of [...this.#directories.keys()])
      if (key.startsWith(`${path}/`)) this.#directories.delete(key);
  }

  listDirectories(root: string): string[] {
    return [...this.#directories.keys()]
      .filter((path) => path.startsWith(`${root}/`) && !path.slice(root.length + 1).includes('/'))
      .map((path) => path.slice(root.length + 1));
  }

  isTmpfs(): boolean {
    return this.#tmpfs;
  }

  write(path: string, bytes: Uint8Array): void {
    this.#files.set(path, Uint8Array.from(bytes));
  }

  remove(path: string): void {
    this.#files.delete(path);
  }

  /** A file (and its directory) that something else left behind. */
  plant(path: string, bytes: Uint8Array): void {
    const directory = path.slice(0, path.lastIndexOf('/'));
    if (!this.#directories.has(directory)) this.#directories.set(directory, undefined);
    this.#files.set(path, Uint8Array.from(bytes));
  }

  files(): Map<string, Uint8Array> {
    return new Map(this.#files);
  }

  /** The directories that exist now. */
  directories(): string[] {
    return [...this.#directories.keys()];
  }

  /** Every directory `makeDirectory` was called for, including those removed since. */
  everCreated(): string[] {
    return [...this.#created];
  }

  modeOf(path: string): number | undefined {
    return this.#directories.get(path);
  }
}

export interface LogEntry {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

export function captureLog(): ExchangeLog & { readonly entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    debug(fields, message) {
      entries.push({ level: 'debug', fields: { ...fields }, message });
    },
    warn(fields, message) {
      entries.push({ level: 'warn', fields: { ...fields }, message });
    },
  };
}

export interface HarnessOptions {
  readonly state?: FakeExchangeState;
  readonly handover?: HandoverConfig;
  /** Is the scratch root a tmpfs? Default yes. */
  readonly tmpfs?: boolean;
  readonly limits?: SessionLimits;
  /** The floats the random source plays (jitter). Default `[0]`. */
  readonly random?: readonly number[];
}

export interface SessionHarness {
  readonly state: FakeExchangeState;
  readonly launcher: StandInLauncher;
  readonly session: ExchangeWorkerSession;
  readonly credentials: CountingCredentials;
  readonly scratch: MemoryScratch;
  readonly log: ExchangeLog & { readonly entries: LogEntry[] };
  readonly time: Time;
  /** Lets pending promise chains run; no clock moves. */
  settle(): Promise<void>;
  /** Waits for a promise, letting fake time pass in small steps while it is not done. */
  drive<T>(promise: Promise<T>): Promise<T>;
}

export function sessionHarness(options: HarnessOptions = {}): SessionHarness {
  const state = options.state ?? new FakeExchangeState();
  const scratch = new MemoryScratch(options.tmpfs === undefined ? {} : { tmpfs: options.tmpfs });
  const launcher = createStandInLauncher(state, { files: scratch });
  const credentials = new CountingCredentials();
  const time = createTime();
  const log = captureLog();
  const session = new ExchangeWorkerSession({
    launcher,
    credentials,
    clock: time.clock,
    scheduler: time.scheduler,
    random: sequenceRandom(options.random ?? [0]),
    log,
    scratchFs: scratch,
    ...(options.handover === undefined ? {} : { handover: options.handover }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return {
    state,
    launcher,
    session,
    credentials,
    scratch,
    log,
    time,
    settle: () => settle(),
    async drive(promise) {
      const tracked = track(promise);
      for (let round = 0; round < 400 && !tracked.settled(); round += 1) {
        await settle();
        if (tracked.settled()) break;
        time.elapse(250);
      }
      return tracked.promise;
    },
  };
}

export interface ClientHarness extends SessionHarness {
  readonly client: PwshExchangeClient;
}

export function clientHarness(options: HarnessOptions = {}): ClientHarness {
  const base = sessionHarness(options);
  const client = new PwshExchangeClient({
    session: base.session,
    random: sequenceRandom(options.random ?? [0]),
    scheduler: base.time.scheduler,
    log: base.log,
  });
  return { ...base, client };
}
