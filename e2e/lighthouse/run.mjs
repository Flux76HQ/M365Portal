// The Lighthouse harness (T-A-330, T-B-380, FR-A-154, SC-A-003; baseline section 8). `pnpm lighthouse`.
//
// It starts the e2e topology (e2e/lighthouse/topology.ts runs the e2e global setup: the fake tenant,
// instance A configured, instance B empty, the Owner signed in), runs the Lighthouse CLI 13.5.0 with
// the mobile and the desktop preset against the PRODUCTION build, in three groups:
//   a-public  A, no session: /signin, /no-access?reason=no_role and /break-glass. (An unknown path is not
//             here: an anonymous visitor is sent to /signin before the Not-found page can show, FR-B-607,
//             so the harness would measure the sign-in page under another name. It is measured in a-owner.)
//   b-setup   B, unconfigured: the token form of /setup.
//             Both groups are GATED with the targets of the spec (Performance, Accessibility, Best
//             Practices >= 95, LCP < 2.0 s, CLS <= 0.01).
//   a-owner   A with the Owner's session cookie (sent as a header): every signed-in page. REPORTED,
//             not gated: the numbers are printed and kept, a miss is a note and never a failure.
//             Phase C (FR-C-508): the directory is seeded (1,200 users, 150 groups), so /users and /groups
//             show a full page, and the pages of one user and of one Microsoft 365 group are in the list
//             (/users/<id>, /groups/<id>). All four are REPORTED, none is gated.
//             Phase D (FR-D-904): the fake Exchange (InvokeCommand on the fake tenant) holds its standard seed, so
//             /distribution-lists and /contacts show rows, and /distribution-lists/<id> and /contacts/<id>
//             are measured ONCE each (reported). Four more cells in a pass, about a minute.
// A cell is measured once; ONLY a timing miss is measured again (at most three runs in all), every
// measurement is kept as an artefact, and judge.mjs decides (first run for status, payload and the
// category scores, the cleanest run for LCP and CLS). Exit code 1 when a gated cell fails.
//
// Usage: node e2e/lighthouse/run.mjs [--groups=a-public,b-setup,a-owner] [--presets=mobile,desktop]
//                                     [--routes=/signin,/users] [--always-repeat] [--out=<dir>]
//   --always-repeat   measure every cell three times (the spread of a whole pass, not a gate)
// Environment: E2E_PORT (first of five ports; default 18080, so the e2e suite's own ports are not
// touched), CHROME_PATH (default: the Chromium of Playwright). Needs `pnpm build` first, openssl and
// Node 22.19 or newer (Lighthouse 13.5).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RUNS, formatReport, judge, needsRepeat } from './judge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, '..');
const repoRoot = join(e2eRoot, '..');
const lighthouseCli = join(e2eRoot, 'node_modules/lighthouse/cli/index.js');
const serverEntry = join(repoRoot, 'apps/server/dist/index.js');
const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const GROUPS = ['a-public', 'b-setup', 'a-owner'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = {
    groups: [...GROUPS],
    presets: ['mobile', 'desktop'],
    routes: null,
    always: false,
    out: join(e2eRoot, 'test-results/lighthouse'),
  };
  for (const arg of argv) {
    const [key, value = ''] = arg.split('=');
    if (key === '--groups') options.groups = value.split(',');
    else if (key === '--presets') options.presets = value.split(',');
    else if (key === '--routes') options.routes = value.split(',');
    else if (key === '--always-repeat') options.always = true;
    else if (key === '--out') options.out = value;
    else throw new Error(`unknown argument ${arg}`);
  }
  for (const name of options.groups) {
    if (!GROUPS.includes(name)) throw new Error(`unknown group ${name}`);
  }
  for (const name of options.presets) {
    if (!['mobile', 'desktop'].includes(name)) throw new Error(`unknown preset ${name}`);
  }
  return options;
}

/** Starts the e2e topology; resolves with its origins and the Owner's cookie header. */
function startTopology() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, join(here, 'topology.ts')], {
      cwd: repoRoot,
      env: { ...process.env, E2E_PORT: process.env.E2E_PORT ?? '18080' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      const line = out.split('\n')[0];
      if (out.includes('\n')) resolve({ child, ...JSON.parse(line) });
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(
        new Error(
          `the topology ended with ${String(code)} before it was ready: ${err.slice(-1500)}`,
        ),
      );
    });
  });
}

async function stopTopology(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await sleep(100);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const { chromium } = await import('@playwright/test');
  return chromium.executablePath();
}

const slugOf = (route) => (route === '/' ? 'root' : route.replace(/^\//, '').replace(/\//g, '_'));

function runLighthouse({ url, preset, outputFile, chrome, headers }) {
  return new Promise((resolve, reject) => {
    const args = [
      lighthouseCli,
      url,
      '--output=json',
      `--output-path=${outputFile}`,
      '--quiet',
      '--only-categories=performance,accessibility,best-practices',
      '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage',
      ...(preset === 'desktop' ? ['--preset=desktop'] : []),
      ...(headers ? [`--extra-headers=${JSON.stringify(headers)}`] : []),
    ];
    const child = spawn(process.execPath, args, {
      env: { ...process.env, CHROME_PATH: chrome },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      // Lighthouse writes the report even for a page it could not load (runtimeError); a missing
      // file is a harness failure.
      if (existsSync(outputFile)) resolve();
      else
        reject(
          new Error(
            `lighthouse exited with ${String(code)} and wrote nothing: ${stderr.slice(-400)}`,
          ),
        );
    });
  });
}

const score = (lhr, id) => {
  const value = lhr.categories?.[id]?.score;
  return typeof value === 'number' ? Math.round(value * 100) : undefined;
};

/** The few numbers the judge needs, read from a Lighthouse result. */
export function measurementFrom(lhr, run) {
  const main = lhr.mainDocumentUrl ?? lhr.finalUrl;
  const requests = lhr.audits?.['network-requests']?.details?.items ?? [];
  const document = requests.find((item) => item.url === main) ?? requests[0] ?? {};
  let finalPath;
  try {
    finalPath = new URL(lhr.finalDisplayedUrl ?? lhr.finalUrl).pathname;
  } catch {
    finalPath = undefined;
  }
  const value = (id) => lhr.audits?.[id]?.numericValue;
  const lcpNode =
    lhr.audits?.['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node;
  return {
    run,
    status: document.statusCode,
    mimeType: document.mimeType ?? '',
    finalPath,
    runtimeError: lhr.runtimeError?.code ?? null,
    scores: {
      performance: score(lhr, 'performance'),
      accessibility: score(lhr, 'accessibility'),
      bestPractices: score(lhr, 'best-practices'),
    },
    lcpMs: value('largest-contentful-paint'),
    cls: value('cumulative-layout-shift'),
    fcpMs: value('first-contentful-paint'),
    tbtMs: value('total-blocking-time'),
    lcpElement: lcpNode?.snippet ?? null,
  };
}

/** The cells of each group: [path, query]. The paths are the ones of e2e/routes.ts. */
function groupsOf(topology, routesOf) {
  const signedIn = routesOf.filter(
    (route) => !['/signin', '/setup', '/break-glass', '/no-access'].includes(route),
  );
  // The detail pages of Phase C have the address of a seeded row; the topology tells which (FR-C-508).
  const directoryPages = [
    topology.directory?.user ? [`/users/${topology.directory.user}`, ''] : null,
    topology.directory?.group ? [`/groups/${topology.directory.group}`, ''] : null,
    // Phase D (FR-D-904): one list with its members and one contact with its lists, ONE run each (a third
    // element says so): the two detail pages add four measurements to a pass, not twelve.
    topology.directory?.list
      ? [`/distribution-lists/${topology.directory.list}`, '', { once: true }]
      : null,
    topology.directory?.contact
      ? [`/contacts/${topology.directory.contact}`, '', { once: true }]
      : null,
  ].filter((page) => page !== null);
  return {
    'a-public': {
      origin: topology.a,
      gated: true,
      pages: [
        ['/signin', ''],
        ['/no-access', '?reason=no_role'],
        ['/break-glass', ''],
      ],
    },
    'b-setup': { origin: topology.b, gated: true, pages: [['/setup', '']] },
    'a-owner': {
      origin: topology.a,
      gated: false,
      headers: { Cookie: topology.ownerCookie },
      pages: [...signedIn.map((route) => [route, '']), ...directoryPages],
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { ROUTES } = await import('../routes.ts');
  for (const file of [
    serverEntry,
    join(repoRoot, 'apps/web/dist/index.html'),
    lighthouseCli,
    tsxCli,
  ]) {
    if (!existsSync(file)) {
      throw new Error(
        `${file} is missing: run pnpm install and pnpm build first (Lighthouse judges the production build)`,
      );
    }
  }
  const chrome = await chromePath();
  const topology = await startTopology();
  const groups = groupsOf(topology, [...ROUTES]);
  const cells = [];
  try {
    rmSync(options.out, { recursive: true, force: true });
    for (const name of options.groups) {
      const group = groups[name];
      for (const preset of options.presets) {
        mkdirSync(join(options.out, name, preset), { recursive: true });
        for (const [route, query, flags] of group.pages) {
          if (options.routes !== null && !options.routes.includes(route)) continue;
          const cell = {
            instance: name,
            preset,
            route,
            reportOnly: !group.gated,
            measurements: [],
          };
          cells.push(cell);
          const url = `${group.origin}${route}${query}`;
          while (
            cell.measurements.length === 0 ||
            (flags?.once !== true &&
              cell.measurements.length < MAX_RUNS &&
              needsRepeat(cell, { always: options.always }))
          ) {
            const run = cell.measurements.length + 1;
            const outputFile = join(
              options.out,
              name,
              preset,
              `${slugOf(route)}-run${String(run)}.json`,
            );
            await runLighthouse({ url, preset, outputFile, chrome, headers: group.headers });
            const measurement = measurementFrom(JSON.parse(readFileSync(outputFile, 'utf8')), run);
            cell.measurements.push(measurement);
            process.stderr.write(
              `${name} ${preset} ${route} run ${String(run)}: perf ${String(measurement.scores.performance)} ` +
                `LCP ${String(Math.round(measurement.lcpMs ?? -1))} ms\n`,
            );
          }
        }
      }
    }
  } finally {
    await stopTopology(topology.child);
  }
  const verdicts = judge(cells);
  const report = formatReport(cells, verdicts);
  writeFileSync(join(options.out, 'summary.json'), JSON.stringify({ cells, verdicts }, null, 2));
  writeFileSync(join(options.out, 'report.txt'), `${report}\n`);
  process.stdout.write(`${report}\n`);
  process.stdout.write(`artefacts: ${options.out}\n`);
  process.exitCode = verdicts.pass ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `lighthouse harness: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
