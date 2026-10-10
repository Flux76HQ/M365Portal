// Writes three generated malicious SVG files into a directory, so the owner can upload one by hand
// and watch it being refused or cleaned (brief acceptance criterion 10). None of them is committed:
// they come from the same generators as the hostile corpus (`hostile-corpus.ts`).
//
//   pnpm --filter @m365portal/server exec tsx test/fixtures/write-hostile.ts <directory> [--listener <origin>]
//
// The files:
//   h01-script-and-event-handlers.svg   H-01: a script element and event handlers. Expected: accepted,
//                                       rasterised, the script and the handlers gone, a warning shown.
//   h04-external-image.svg              H-04: an image that points at a URL. Expected: accepted,
//                                       rasterised, nothing fetched. By default the URL is
//                                       https://attacker.example; `--listener` points it at a server
//                                       of yours (`nc -l 8099`) to watch that nothing connects.
//   h14-xxe.svg                         H-14: an external entity that reads a file. Expected: refused
//                                       with `svg_doctype_forbidden`. The file it tries to read,
//                                       `xxe-marker.txt`, is written next to it.
//
// `e2e/tests/branding.spec.ts` uses `writeHostileFiles` by relative import.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureById, type HostileContext } from './hostile-corpus.js';

interface Selection {
  readonly fixtureId: string;
  readonly label: string;
  readonly file: string;
}

/** The three files, in the order they are written. */
export const HAND_TEST_FILES: readonly Selection[] = [
  {
    fixtureId: 'H-01',
    label: 'script-and-event-handlers',
    file: 'h01-script-and-event-handlers.svg',
  },
  { fixtureId: 'H-04', label: 'image-url', file: 'h04-external-image.svg' },
  { fixtureId: 'H-14', label: 'external-entities', file: 'h14-xxe.svg' },
];

export interface WriteHostileOptions {
  /** Where the external references of the payloads point. Default: `https://attacker.example`. */
  readonly listenerOrigin?: string;
}

/** Write the three files into `directory` (created if needed); returns their absolute paths. */
export async function writeHostileFiles(
  directory: string,
  options: WriteHostileOptions = {},
): Promise<string[]> {
  const workDir = resolve(directory);
  await mkdir(workDir, { recursive: true });
  const context: HostileContext = {
    listenerOrigin: options.listenerOrigin ?? 'https://attacker.example',
    workDir,
  };
  const written: string[] = [];
  for (const selection of HAND_TEST_FILES) {
    const fixture = fixtureById(selection.fixtureId);
    const input = fixture?.inputs.find((candidate) => candidate.label === selection.label);
    if (fixture === undefined || input?.kind !== 'upload') {
      throw new Error(`${selection.fixtureId} has no upload input "${selection.label}"`);
    }
    await fixture.prepare(context);
    const path = resolve(workDir, selection.file);
    await writeFile(path, await input.bytes(context));
    written.push(path);
  }
  return written;
}

function parseArguments(argv: readonly string[]): { directory: string; listenerOrigin?: string } {
  const rest = [...argv];
  let listenerOrigin: string | undefined;
  const flag = rest.indexOf('--listener');
  if (flag >= 0) {
    listenerOrigin = rest[flag + 1];
    if (listenerOrigin === undefined)
      throw new Error('--listener needs an origin such as http://127.0.0.1:8099');
    rest.splice(flag, 2);
  }
  const [directory, ...extra] = rest;
  if (directory === undefined || extra.length > 0) {
    throw new Error('usage: write-hostile.ts <directory> [--listener <origin>]');
  }
  return { directory, ...(listenerOrigin === undefined ? {} : { listenerOrigin }) };
}

async function main(): Promise<void> {
  const { directory, listenerOrigin } = parseArguments(process.argv.slice(2));
  const written = await writeHostileFiles(
    directory,
    listenerOrigin === undefined ? {} : { listenerOrigin },
  );
  for (const path of written) process.stdout.write(`${path}\n`);
  process.stdout.write(
    'Upload one of these under Settings, Appearance. Each must be refused (h14) or cleaned with a warning (h01, h04).\n',
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((failure: unknown) => {
    process.stderr.write(`${failure instanceof Error ? failure.message : String(failure)}\n`);
    process.exitCode = 1;
  });
}
