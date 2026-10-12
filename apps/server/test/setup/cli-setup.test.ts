// T-B-124, TB-06: `setup-token` and `setup-reopen` (FR-B-203, FR-B-222, FR-B-223, EB-11, EB-37).
// The commands run through the dispatcher in process; one test spawns the BUILT cli.js to prove the
// bundle carries them. No token appears in a stream other than standard output of `setup-token`.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/cli.js';
import { openDatabase, databasePathOf } from '../../src/db/index.js';
import { setupTokenPath } from '../../src/setup/token.js';
import { buildLayout, type BuiltLayout } from '../helpers/built-server.js';
import { migratedDatabase } from '../secrets/support.js';

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  args: readonly string[],
  env: Record<string, string>,
  clockMs = Date.parse('2026-10-10T12:00:00.000Z'),
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await runCommand(args, {
    env,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    now: () => clockMs,
  });
  return { code, stdout, stderr };
}

async function scene(state: 'unconfigured' | 'completed' | 'in_progress' | 'awaiting_first_signin') {
  const { dataDir, database } = await migratedDatabase({
    setupState: state === 'completed' ? 'completed' : 'unconfigured',
  });
  if (state === 'in_progress' || state === 'awaiting_first_signin') {
    database.sqlite.prepare("UPDATE setup_state SET state = 'in_progress'").run();
    if (state === 'awaiting_first_signin') {
      database.sqlite.prepare("UPDATE setup_state SET state = 'awaiting_first_signin'").run();
    }
  }
  database.close();
  return { dataDir, env: { DATA_DIR: dataDir, PUBLIC_BASE_URL: 'http://localhost:9300' } };
}

function stateOf(dataDir: string): { state: string; completed_at: string | null } {
  const database = openDatabase({ path: databasePathOf(dataDir) });
  try {
    return database.sqlite.prepare('SELECT state, completed_at FROM setup_state').get() as {
      state: string;
      completed_at: string | null;
    };
  } finally {
    database.close();
  }
}

function auditActions(dataDir: string): { action: string; actor_kind: string; detail: string }[] {
  const database = openDatabase({ path: databasePathOf(dataDir) });
  try {
    return database.sqlite
      .prepare('SELECT action, actor_kind, detail FROM audit_log ORDER BY seq')
      .all() as { action: string; actor_kind: string; detail: string }[];
  } finally {
    database.close();
  }
}

describe('setup-token', () => {
  it('creates the file while setup is open, prints the token and a newline, and prints the same token again', async () => {
    const { dataDir, env } = await scene('unconfigured');
    const first = await run(['setup-token'], env);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(statSync(setupTokenPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(setupTokenPath(dataDir), 'utf8')).toBe(first.stdout);
    const second = await run(['setup-token'], env);
    expect(second.stdout).toBe(first.stdout);
  });

  it('exits 1 with a message while the state is completed, and prints no token', async () => {
    const { dataDir, env } = await scene('completed');
    const result = await run(['setup-token'], env);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('setup-reopen --confirm');
    expect(existsSync(setupTokenPath(dataDir))).toBe(false);
  });

  it('exits 1 when the server has never started (no database), 2 for an argument', async () => {
    const dir = await migratedDatabase({ setupState: false });
    dir.database.close();
    const none = await run(['setup-token'], { DATA_DIR: dir.dataDir, PUBLIC_BASE_URL: 'http://localhost:9300' });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('start the server once first');
    const usage = await run(['setup-token', '--x'], { DATA_DIR: dir.dataDir });
    expect(usage.code).toBe(2);
  });

  it('prints the environment token when SETUP_TOKEN is set, and creates no file', async () => {
    const { dataDir, env } = await scene('unconfigured');
    const value = 'env-token-0123456789-abcdefghijkl';
    const result = await run(['setup-token'], { ...env, SETUP_TOKEN: value });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${value}\n`);
    expect(existsSync(setupTokenPath(dataDir))).toBe(false);
  });
});

describe('setup-reopen', () => {
  it('without --confirm only explains and exits 1 (state unchanged)', async () => {
    const { dataDir, env } = await scene('completed');
    const result = await run(['setup-reopen'], env);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--confirm');
    expect(stateOf(dataDir).state).toBe('completed');
    expect((await run(['setup-reopen', '--yes'], env)).code).toBe(2);
  });

  it('--confirm sets in_progress, issues a new token file, audits setup.reopen as cli and prints the next steps', async () => {
    const { dataDir, env } = await scene('completed');
    const result = await run(['setup-reopen', '--confirm'], env);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('setup-token');
    expect(result.stdout).toContain('refused until the wizard has finished');
    expect(stateOf(dataDir)).toEqual({ state: 'in_progress', completed_at: null });
    expect(existsSync(setupTokenPath(dataDir))).toBe(true);
    const audit = auditActions(dataDir);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'setup.reopen', actor_kind: 'cli' });
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toEqual({ fromState: 'completed' });
    // The new token is a fresh one: it is not what a stale file held.
    expect(result.stdout).not.toContain(readFileSync(setupTokenPath(dataDir), 'utf8').trim());
  });

  it('replaces a lingering token file with a new one', async () => {
    const { dataDir, env } = await scene('awaiting_first_signin');
    writeFileSync(setupTokenPath(dataDir), 'old-token-file-content-0123456789\n');
    const result = await run(['setup-reopen', '--confirm'], env);
    expect(result.code).toBe(0);
    expect(readFileSync(setupTokenPath(dataDir), 'utf8')).not.toContain('old-token-file-content');
    expect(stateOf(dataDir).state).toBe('in_progress');
    expect(auditActions(dataDir)[0]?.detail).toContain('awaiting_first_signin');
  });

  it('refuses while SETUP_TOKEN is set (EB-37, negative: a CLI that ignores it fails) and succeeds once it is unset', async () => {
    const { dataDir, env } = await scene('completed');
    const refused = await run(['setup-reopen', '--confirm'], {
      ...env,
      SETUP_TOKEN: 'env-token-0123456789-abcdefghijkl',
    });
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('Remove the variable');
    expect(refused.stderr).not.toContain('env-token-0123456789');
    expect(stateOf(dataDir).state).toBe('completed');
    expect(auditActions(dataDir)).toHaveLength(0);

    const done = await run(['setup-reopen', '--confirm'], env);
    expect(done.code).toBe(0);
    // Only the generated file token is accepted afterwards.
    const printed = await run(['setup-token'], env);
    expect(printed.stdout).toBe(readFileSync(setupTokenPath(dataDir), 'utf8'));
  });

  it('on an open setup it says so, writes no audit entry and keeps the state', async () => {
    const { dataDir, env } = await scene('in_progress');
    const result = await run(['setup-reopen', '--confirm'], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('already open');
    expect(auditActions(dataDir)).toHaveLength(0);
    expect(stateOf(dataDir).state).toBe('in_progress');
  });
});

describe('the built cli.js', () => {
  let layout: BuiltLayout;
  beforeAll(async () => {
    layout = await buildLayout();
  }, 120_000);
  afterAll(async () => {
    await layout.remove();
  });

  it('prints the token through a real process', async () => {
    const { dataDir } = await scene('unconfigured');
    const child = spawn(process.execPath, [join(layout.dist, 'cli.js'), 'setup-token'], {
      env: { PATH: process.env.PATH ?? '', DATA_DIR: dataDir, PUBLIC_BASE_URL: 'http://localhost:9300' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe(readFileSync(setupTokenPath(dataDir), 'utf8'));
  });
});
