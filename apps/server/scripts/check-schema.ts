// `pnpm schema:check` (FR-A-062): the two CI steps "Schema snapshot check" and "Schema drift check",
// runnable by a developer before pushing. Every failure ends with the exact command that fixes it.
//
//   snapshot check   the journal is well formed; `migrations.json` equals the migration files; the
//                    committed snapshot of every schema version exists and regenerates byte for byte
//                    from the migrations; no snapshot is left over for a migration that is gone
//   released entries (`--base-ref <ref>`) every entry of `migrations.json` on the base ref is still
//                    there, unchanged: a migration that was merged is never edited (data-model 8.1)
//   drift check      `drizzle-kit generate` into a clean copy of `drizzle/` produces no new file, so
//                    `src/db/schema.ts` and the migrations still describe the same schema
//
// Options: `--package-dir <dir>` (default: this package), `--no-drift` (skip the drift check, which
// needs drizzle-kit), `--base-ref <git ref>`.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManifest,
  buildSnapshots,
  defaultPaths,
  journalProblems,
  MANIFEST_FILE_NAME,
  ManifestSchema,
  packageDirFromArguments,
  renderManifest,
  type ManifestEntry,
  type SchemaPaths,
} from './schema-snapshot.js';

export const SNAPSHOT_COMMAND = 'pnpm schema:snapshot';
export const GENERATE_COMMAND =
  'pnpm --filter @m365portal/server exec drizzle-kit generate --name <what_changed>';
export const RESTORE_COMMAND =
  'git checkout origin/main -- apps/server/drizzle apps/server/schema-snapshots';

export interface SchemaCheckResult {
  readonly problems: readonly string[];
  /** The one command that resolves the problems, or `undefined` when there are none. */
  readonly fix: string | undefined;
}

const OK: SchemaCheckResult = { problems: [], fix: undefined };

/** A failed check, with the message a person reads: the problems, then `Run: <command>`. */
export class SchemaCheckError extends Error {
  readonly result: SchemaCheckResult;

  constructor(result: SchemaCheckResult) {
    super(formatFailure(result));
    this.name = 'SchemaCheckError';
    this.result = result;
  }
}

export function formatFailure(result: SchemaCheckResult): string {
  const lines = result.problems.map((problem) => `- ${problem}`);
  return result.fix === undefined ? lines.join('\n') : `${lines.join('\n')}\nRun: ${result.fix}`;
}

function failed(problems: readonly string[], fix: string): SchemaCheckResult {
  return { problems, fix };
}

// ---------------------------------------------------------------------------------------------
// Snapshot check
// ---------------------------------------------------------------------------------------------

function manifestProblems(paths: SchemaPaths, built: readonly ManifestEntry[]): string[] {
  const file = join(paths.snapshotsFolder, MANIFEST_FILE_NAME);
  if (!existsSync(file)) return [`schema-snapshots/${MANIFEST_FILE_NAME} is missing`];

  const text = readFileSync(file, 'utf8');
  let committed: readonly ManifestEntry[];
  try {
    committed = ManifestSchema.parse(JSON.parse(text)).migrations;
  } catch {
    return [`schema-snapshots/${MANIFEST_FILE_NAME} is not valid JSON of the expected shape`];
  }

  const problems: string[] = [];
  for (const entry of built) {
    const listed = committed.find((candidate) => candidate.tag === entry.tag);
    if (listed === undefined) {
      problems.push(`${MANIFEST_FILE_NAME} has no entry for ${entry.tag}`);
    } else if (listed.sha256 !== entry.sha256) {
      problems.push(
        `${MANIFEST_FILE_NAME}: ${entry.tag} has sha256 ${listed.sha256} but the file hashes to ${entry.sha256} (the migration was edited)`,
      );
    } else if (listed.schemaVersion !== entry.schemaVersion) {
      problems.push(`${MANIFEST_FILE_NAME}: ${entry.tag} has the wrong schema version`);
    }
  }
  for (const listed of committed) {
    if (!built.some((entry) => entry.tag === listed.tag)) {
      problems.push(`${MANIFEST_FILE_NAME} lists ${listed.tag}, which has no migration`);
    }
  }
  if (problems.length === 0 && text !== renderManifest(built)) {
    problems.push(`${MANIFEST_FILE_NAME} differs from what ${SNAPSHOT_COMMAND} writes`);
  }
  return problems;
}

function snapshotProblems(paths: SchemaPaths): string[] {
  const problems: string[] = [];
  let regenerated: Map<string, string>;
  try {
    regenerated = buildSnapshots(paths.migrationsFolder);
  } catch (error) {
    return [
      `the migrations cannot be applied to an empty database: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  for (const [name, text] of regenerated) {
    const file = join(paths.snapshotsFolder, name);
    if (!existsSync(file)) {
      problems.push(
        `schema-snapshots/${name} is missing (every schema version needs its snapshot)`,
      );
    } else if (readFileSync(file, 'utf8') !== text) {
      problems.push(`schema-snapshots/${name} differs from the schema the migrations produce`);
    }
  }
  if (existsSync(paths.snapshotsFolder)) {
    for (const name of readdirSync(paths.snapshotsFolder)
      .filter((file) => file.endsWith('.sql'))
      .sort()) {
      if (!regenerated.has(name)) problems.push(`schema-snapshots/${name} has no migration`);
    }
  }
  return problems;
}

/** The snapshot check: journal, manifest and the snapshot of every version. No drizzle-kit needed. */
export function checkSnapshots(paths: SchemaPaths): SchemaCheckResult {
  const journal = journalProblems(paths.migrationsFolder);
  if (journal.length > 0) {
    return failed(
      [
        ...journal,
        'a migration that was merged is never edited: restore the folder and make the change a new migration',
      ],
      RESTORE_COMMAND,
    );
  }

  const problems = [
    ...manifestProblems(paths, buildManifest(paths.migrationsFolder)),
    ...snapshotProblems(paths),
  ];
  return problems.length === 0 ? OK : failed(problems, SNAPSHOT_COMMAND);
}

/** Throws a `SchemaCheckError` unless the committed files are current. */
export function assertSchemaCurrent(paths: SchemaPaths): void {
  const result = checkSnapshots(paths);
  if (result.problems.length > 0) throw new SchemaCheckError(result);
}

// ---------------------------------------------------------------------------------------------
// Released entries
// ---------------------------------------------------------------------------------------------

/**
 * Entries that were on the base ref and are no longer there unchanged. A new entry is the normal
 * case and is not a problem; a changed hash, a different tag at that position or a missing entry is.
 */
export function checkReleasedEntries(
  base: readonly ManifestEntry[],
  current: readonly ManifestEntry[],
): string[] {
  const problems: string[] = [];
  for (const released of base) {
    const now = current.find((entry) => entry.tag === released.tag);
    if (now === undefined) {
      problems.push(`${released.tag} was released and is missing now (renamed or removed)`);
    } else if (now.sha256 !== released.sha256) {
      problems.push(`${released.tag} was released and has been edited (its sha256 changed)`);
    } else if (now.schemaVersion !== released.schemaVersion) {
      problems.push(`${released.tag} was released and its schema version changed`);
    }
  }
  return problems;
}

/** The manifest of `ref`, or `undefined` when that ref has none yet (before the first release). */
function manifestAt(packageDir: string, ref: string): readonly ManifestEntry[] | undefined {
  const run = spawnSync(
    'git',
    ['show', `${ref}:apps/server/schema-snapshots/${MANIFEST_FILE_NAME}`],
    {
      cwd: packageDir,
      encoding: 'utf8',
    },
  );
  if (run.status !== 0) return undefined;
  return ManifestSchema.parse(JSON.parse(run.stdout)).migrations;
}

// ---------------------------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------------------------

export interface DriftOptions {
  readonly packageDir: string;
  /** The schema to check. Default: `<packageDir>/src/db/schema.ts`. A test passes a changed copy. */
  readonly schemaFile?: string;
}

/** What drizzle-kit prints when the schema and the migrations agree (the emoji is not matched). */
const NO_CHANGES_MESSAGE = 'No schema changes, nothing to migrate';

function sqlFilesIn(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * `drizzle-kit generate` into a clean copy of the migrations folder; any new file means the schema
 * has changed without a migration. The real folder is never written. The flags mirror
 * `drizzle.config.ts`; if the config gains an option that changes the output, mirror it here (the
 * test of this check fails at once, as a drift that is not one).
 */
export function checkDrift(options: DriftOptions): SchemaCheckResult {
  const packageDir = resolve(options.packageDir);
  const schemaFile = resolve(options.schemaFile ?? join(packageDir, 'src', 'db', 'schema.ts'));
  const scratch = mkdtempSync(join(tmpdir(), 'm365portal-drift-'));
  const out = join(scratch, 'drizzle');
  try {
    cpSync(join(packageDir, 'drizzle'), out, { recursive: true });
    const before = sqlFilesIn(out);

    // drizzle-kit reads `--out` as a path relative to the working directory (an absolute path gets a
    // "./" put in front of it and the existing migrations are not found), so the copy is the
    // working directory and the folder is called `drizzle` in it. Its exit code is 0 even when it
    // fails, so the verdict comes from what it printed and from the files it wrote.
    const run = spawnSync(
      process.execPath,
      [
        join(packageDir, 'node_modules', 'drizzle-kit', 'bin.cjs'),
        'generate',
        '--dialect',
        'sqlite',
        '--schema',
        schemaFile,
        '--out',
        'drizzle',
        '--name',
        'drift_probe',
      ],
      {
        cwd: scratch,
        encoding: 'utf8',
        timeout: 60_000,
        // A changed copy of the schema lives outside the package and still has to find drizzle-orm.
        env: { ...process.env, NODE_PATH: join(packageDir, 'node_modules') },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const output = `${run.stdout}${run.stderr}`;

    const created = sqlFilesIn(out).filter((name) => !before.includes(name));
    if (created.length > 0) {
      return failed(
        [
          `src/db/schema.ts has changed without a migration: drizzle-kit generate would write ${created.join(', ')}`,
        ],
        GENERATE_COMMAND,
      );
    }
    if (run.status === 0 && output.includes(NO_CHANGES_MESSAGE)) return OK;

    const tail = output.trim().split('\n').slice(-6).join(' | ');
    return failed(
      [`drizzle-kit generate did not report "${NO_CHANGES_MESSAGE}" (${tail})`],
      GENERATE_COMMAND,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Everything, as the command line runs it
// ---------------------------------------------------------------------------------------------

export interface CheckOptions {
  readonly packageDir: string;
  readonly drift: boolean;
  readonly baseRef?: string;
}

/** Snapshot check, then (optionally) released entries, then drift: the first failing group wins. */
export function checkSchema(options: CheckOptions): SchemaCheckResult {
  const paths = defaultPaths(options.packageDir);

  const snapshots = checkSnapshots(paths);
  if (snapshots.problems.length > 0) return snapshots;

  if (options.baseRef !== undefined) {
    const base = manifestAt(options.packageDir, options.baseRef);
    const problems =
      base === undefined ? [] : checkReleasedEntries(base, buildManifest(paths.migrationsFolder));
    if (problems.length > 0) return failed(problems, RESTORE_COMMAND);
  }

  return options.drift ? checkDrift({ packageDir: options.packageDir }) : OK;
}

function main(argv: readonly string[]): number {
  const baseAt = argv.indexOf('--base-ref');
  const baseRef = baseAt >= 0 ? argv[baseAt + 1] : undefined;
  const result = checkSchema({
    packageDir: packageDirFromArguments(argv),
    drift: !argv.includes('--no-drift'),
    ...(baseRef === undefined ? {} : { baseRef }),
  });
  if (result.problems.length === 0) {
    process.stdout.write('schema:check ok\n');
    return 0;
  }
  process.stderr.write(`schema:check failed\n${formatFailure(result)}\n`);
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
