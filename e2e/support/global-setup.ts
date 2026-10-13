// Starts the e2e topology and seeds instance A (T-B-370, FR-B-708, CB17):
//
//   1. the fake tenant (E2E_PORT + 2), instance B (E2E_PORT + 1, empty) and instance A (E2E_PORT)
//   2. A is configured ONCE per run by driving the real setup API against the fake: unlock,
//      environment, the device code approved through the fake's control endpoint, configure, verify,
//      finish
//   3. the Owner signs in through the scripted browser (this completes the setup), steps up, and the
//      fixture assignments are created through the real API
//   4. one `storageState` per principal is written to the run directory
//
// A step that fails fails the whole run, loudly: a run on a half-seeded instance would fail every
// spec for a reason that is not theirs, and a spec that skips on a missing seed would hide it.
// A server already answering on one of the ports fails the run on purpose: it would serve a stale
// build.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext } from '@playwright/test';
import { ApiClient } from './api-client.js';
import { freshClientAddress } from './client-address.js';
import { expireAssignmentsOf } from './database.js';
import { fakeControl } from './fake-control.js';
import { chromiumArgs } from './microsoft-hosts.js';
import { INSTANCE_NAMES, originOf, portOf } from './ports.js';
import {
  PRINCIPAL_NAMES,
  PRINCIPALS,
  ROLE_GROUP,
  SCOPED_ASSIGNMENT,
  STORED_PRINCIPAL_NAMES,
  type PrincipalName,
} from './principals.js';
import { signInAs } from './sign-in.js';
import {
  generateRunSecrets,
  isRunning,
  makePwshShimDirectory,
  makeRunDirectory,
  makeTlsMaterial,
  repoRoot,
  spawnFakeTenant,
  spawnInstance,
  statesDir,
  stopProcess,
  writeState,
  type ServersState,
} from '../servers.js';
import { finishWizard, runWizard, unlockSetup } from './wizard-api.js';

const EMPTY_STORAGE_STATE = JSON.stringify({ cookies: [], origins: [] });
const SESSION_COOKIE = 'm365portal_session';

/** The path of the storage state file of a principal (a file with no cookie for `norole`). */
export function storageStateFile(statesDir: string, principal: PrincipalName): string {
  return join(statesDir, `${principal}.json`);
}

async function newContext(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<BrowserContext> {
  return browser.newContext({
    locale: 'en-US',
    timezoneId: 'UTC',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'x-forwarded-for': freshClientAddress() },
  });
}

async function sessionCookieOf(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies(originOf('a'))).find((c) => c.name === SESSION_COOKIE);
  if (cookie === undefined) throw new Error('the sign-in left no session cookie');
  return cookie.value;
}

/** Creates one assignment through the real API; the caller holds a stepped-up session. */
async function assign(
  api: ApiClient,
  body: {
    principalType: 'user' | 'group';
    principalId: string;
    role: string;
    expiresAt?: string;
    scope?: readonly unknown[];
  },
): Promise<void> {
  const response = await api.post('/api/v1/rbac/assignments', body);
  if (response.status !== 201) {
    throw new Error(
      `creating the assignment of ${body.role} answered ${String(response.status)}: ${response.text.slice(0, 300)}`,
    );
  }
}

async function seedInstanceA(
  state: ServersState,
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<void> {
  const secrets = state.secrets;
  const fake = fakeControl('a');

  // 2. The wizard, through the real API.
  // E2E_SABOTAGE_SEED=unlock lets the harness self-test prove that a failing seed fails the run
  // loudly (fixtures-selftest.spec.ts); nothing else reads it.
  const token =
    process.env.E2E_SABOTAGE_SEED === 'unlock'
      ? 'not-the-setup-token-of-this-run'
      : secrets.setupToken.a;
  const setupApi = await unlockSetup('a', token);
  const ended = await runWizard('a', setupApi);
  if (ended !== 'succeeded' && ended !== 'warning') {
    throw new Error(`the wizard run on instance A ended as ${ended}`);
  }
  await finishWizard(setupApi, 'en');

  // 3. The Owner signs in (the setup completes), steps up and creates the assignments.
  const admin = await newContext(browser);
  const page = await admin.newPage();
  await signInAs(page, 'owner');
  await signInAs(page, 'owner', { purpose: 'stepup' });
  const owner = new ApiClient('a', { [SESSION_COOKIE]: await sessionCookieOf(admin) });
  for (const name of PRINCIPAL_NAMES) {
    const principal = PRINCIPALS[name];
    if (name === 'owner' || principal.role === null || principal.viaGroup === true) continue;
    await assign(owner, {
      principalType: 'user',
      principalId: principal.oid,
      role: principal.role,
      // The API refuses a past expiry: the assignment is created with a future one and moved below.
      ...(name === 'expired-assignment'
        ? { expiresAt: new Date(Date.now() + 86_400_000).toISOString() }
        : {}),
    });
  }
  await assign(owner, {
    principalType: 'group',
    principalId: ROLE_GROUP.oid,
    role: ROLE_GROUP.role,
  });
  // A scoped, expiring assignment for the access page to put in words ("Mijn toegang", FR-B-514).
  await assign(owner, {
    principalType: 'user',
    principalId: PRINCIPALS.operator.oid,
    role: SCOPED_ASSIGNMENT.role,
    scope: SCOPED_ASSIGNMENT.scope,
    expiresAt: new Date(Date.now() + SCOPED_ASSIGNMENT.days * 86_400_000).toISOString(),
  });
  await admin.close();

  // 4. One storage state per principal, from a sign-in of their own.
  for (const name of STORED_PRINCIPAL_NAMES) {
    const file = storageStateFile(statesDir(), name);
    if (name === 'norole') {
      // A Global Administrator without a role gets no session (OV-15): the state holds no cookie.
      writeFileSync(file, EMPTY_STORAGE_STATE);
      continue;
    }
    const context = await newContext(browser);
    await signInAs(await context.newPage(), name);
    await context.storageState({ path: file });
    await context.close();
  }

  // The expiry of `expired-assignment` moves into the past directly in the database: the session
  // stays, the rights are gone (documented in fixtures-selftest.spec.ts).
  if (expireAssignmentsOf(state.instances.a.dataDir, PRINCIPALS['expired-assignment'].oid) !== 1) {
    throw new Error('the expired assignment was not found in the database');
  }
  await fake.clearCalls();
}

/** The last lines of each server log, for the failure message of a start that did not work. */
function tailOfLogs(logDir: string): string {
  if (!existsSync(logDir)) return '';
  return readdirSync(logDir)
    .map((file) => {
      const lines = readFileSync(join(logDir, file), 'utf8').trim().split('\n').slice(-25);
      return `--- ${file} (last ${String(lines.length)} lines)\n${lines.join('\n')}\n`;
    })
    .join('');
}

export default async function globalSetup(): Promise<void> {
  for (const output of ['apps/server/dist/index.js', 'apps/web/dist/index.html']) {
    if (!existsSync(join(repoRoot, output))) {
      throw new Error(
        `${output} is missing: run pnpm build first (the e2e tests need the production build)`,
      );
    }
  }
  for (const name of ['a', 'b', 'fake'] as const) {
    if (await isRunning(name)) {
      throw new Error(
        `port ${String(portOf(name))} already answers: stop that server or set E2E_PORT (the topology needs E2E_PORT to E2E_PORT + 4)`,
      );
    }
  }

  const runDir = makeRunDirectory();
  const logDir = join(runDir, 'logs');
  makePwshShimDirectory(runDir);
  const state: ServersState = {
    runDir,
    tls: makeTlsMaterial(runDir),
    secrets: generateRunSecrets(),
    instances: {
      a: { port: portOf('a'), dataDir: join(runDir, 'data-a'), pid: 0 },
      b: { port: portOf('b'), dataDir: join(runDir, 'data-b'), pid: 0 },
    },
    fakePid: 0,
  };
  for (const name of INSTANCE_NAMES) mkdirSync(state.instances[name].dataDir);
  writeState(state);

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    state.fakePid = await spawnFakeTenant(logDir, state.tls);
    writeState(state);
    for (const name of INSTANCE_NAMES) {
      state.instances[name].pid = await spawnInstance(
        name,
        state.instances[name].dataDir,
        logDir,
        {},
        state.secrets,
      );
      writeState(state);
    }
    browser = await chromium.launch({ args: chromiumArgs() });
    await seedInstanceA(state, browser);
  } catch (error) {
    await browser?.close();
    for (const pid of [state.fakePid, ...INSTANCE_NAMES.map((name) => state.instances[name].pid)]) {
      if (pid > 0) await stopProcess(pid);
    }
    // The run directory goes; what the servers logged is the only thing worth keeping, as text.
    process.stderr.write(tailOfLogs(logDir));
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
  await browser.close();
}
