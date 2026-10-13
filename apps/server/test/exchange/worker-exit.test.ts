// 0.3.63 production fault, FR-D-107: every Exchange call ended as `worker_crashed` within milliseconds
// and the log said nothing about why. Cause: the image installs PowerShell in /opt/microsoft/powershell/7
// and puts nothing on the PATH, the product looked `pwsh` up on the PATH only, kept the bare word, and
// `spawn('pwsh')` failed with ENOENT before any script ran (the CI smoke test used the absolute path, so it
// never saw it). This file holds (1) the regression for the lookup, (2) the exit record of a worker, a
// bounded and sanitised word of a closed list instead of the stderr text, and (3) the proof that no text
// of stderr reaches a log. Stand-ins only: the real `pwsh` counterparts are in real-pwsh.test.ts.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExchangeCommandError, ExchangeUnavailableError } from '../../src/ports/errors.js';
import {
  STDERR_CLASS_WORDS,
  STDERR_TAIL_CHARS,
  classifySpawnError,
  classifyStderr,
  safeSignal,
} from '../../src/integrations/exchange/pwsh/exit-classification.js';
import { ExchangeWorkerSession } from '../../src/integrations/exchange/pwsh/session.js';
import {
  createNodeWorkerLauncher,
  type WorkerExit,
  type WorkerProcess,
} from '../../src/integrations/exchange/pwsh/worker-launcher.js';
import {
  PWSH_COMMAND,
  PWSH_INSTALL_DIRECTORIES,
  resolveCommand,
} from '../../src/integrations/exchange/runtime.js';
import { rejectionOf, sequenceRandom } from '../integrations/support.js';
import { CountingCredentials, captureLog, clientHarness, sessionHarness } from './support.js';

const CANARY = 'Zoë CANARYNAME canary.address@canary-domain.example';
const ORG = { cmdlet: 'Get-OrganizationConfig', args: {} } as const;
const DOCKERFILE = fileURLToPath(new URL('../../../../Dockerfile', import.meta.url));

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'exo-exit-'));
  scratch.push(dir);
  return dir;
}

function exitOf(worker: WorkerProcess): Promise<WorkerExit> {
  return new Promise((resolve) => {
    worker.onExit(resolve);
  });
}

/** A real child process (Node) standing in for `pwsh`: runs `code` and ends as it says. */
function nodeWorker(code: string, parentEnv: Record<string, string> = {}): WorkerProcess {
  const home = tempDir();
  return createNodeWorkerLauncher({
    command: process.execPath,
    scriptPath: '/unused',
    homeDir: join(home, 'home'),
    parentEnv,
    argumentsFor: () => ['-e', code],
  }).launch({ certificateMode: 'memory' });
}

describe('the lookup of pwsh (the 0.3.63 fault)', () => {
  it('finds pwsh in the install directory of the image when the PATH does not hold it', () => {
    const install = tempDir();
    const emptyPath = tempDir();
    writeFileSync(join(install, 'pwsh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(install, 'pwsh'), 0o755);
    // The bug: the PATH alone leaves the bare word, which spawn cannot start.
    expect(resolveCommand(PWSH_COMMAND, emptyPath)).toBe('pwsh');
    // The fix: the install directory is the last place the lookup tries.
    expect(resolveCommand(PWSH_COMMAND, emptyPath, [install])).toBe(join(install, 'pwsh'));
    // The PATH still wins (the e2e shim relies on it).
    const first = tempDir();
    writeFileSync(join(first, 'pwsh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(first, 'pwsh'), 0o755);
    expect(resolveCommand(PWSH_COMMAND, first, [install])).toBe(join(first, 'pwsh'));
    // Relative fallback directories are ignored, as relative PATH entries are.
    expect(resolveCommand(PWSH_COMMAND, emptyPath, ['relative/dir'])).toBe('pwsh');
  });

  it('looks where the Dockerfile puts PowerShell, and the image puts nothing on the PATH', () => {
    const dockerfile = readFileSync(DOCKERFILE, 'utf8');
    expect(PWSH_INSTALL_DIRECTORIES).toEqual(['/opt/microsoft/powershell/7']);
    expect(dockerfile).toContain(
      'COPY --from=pwsh-fetch /opt/microsoft/powershell/7 /opt/microsoft/powershell/7',
    );
    // If the image ever puts pwsh on the PATH (or links it), this guard may be relaxed; until then it
    // is the reason the fallback exists.
    expect(dockerfile).not.toMatch(/^ENV\b[^\n]*\bPATH=/m);
  });

  it('ends a worker that cannot be started as one coded record, spawn_enoent, not as a silent crash', async () => {
    const home = tempDir();
    const worker = createNodeWorkerLauncher({
      command: 'pwsh-not-on-the-path-0363', // the bare word the 0.3.63 lookup left behind
      scriptPath: '/app/dist/exchange/worker-script.ps1',
      homeDir: join(home, 'home'),
      parentEnv: { PATH: home },
    }).launch({ certificateMode: 'memory' });
    const exit = await exitOf(worker);
    expect(exit).toEqual({ exitCode: null, signal: null, stderrClass: 'spawn_enoent' });
  });

  it('turns that into worker_crashed for the caller and ONE warning with the class for the log', async () => {
    const home = tempDir();
    const log = captureLog();
    const credentials = new CountingCredentials();
    const session = new ExchangeWorkerSession({
      launcher: createNodeWorkerLauncher({
        command: 'pwsh-not-on-the-path-0363',
        scriptPath: '/app/dist/exchange/worker-script.ps1',
        homeDir: join(home, 'home'),
        parentEnv: { PATH: home },
      }),
      credentials,
      clock: { now: () => Date.now() },
      scheduler: {
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (h) => {
          clearTimeout(h as NodeJS.Timeout);
        },
        setInterval: (cb, ms) => setInterval(cb, ms),
        clearInterval: (h) => {
          clearInterval(h as NodeJS.Timeout);
        },
      },
      random: sequenceRandom([0]),
      log,
    });
    const failure = await rejectionOf(session.request(ORG));
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect((failure as ExchangeUnavailableError).reason).toBe('worker_crashed');
    const exits = log.entries.filter((entry) => entry.fields.reason === 'exited');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      level: 'warn',
      fields: {
        event: 'exchange_worker',
        reason: 'exited',
        exitCode: null,
        signal: null,
        stderrClass: 'spawn_enoent',
      },
    });
  });
});

describe('the classification of stderr (a closed list, no text)', () => {
  const cases: readonly [string, string][] = [
    ['', 'none'],
    ['  \n ', 'none'],
    [`Unhandled exception. System.OutOfMemoryException ${CANARY}`, 'out_of_memory'],
    ["Couldn't find a valid ICU package installed on the system.", 'icu_missing'],
    ['System.PlatformNotSupportedException: Operation is not supported.', 'platform_not_supported'],
    ["System.IO.IOException: Read-only file system : '/home/x/.cache'", 'filesystem_not_writable'],
    [
      'Import-Module: The specified module was not loaded because no valid module file',
      'module_not_found',
    ],
    ['Could not load file or assembly Microsoft.Identity.Client', 'module_not_found'],
    [`Error Acquiring Token: ${CANARY}`, 'connect_failed'],
    ['MsalServiceException: invalid_client', 'connect_failed'],
    [`something nobody foresaw ${CANARY}`, 'unknown'],
    ['AADSTS700016: Application with identifier was not found', 'auth_failed_aadsts_700016'],
    ['AADSTS50034 The user account does not exist', 'auth_failed_aadsts_50034'],
  ];

  it.each(cases)('reads %j as %s', (text, expected) => {
    expect(classifyStderr(text)).toBe(expected);
  });

  it("skips the module's boilerplate mention of AADSTS70011 and takes the real number", () => {
    const text =
      'Case when Message contains:AADSTS70011 Invalid scope. The scope has to be of the form "https://resourceUrl/.default"' +
      `AADSTS700016: Application with identifier '${CANARY}' was not found in the directory`;
    expect(classifyStderr(text)).toBe('auth_failed_aadsts_700016');
  });

  it('answers a word of the closed list or digits only, never a piece of the text', () => {
    const words = new Set<string>(STDERR_CLASS_WORDS);
    for (const [text] of cases) {
      const word = classifyStderr(text);
      expect(words.has(word) || /^auth_failed_aadsts_\d{1,7}$/.test(word)).toBe(true);
      expect(word).not.toContain('CANARY');
      expect(word).not.toContain('canary');
    }
    // A number that is too long is not a code: it is not copied.
    expect(classifyStderr('AADSTS123456789012 CANARYNAME')).toBe('unknown');
  });

  it('reads the tail only (bounded) and survives a huge input', () => {
    const huge = `AADSTS700016 ${'x'.repeat(STDERR_TAIL_CHARS * 20)}`;
    expect(classifyStderr(huge)).toBe('unknown');
    expect(classifyStderr(`${'x'.repeat(STDERR_TAIL_CHARS * 20)} AADSTS65001`)).toBe(
      'auth_failed_aadsts_65001',
    );
  });

  it('maps spawn errors and signals to safe words', () => {
    expect(classifySpawnError('ENOENT')).toBe('spawn_enoent');
    expect(classifySpawnError('EACCES')).toBe('spawn_eacces');
    expect(classifySpawnError('EMFILE')).toBe('spawn_failed');
    expect(classifySpawnError(undefined)).toBe('spawn_failed');
    expect(safeSignal('SIGABRT')).toBe('SIGABRT');
    expect(safeSignal(null)).toBeNull();
    expect(safeSignal(`SIG${CANARY}`)).toBe('other');
  });
});

describe('the exit record of a real child process', () => {
  it('has the exit code and the class of the last stderr text, and the text itself is gone', async () => {
    const worker = nodeWorker(
      `process.stderr.write(${JSON.stringify(`Error Acquiring Token ${CANARY} AADSTS700016`)}, () => process.exit(3));`,
    );
    const exit = await exitOf(worker);
    expect(exit).toEqual({ exitCode: 3, signal: null, stderrClass: 'auth_failed_aadsts_700016' });
    expect(JSON.stringify(exit)).not.toMatch(/CANARY|canary|Zoë/);
  });

  it('has the signal of a process that was killed', async () => {
    const worker = nodeWorker("process.kill(process.pid, 'SIGKILL');");
    const exit = await exitOf(worker);
    expect(exit.signal).toBe('SIGKILL');
    expect(exit.exitCode).toBeNull();
  });

  it('keeps reading stderr when it is large, and a late listener gets the same record', async () => {
    const worker = nodeWorker(
      "process.stderr.write('y'.repeat(300000) + ' System.OutOfMemoryException', () => process.exit(134));",
    );
    const first = await exitOf(worker);
    expect(first).toEqual({ exitCode: 134, signal: null, stderrClass: 'out_of_memory' });
    expect(await exitOf(worker)).toEqual(first);
  });

  it('reports a clean end as none', async () => {
    const exit = await exitOf(nodeWorker('process.exit(0);'));
    expect(exit).toEqual({ exitCode: 0, signal: null, stderrClass: 'none' });
  });
});

describe('the session logs the exit of a worker once, with numbers and a word', () => {
  it('logs a crash as a warning: exit code, signal and class, and nothing else', async () => {
    const h = sessionHarness();
    await h.drive(h.session.request(ORG));
    h.launcher.processes[0]!.crash({
      exitCode: 134,
      signal: 'SIGABRT',
      stderrClass: 'filesystem_not_writable',
    });
    await h.settle();
    const exits = h.log.entries.filter((entry) => entry.fields.reason === 'exited');
    expect(exits).toEqual([
      {
        level: 'warn',
        fields: {
          event: 'exchange_worker',
          reason: 'exited',
          exitCode: 134,
          signal: 'SIGABRT',
          stderrClass: 'filesystem_not_writable',
        },
        message: 'exchange worker crashed',
      },
    ]);
    // The next request starts a new worker, and logs no second exit for the old one.
    await h.drive(h.session.request(ORG));
    expect(h.log.entries.filter((entry) => entry.fields.reason === 'exited')).toHaveLength(1);
  });

  it('logs the crash in flight (worker_crashed for the caller) with the same record', async () => {
    const h = sessionHarness();
    h.launcher.script((call) => (call.index === 0 ? 'exit' : undefined));
    const failure = await rejectionOf(h.drive(h.session.request(ORG)));
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    const exits = h.log.entries.filter((entry) => entry.fields.reason === 'exited');
    expect(exits.length).toBeGreaterThanOrEqual(1);
    expect(exits[0]!.level).toBe('warn');
  });

  it('logs an exit that the session asked for (close) at debug level, not as a crash', async () => {
    const h = sessionHarness();
    await h.drive(h.session.request(ORG));
    await h.drive(h.session.close());
    const exits = h.log.entries.filter((entry) => entry.fields.reason === 'exited');
    expect(exits).toHaveLength(1);
    expect(exits[0]!.level).toBe('debug');
  });

  it('logs a kill by the session (a deadline) at debug level too', async () => {
    const h = sessionHarness();
    h.launcher.script((call) => (call.index === 0 ? 'hang' : undefined));
    const outcome = rejectionOf(h.session.request({ ...ORG, deadlineMs: 1_000 }));
    await h.settle();
    h.time.elapse(1_000);
    await outcome;
    const exits = h.log.entries.filter((entry) => entry.fields.reason === 'exited');
    expect(exits.every((entry) => entry.level === 'debug')).toBe(true);
  });

  it('logs a refused connect with its code and the AADSTS number, and nothing else', async () => {
    const h = clientHarness();
    h.launcher.connect({ error: 'permission_denied', aadsts: 700016 });
    const failure = await rejectionOf(h.drive(h.session.request(ORG)));
    expect(failure).toBeInstanceOf(ExchangeCommandError);
    expect((failure as ExchangeCommandError).commandCode).toBe('permission_denied');
    const refused = h.log.entries.filter((entry) => entry.fields.reason === 'connect_refused');
    expect(refused).toEqual([
      {
        level: 'warn',
        fields: {
          event: 'exchange_worker',
          reason: 'connect_refused',
          code: 'permission_denied',
          aadsts: 700016,
          errorType: null,
          errorId: null,
          errorHints: null,
        },
        message: 'exchange worker connect refused',
      },
    ]);
  });

  it('puts no canary of stderr in any log entry or error, whatever the worker wrote', async () => {
    const home = tempDir();
    const log = captureLog();
    const script = `process.stderr.write(${JSON.stringify(`${CANARY} AADSTS70011 Error Acquiring Token`)}, () => process.exit(1));`;
    const session = new ExchangeWorkerSession({
      launcher: createNodeWorkerLauncher({
        command: process.execPath,
        scriptPath: '/unused',
        homeDir: join(home, 'home'),
        parentEnv: {},
        argumentsFor: () => ['-e', script],
      }),
      credentials: new CountingCredentials(),
      clock: { now: () => Date.now() },
      scheduler: {
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (h) => {
          clearTimeout(h as NodeJS.Timeout);
        },
        setInterval: (cb, ms) => setInterval(cb, ms),
        clearInterval: (h) => {
          clearInterval(h as NodeJS.Timeout);
        },
      },
      random: sequenceRandom([0]),
      log,
    });
    const failure = await rejectionOf(session.request(ORG));
    const text = JSON.stringify(log.entries) + String(failure) + JSON.stringify(failure);
    expect(text).not.toMatch(/CANARY|canary|Zoë|domain\.example/);
    const exit = log.entries.find((entry) => entry.fields.reason === 'exited');
    expect(exit?.fields).toMatchObject({ exitCode: 1, stderrClass: 'auth_failed_aadsts_70011' });
  });
});
