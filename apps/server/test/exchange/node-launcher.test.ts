// T-D-112, FR-D-102, FR-D-103, FR-D-107: the real process boundary. `createNodeWorkerLauncher` spawns
// a child with `shell: false`, an environment built from a short list (nothing else of the parent
// gets through), pipes on stdin and stdout, and stderr thrown away (it can hold names). The child
// here is a plain Node program that speaks the protocol (`standin-process.mjs`); `pwsh` itself is
// the owner's OV-D1 and the image smoke test.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNodeWorkerLauncher,
  type WorkerProcess,
} from '../../src/integrations/exchange/pwsh/worker-launcher.js';

const CHILD = fileURLToPath(
  new URL('../fakes/fake-tenant/exchange/standin-process.mjs', import.meta.url),
);
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function launcher(parentEnv: Record<string, string | undefined> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'exo-launcher-'));
  scratch.push(home);
  return {
    home,
    launcher: createNodeWorkerLauncher({
      command: process.execPath,
      scriptPath: CHILD,
      homeDir: join(home, 'pwsh-home'),
      parentEnv,
      argumentsFor: (options) => [CHILD, '--mode', options.certificateMode],
    }),
  };
}

/** Collects what the process prints, line by line. */
function lines(worker: WorkerProcess): { next(): Promise<string>; exited: Promise<void> } {
  const queue: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let partial = '';
  worker.onData((chunk) => {
    partial += chunk;
    for (;;) {
      const at = partial.indexOf('\n');
      if (at < 0) break;
      const line = partial.slice(0, at);
      partial = partial.slice(at + 1);
      const waiter = waiting.shift();
      if (waiter === undefined) queue.push(line);
      else waiter(line);
    }
  });
  const exited = new Promise<void>((resolve) => {
    worker.onExit(() => {
      resolve();
    });
  });
  return {
    next: () =>
      new Promise<string>((resolve) => {
        const ready = queue.shift();
        if (ready === undefined) waiting.push(resolve);
        else resolve(ready);
      }),
    exited,
  };
}

describe('the child process', () => {
  it('answers a ping over the pipes and shows only the environment the launcher built', async () => {
    const { launcher: l, home } = launcher({
      PATH: '/usr/bin',
      APP_KEY: 'canary-app-key',
      HTTPS_PROXY: 'http://proxy.example:3128',
    });
    const worker = l.launch({ certificateMode: 'memory' });
    const io = lines(worker);
    worker.write(`${JSON.stringify({ v: 1, type: 'ping', id: 'ping-00001' })}\n`);
    const answer = JSON.parse(await io.next()) as { data: { env: string[]; argv: string[] } };
    expect(answer.data.argv).toEqual(['--mode', 'memory']);
    expect(answer.data.env).toContain('HOME');
    expect(answer.data.env).toContain('HTTPS_PROXY');
    expect(answer.data.env).not.toContain('APP_KEY');
    expect(JSON.stringify(answer)).not.toContain('canary');
    expect(statSync(join(home, 'pwsh-home')).mode & 0o777).toBe(0o700);
    worker.kill();
    await io.exited;
  });

  it('throws stderr away: a certificate echoed on stderr never reaches the reader', async () => {
    const { launcher: l } = launcher();
    const worker = l.launch({ certificateMode: 'memory' });
    const seen: string[] = [];
    worker.onData((chunk) => seen.push(chunk));
    const io = lines(worker);
    worker.write(
      `${JSON.stringify({ v: 1, type: 'connect', id: 'connect-0001', certificate: { data: 'CANARYCERT' } })}\n`,
    );
    await io.next();
    expect(seen.join('')).not.toContain('CANARY');
    worker.kill();
    await io.exited;
  });

  it('reads a multi-byte character that arrives in two chunks', async () => {
    const { launcher: l } = launcher();
    const worker = l.launch({ certificateMode: 'memory' });
    const io = lines(worker);
    worker.write(
      `${JSON.stringify({ v: 1, type: 'call', id: 'call-00001', cmdlet: 'x', args: { Identity: 'split' } })}\n`,
    );
    expect(JSON.parse(await io.next())).toMatchObject({ data: { word: 'café €' } });
    worker.kill();
    await io.exited;
  });

  it('reports an exit the child chose itself, and an exit it was given', async () => {
    const { launcher: l } = launcher();
    const crashing = l.launch({ certificateMode: 'memory' });
    const crashed = lines(crashing);
    crashing.write(
      `${JSON.stringify({ v: 1, type: 'call', id: 'call-00002', cmdlet: 'x', args: { Identity: 'crash' } })}\n`,
    );
    await crashed.exited;
    const killed = l.launch({ certificateMode: 'memory' });
    const gone = lines(killed);
    killed.kill();
    killed.kill();
    await gone.exited;
  });

  it('ends when stdin is closed', async () => {
    const { launcher: l } = launcher();
    const worker = l.launch({ certificateMode: 'memory' });
    const io = lines(worker);
    worker.end();
    await io.exited;
  });

  it('does not run a shell: a script path with shell syntax is one argument, not a command', async () => {
    const home = mkdtempSync(join(tmpdir(), 'exo-launcher-'));
    scratch.push(home);
    const evil = createNodeWorkerLauncher({
      command: process.execPath,
      scriptPath: '/nonexistent; touch /tmp/pwned',
      homeDir: join(home, 'h'),
      parentEnv: {},
      argumentsFor: (options) => [
        `/nonexistent; touch ${join(home, 'pwned')}`,
        options.certificateMode,
      ],
    });
    const worker = evil.launch({ certificateMode: 'memory' });
    const io = lines(worker);
    await io.exited;
    expect(() => statSync(join(home, 'pwned'))).toThrow();
  });
});
