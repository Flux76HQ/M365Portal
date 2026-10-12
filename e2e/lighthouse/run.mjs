// The Lighthouse harness (T-A-330, FR-A-154, SC-A-003; baseline section 8). `pnpm lighthouse`.
//
// It starts the PRODUCTION build (apps/server/dist, which serves apps/web/dist) on free ports, runs the
// Lighthouse CLI 13.5.0 against every route of e2e/routes.ts with the mobile and the desktop preset,
// on two instances:
//   preview   PREVIEW_MODE=true, SHOWCASE=true: the instance every end-to-end spec uses, where the
//             targets of the spec apply as written (Performance, Accessibility, Best Practices >= 95,
//             LCP < 2.0 s, CLS <= 0.01).
//   default   neither: what a real deployment shows. Mobile LCP there is gated by the plan 14.3 rule
//             recorded in judge.mjs (gate note G4, OP-1), with the real numbers printed.
// A cell is measured once; ONLY a timing miss is measured again (at most three runs in all), every
// measurement is kept as an artefact, and judge.mjs decides (first run for status, payload and the
// category scores, the cleanest run for LCP and CLS). Exit code 1 when a cell fails.
//
// Usage: node e2e/lighthouse/run.mjs [--instances=preview,default] [--presets=mobile,desktop]
//                                     [--routes=/,/users] [--always-repeat] [--out=<dir>]
//   --always-repeat   measure every cell three times (the spread of a whole pass, not a gate)
// Environment: E2E_PORT (first port tried; the next one is used by the second instance; default 18080,
// so the e2e suite's own ports are not touched), CHROME_PATH (default: the Chromium of Playwright).
// Needs `pnpm build` first and Node 22.19 or newer (Lighthouse 13.5).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RUNS, formatReport, judge, needsRepeat } from './judge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, '..');
const repoRoot = join(e2eRoot, '..');
const lighthouseCli = join(e2eRoot, 'node_modules/lighthouse/cli/index.js');
const serverEntry = join(repoRoot, 'apps/server/dist/index.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = {
    instances: ['preview', 'default'],
    presets: ['mobile', 'desktop'],
    routes: null,
    always: false,
    out: join(e2eRoot, 'test-results/lighthouse'),
  };
  for (const arg of argv) {
    const [key, value = ''] = arg.split('=');
    if (key === '--instances') options.instances = value.split(',');
    else if (key === '--presets') options.presets = value.split(',');
    else if (key === '--routes') options.routes = value.split(',');
    else if (key === '--always-repeat') options.always = true;
    else if (key === '--out') options.out = value;
    else throw new Error(`unknown argument ${arg}`);
  }
  for (const name of options.instances) {
    if (!['preview', 'default'].includes(name)) throw new Error(`unknown instance ${name}`);
  }
  for (const name of options.presets) {
    if (!['mobile', 'desktop'].includes(name)) throw new Error(`unknown preset ${name}`);
  }
  return options;
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** The first port at or above E2E_PORT (default 18080) where this port and the next one are free. */
async function findPorts() {
  const raw = process.env.E2E_PORT ?? '18080';
  const base = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || base < 1024 || base > 65400) {
    throw new Error('E2E_PORT must be an integer between 1024 and 65400');
  }
  for (let port = base; port < base + 100; port += 1) {
    if ((await portFree(port)) && (await portFree(port + 1)))
      return { preview: port, default: port + 1 };
  }
  throw new Error(`no two free ports found from ${String(base)}`);
}

async function healthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function startServer(name, port, dataDir, logFile) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: `http://localhost:${String(port)}`,
    DATA_DIR: dataDir,
  };
  delete env.PREVIEW_MODE;
  delete env.SHOWCASE;
  if (name === 'preview') {
    env.PREVIEW_MODE = 'true';
    env.SHOWCASE = 'true';
  }
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  writeFileSync(logFile, `started ${name} pid ${String(child.pid)} on port ${String(port)}\n`);
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await sleep(50);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const { chromium } = await import('@playwright/test');
  return chromium.executablePath();
}

const slugOf = (route) => (route === '/' ? 'root' : route.replace(/^\//, '').replace(/\//g, '_'));

function runLighthouse({ url, preset, outputFile, chrome }) {
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { ROUTES } = await import('../routes.ts');
  const routes = options.routes ?? [...ROUTES];
  for (const file of [serverEntry, join(repoRoot, 'apps/web/dist/index.html'), lighthouseCli]) {
    if (!existsSync(file)) {
      throw new Error(
        `${file} is missing: run pnpm install and pnpm build first (Lighthouse judges the production build)`,
      );
    }
  }
  const chrome = await chromePath();
  const ports = await findPorts();
  const runDir = mkdtempSync(join(tmpdir(), 'm365portal-lighthouse-'));
  const servers = [];
  const cells = [];
  try {
    for (const name of options.instances) {
      const dataDir = join(runDir, `data-${name}`);
      mkdirSync(dataDir);
      const child = startServer(name, ports[name], dataDir, join(runDir, `server-${name}.log`));
      servers.push(child);
      const deadline = Date.now() + 30_000;
      while (!(await healthy(ports[name]))) {
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error(
            `the ${name} server did not become healthy on port ${String(ports[name])}`,
          );
        }
        await sleep(100);
      }
    }
    rmSync(options.out, { recursive: true, force: true });
    for (const instance of options.instances) {
      for (const preset of options.presets) {
        mkdirSync(join(options.out, instance, preset), { recursive: true });
        for (const route of routes) {
          const cell = { instance, preset, route, measurements: [] };
          cells.push(cell);
          const url = `http://localhost:${String(ports[instance])}${route}`;
          while (
            cell.measurements.length === 0 ||
            (cell.measurements.length < MAX_RUNS && needsRepeat(cell, { always: options.always }))
          ) {
            const run = cell.measurements.length + 1;
            const outputFile = join(
              options.out,
              instance,
              preset,
              `${slugOf(route)}-run${String(run)}.json`,
            );
            await runLighthouse({ url, preset, outputFile, chrome });
            const measurement = measurementFrom(JSON.parse(readFileSync(outputFile, 'utf8')), run);
            cell.measurements.push(measurement);
            process.stderr.write(
              `${instance} ${preset} ${route} run ${String(run)}: perf ${String(measurement.scores.performance)} ` +
                `LCP ${String(Math.round(measurement.lcpMs ?? -1))} ms\n`,
            );
          }
        }
      }
    }
  } finally {
    for (const child of servers) await stop(child);
    rmSync(runDir, { recursive: true, force: true });
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
