// Why a worker process ended, as a word of a closed list (Phase D, FR-D-107). The worker's stderr is
// never logged and never leaves the launcher: it can hold a name, an address or a tenant id. What the
// launcher keeps of it is the last few hundred characters; this file reads them with fixed patterns and
// returns ONE word of `STDERR_CLASSES` (or `auth_failed_aadsts_<digits>`), and the text is dropped.

/** The closed list of classes (the AADSTS class carries digits only: `auth_failed_aadsts_700016`). */
export const STDERR_CLASS_WORDS = [
  'none',
  'module_not_found',
  'connect_failed',
  'platform_not_supported',
  'out_of_memory',
  'filesystem_not_writable',
  'icu_missing',
  'spawn_enoent',
  'spawn_eacces',
  'spawn_failed',
  'unknown',
] as const;

export type StderrClass = (typeof STDERR_CLASS_WORDS)[number] | `auth_failed_aadsts_${string}`;

/** The most of stderr the launcher keeps (the tail: the last lines hold the reason). */
export const STDERR_TAIL_CHARS = 2048;

// The module's own error text begins with a fixed sentence that names AADSTS70011 whatever went wrong
// ("Case when Message contains:AADSTS70011 ..."): that mention is not the cause and is skipped.
const AADSTS = /(?<!contains:)AADSTS(\d{1,7})(?!\d)/g;

const RULES: readonly (readonly [RegExp, StderrClass])[] = [
  [/out ?of ?memory|cannot allocate memory|GC heap initialization failed/i, 'out_of_memory'],
  [/couldn'?t find a valid ICU package|libicu/i, 'icu_missing'],
  [/PlatformNotSupported|not supported on this platform/i, 'platform_not_supported'],
  [
    /read-only file system|permission denied|UnauthorizedAccess|access to the path/i,
    'filesystem_not_writable',
  ],
  [
    /could not load file or assembly|ModuleNotFound|module .{0,80}(?:was not loaded|not found)|no valid module file/i,
    'module_not_found',
  ],
  [
    /Error Acquiring Token|Connect-ExchangeOnline|Msal\w*Exception|unauthorized_client|invalid_client/i,
    'connect_failed',
  ],
];

/** The class of the tail of a worker's stderr. Reads the text; returns a word; keeps nothing. */
export function classifyStderr(tail: string): StderrClass {
  const text = tail.length > STDERR_TAIL_CHARS ? tail.slice(-STDERR_TAIL_CHARS) : tail;
  if (text.trim().length === 0) return 'none';
  const aad = Array.from(text.matchAll(AADSTS))[0];
  if (aad?.[1] !== undefined) return `auth_failed_aadsts_${String(Number(aad[1]))}`;
  for (const [pattern, word] of RULES) if (pattern.test(text)) return word;
  return 'unknown';
}

/** The class of a failure to start the process (Node's `error` event): the errno word only. */
export function classifySpawnError(code: unknown): StderrClass {
  if (code === 'ENOENT') return 'spawn_enoent';
  if (code === 'EACCES') return 'spawn_eacces';
  return 'spawn_failed';
}

/** A signal name as a safe word, or `other`. */
export function safeSignal(signal: unknown): string | null {
  if (signal === null || signal === undefined) return null;
  return typeof signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(signal) ? signal : 'other';
}

/** How a worker process ended; nothing in it is text of the worker. */
export interface WorkerExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderrClass: StderrClass;
}
