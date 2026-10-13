// The Exchange worker as the registry runs it (Phase D step D1, T-D-113, T-D-114, FR-D-102, FR-D-103,
// FR-D-108): the one file outside `pwsh/` that knows how the worker is started. It turns the settings of the
// deployment (where the script is, the key hand-over mode, where the certificate comes from) into a
// `PwshExchangeClient` over an `ExchangeWorkerSession`, and ends them again.
//
//   - The process is NOT started here. The session starts `pwsh` at its first request, so a server without
//     `pwsh` starts and answers every feature that does not use Exchange; the registry builds this lazily.
//   - The command is `pwsh` on the PATH, else the directory the image installs it in (ADR 0180: the image
//     copies PowerShell to /opt/microsoft/powershell/7 and puts nothing on the PATH). The script is the generated file
//     of the build: next to the bundle in the image, in the source tree under tsx and Vitest.
//   - Where the certificate comes from is the `ExchangeCredentialSource` of the deployment: `start.ts` wires
//     `createSecretsCredentialSource` (pwsh/credential-source.ts, re-exported by the registry), which reads the certificate and the PKCS#8 key
//     as PEM through the narrow accessor of the secrets module (GD1-0 amendment 1). Without a source, or
//     when it cannot load (a degraded secrets state, no certificate), every call answers "not available"
//     (`NO_EXCHANGE_CREDENTIAL` / `credential_unavailable`), the process stays up, and the Admin API probe
//     of the wizard is unaffected.
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock, RandomSource, Scheduler } from '../../ports/clock.js';
import { ExchangeUnavailableError } from '../../ports/errors.js';
import type { CertificateHolderPort } from '../../ports/secrets.js';
import {
  DEFAULT_HANDOVER,
  type ExchangeCredentialSource,
  type HandoverConfig,
} from './pwsh/key-handover.js';
import { PwshExchangeClient } from './pwsh/pwsh-client.js';
import { ExchangeWorkerSession, type ExchangeLog } from './pwsh/session.js';
import { createNodeWorkerLauncher, type WorkerLauncher } from './pwsh/worker-launcher.js';

export { createSecretsCredentialSource } from './pwsh/credential-source.js';

/** The command that starts the worker: found on the PATH of the process, else in `PWSH_INSTALL_DIRECTORIES`. */
export const PWSH_COMMAND = 'pwsh';

/**
 * Where the image installs PowerShell (Dockerfile, stage `pwsh-fetch`). That directory is NOT on the PATH of
 * the image, so a lookup on the PATH alone leaves the bare word `pwsh`, `spawn` fails with ENOENT, and every
 * Exchange call ends as `worker_crashed` (0.3.63). The directory is the last place the lookup tries.
 */
export const PWSH_INSTALL_DIRECTORIES: readonly string[] = Object.freeze([
  '/opt/microsoft/powershell/7',
]);

/**
 * The file `command` names on the PATH of the SERVER process: the first absolute directory of `pathVariable`
 * that holds an executable file of that name. The worker is started with a short environment that has no
 * PATH of its own, so the search must happen here, once, in the environment that the operator (or the
 * image) really configured; a command that is not found stays as it is and fails at the start of the
 * worker (503 `exchange_unavailable`, the process stays up). A command with a slash is used as given.
 * `fallbackDirectories` are tried after the PATH (absolute directories only).
 */
export function resolveCommand(
  command: string,
  pathVariable: string | undefined,
  fallbackDirectories: readonly string[] = [],
): string {
  if (command.includes('/')) return command;
  for (const directory of [...(pathVariable ?? '').split(delimiter), ...fallbackDirectories]) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here: the next directory.
    }
  }
  return command;
}

/** What the deployment decides about the worker. Every field is optional but the home directory and the environment. */
export interface ExchangeWorkerSettings {
  /** The command; default `pwsh`, searched on the PATH of `parentEnv`. */
  readonly command?: string;
  /** The generated `worker-script.ps1`; default `defaultExchangeScript()`. */
  readonly scriptPath?: string;
  /** The home directory of the worker: a path on a writable file system (a tmpfs under a read-only root). */
  readonly homeDir: string;
  /** The environment the few allowed names (proxy, certificate bundle) are copied from. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** `EXCHANGE_KEY_HANDOVER`: `memory` (default) or the `tmpfs` fallback (FR-D-103). */
  readonly handover?: HandoverConfig;
  /**
   * Where the certificate and its key (PEM) come from, per pinned tenant. Absent: no source exists and every
   * Exchange call answers 503 `exchange_unavailable`.
   */
  readonly credentials?: (context: {
    readonly tenantId: string;
    readonly clientId: string;
    readonly holder: CertificateHolderPort;
  }) => ExchangeCredentialSource;
  /** For a test: a launcher in place of the Node one. */
  readonly launcher?: WorkerLauncher;
}

/** The source of a deployment that has none: loading says so, without any text. */
export const NO_EXCHANGE_CREDENTIAL: ExchangeCredentialSource = Object.freeze({
  load(): Promise<never> {
    return Promise.reject(new ExchangeUnavailableError({ reason: 'credential_unavailable' }));
  },
});

/**
 * The worker script: `exchange/worker-script.ps1` next to the bundle (the build copies it there, build.mjs),
 * otherwise the generated file of the source tree.
 */
export function defaultExchangeScript(here = dirname(fileURLToPath(import.meta.url))): string {
  const built = join(here, 'exchange', 'worker-script.ps1');
  return existsSync(built) ? built : join(here, 'pwsh', 'worker-script.ps1');
}

export interface ExchangeRuntime {
  readonly client: PwshExchangeClient;
  /** Ends the worker (at once, nothing is awaited by the caller's lifecycle). */
  close(): Promise<void>;
}

export interface ExchangeRuntimeContext {
  readonly tenantId: string;
  readonly clientId: string;
  readonly holder: CertificateHolderPort;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly scheduler: Scheduler;
  readonly log?: ExchangeLog;
}

/** Builds the client and its session. Nothing runs yet. */
export function createExchangeRuntime(
  settings: ExchangeWorkerSettings,
  context: ExchangeRuntimeContext,
): ExchangeRuntime {
  const credentials =
    settings.credentials?.({
      tenantId: context.tenantId,
      clientId: context.clientId,
      holder: context.holder,
    }) ?? NO_EXCHANGE_CREDENTIAL;
  const session = new ExchangeWorkerSession({
    launcher:
      settings.launcher ??
      createNodeWorkerLauncher({
        command:
          settings.command ??
          resolveCommand(PWSH_COMMAND, settings.parentEnv.PATH, PWSH_INSTALL_DIRECTORIES),
        scriptPath: settings.scriptPath ?? defaultExchangeScript(),
        homeDir: settings.homeDir,
        parentEnv: settings.parentEnv,
      }),
    credentials,
    clock: context.clock,
    scheduler: context.scheduler,
    random: context.random,
    ...(context.log === undefined ? {} : { log: context.log }),
    handover: settings.handover ?? DEFAULT_HANDOVER,
  });
  const client = new PwshExchangeClient({
    session,
    random: context.random,
    scheduler: context.scheduler,
    ...(context.log === undefined ? {} : { log: context.log }),
  });
  return { client, close: () => session.close() };
}
