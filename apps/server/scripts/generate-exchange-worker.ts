// Writes the two files that carry the allow-list of the Exchange worker (T-D-112, PD-02):
//   apps/server/src/integrations/exchange/pwsh/worker-script.ps1        its generated block
//   apps/server/src/integrations/exchange/pwsh/generated-allow-list.ts  the two hashes
// Run it after a change to packages/shared/src/exchange/allow-list.ts or pwsh/projections.ts:
//   pnpm --filter @m365portal/server exchange:generate
// `--check` writes nothing and exits 1 when either file is out of date (the CI form).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  renderGeneratedModule,
  spliceGeneratedBlock,
} from '../src/integrations/exchange/pwsh/script-generator.js';

const directory = new URL('../src/integrations/exchange/pwsh/', import.meta.url);
const scriptPath = fileURLToPath(new URL('worker-script.ps1', directory));
const modulePath = fileURLToPath(new URL('generated-allow-list.ts', directory));

const check = process.argv.includes('--check');
const script = readFileSync(scriptPath, 'utf8');
const wanted = [
  { path: scriptPath, text: spliceGeneratedBlock(script) },
  { path: modulePath, text: renderGeneratedModule() },
];

function currentText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

let stale = false;
for (const { path, text } of wanted) {
  if (currentText(path) === text) continue;
  stale = true;
  if (check) process.stderr.write(`out of date: ${path}\n`);
  else writeFileSync(path, text);
}
if (check && stale) process.exit(1);
