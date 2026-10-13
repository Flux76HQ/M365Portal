// How the certificate reaches the worker (Phase D, T-D-114, FR-D-103, plan 5.1).
//
// The default is in memory: the credential source hands over the certificate and the private key as
// PEM text, the session builds ONE protocol line (`connect`) from them and writes it to the stdin pipe
// of the worker. Nothing is written to a file, an argument or the environment; the worker builds the
// certificate object with `X509Certificate2.CreateFromPem` (worker-script.ps1). The PEMs are strings
// and cannot be wiped, which is why the line is built as late as possible and the source makes new
// ones for every worker (GD1-0, amendment 1: PEM in place of PKCS#12).
//
// The fallback exists for the day U75 turns out false on Linux (OV-D1): `-Certificate` with an
// in-memory object does not work, and `Connect-ExchangeOnline` needs `-CertificateFilePath`. Then the
// SCRIPT writes the PEMs to files with mode 0600 inside a directory that THIS module made for that
// one worker on a tmpfs, derives the PKCS#12 file the cmdlet wants from them (random password, also
// mode 0600), and removes every file right after the connect. This module owns what the
// script cannot: the directory is private (0700), exists only while its worker lives (removed when
// the worker ends however it ends), stale ones of an earlier process are swept before a worker
// starts, and the root must really be a tmpfs, or nothing starts and the credential is not read.
// A switch in configuration (`EXCHANGE_KEY_HANDOVER`), not a code fork.
//
// The protocol line is `connect` of `@m365portal/shared/exchange/protocol`; its certificate shape
// (`pem`: certificate and PKCS#8 key) is the contract of GD1-0 as amended.
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { posix } from 'node:path';
import { encodeLine, parseRequestLine } from '@m365portal/shared/exchange/protocol';
import type { RandomSource } from '../../../ports/clock.js';

export const CERTIFICATE_MODES = ['memory', 'tmpfs'] as const;
export type CertificateMode = (typeof CERTIFICATE_MODES)[number];

/** `memory`, `tmpfs`, or `undefined` for anything else (no trimming, no case folding). */
export function parseCertificateMode(value: string | undefined): CertificateMode | undefined {
  return CERTIFICATE_MODES.find((mode) => mode === value);
}

export interface HandoverConfig {
  readonly mode: CertificateMode;
  /** The directory that holds the per-worker scratch directories; must be on a tmpfs. Default `/dev/shm`. */
  readonly tmpfsRoot?: string;
}

export const DEFAULT_HANDOVER: HandoverConfig = Object.freeze({ mode: 'memory' });
export const DEFAULT_TMPFS_ROOT = '/dev/shm';

/** What the connection needs. The source makes a new one each time; the strings are secrets and never logged. */
export interface ExchangeCredential {
  /** The application (client) id, a lower-case GUID. */
  readonly appId: string;
  /** The primary `.onmicrosoft.com` domain of the tenant. */
  readonly organization: string;
  /** The X.509 certificate as one PEM block (`CERTIFICATE`). */
  readonly certificatePem: string;
  /** The private key as one unencrypted PKCS#8 PEM block (`PRIVATE KEY`). */
  readonly privateKeyPem: string;
}

/** Where the credential comes from (the sealed store, wired by the bootstrap). Called once per worker. */
export interface ExchangeCredentialSource {
  load(): Promise<ExchangeCredential>;
}

/**
 * The `connect` line for a credential (the string cannot be wiped, which is why it is built as late as
 * possible and handed straight to the pipe). Throws when the credential breaks the schema of the
 * protocol; the error says nothing about its content.
 */
export function buildConnectLine(id: string, credential: ExchangeCredential): string {
  const line = encodeLine({
    v: 1,
    type: 'connect',
    id,
    appId: credential.appId,
    organization: credential.organization,
    certificate: {
      format: 'pem',
      certificate: credential.certificatePem,
      privateKey: credential.privateKeyPem,
    },
  });
  if (!parseRequestLine(line).ok) throw new Error('the connect message breaks the protocol');
  return line;
}

// ---------------------------------------------------------------------------------------------
// The scratch directories of the fallback
// ---------------------------------------------------------------------------------------------

export const SCRATCH_PREFIX = 'm365portal-exo-';

/** The file system access of the fallback, and nothing else: a test replaces it by one in memory. */
export interface ScratchFileSystem {
  /** Creates a directory with mode 0700; fails when it exists. */
  makeDirectory(path: string): void;
  /** Removes a directory and what is in it; does nothing when it is gone. */
  removeTree(path: string): void;
  /** The names (not paths) of the directories directly below `root`. */
  listDirectories(root: string): string[];
  /** Is `path` on a tmpfs? */
  isTmpfs(path: string): boolean;
}

/**
 * Is `path` on a tmpfs or ramfs, according to the text of `/proc/self/mountinfo`? The mount with the
 * longest mount point that is a prefix of the path decides. Unreadable lines are skipped; no mount
 * found is `false`.
 */
export function isOnTmpfs(mountinfo: string, path: string): boolean {
  const target = posix.resolve('/', path);
  let best: { point: string; type: string } | undefined;
  for (const line of mountinfo.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(' ');
    const after = line.slice(separator + 3).split(' ');
    const rawPoint = before[4];
    const type = after[0];
    if (rawPoint === undefined || type === undefined) continue;
    // mountinfo writes a space as \040 and a tab as \011.
    const point = rawPoint.replaceAll('\\040', ' ').replaceAll('\\011', '\t');
    const covers = point === '/' || target === point || target.startsWith(`${point}/`);
    if (covers && (best === undefined || point.length >= best.point.length)) best = { point, type };
  }
  return best !== undefined && (best.type === 'tmpfs' || best.type === 'ramfs');
}

/** The real file system, on Linux. */
export const nodeScratchFileSystem: ScratchFileSystem = {
  makeDirectory(path) {
    mkdirSync(path, { mode: 0o700 });
  },
  removeTree(path) {
    rmSync(path, { recursive: true, force: true });
  },
  listDirectories(root) {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  isTmpfs(path) {
    try {
      return isOnTmpfs(readFileSync('/proc/self/mountinfo', 'utf8'), path);
    } catch {
      return false;
    }
  },
};

/** A scratch directory name is the prefix and 16 hex digits: nothing a shell or a command line could misread. */
const SCRATCH_NAME = new RegExp(`^${SCRATCH_PREFIX}[0-9a-f]{16}$`);

export interface ScratchManager {
  /** Throws unless the root is a tmpfs; sweeps the directories of an earlier process (once). */
  prepare(): void;
  /** A new private directory; returns its absolute path. */
  create(): string;
  remove(path: string): void;
}

export function createScratchManager(deps: {
  readonly fs: ScratchFileSystem;
  readonly root: string;
  readonly random: RandomSource;
}): ScratchManager {
  let swept = false;
  return {
    prepare() {
      if (!deps.fs.isTmpfs(deps.root)) throw new Error('scratch_not_tmpfs');
      if (swept) return;
      swept = true;
      for (const name of deps.fs.listDirectories(deps.root)) {
        if (SCRATCH_NAME.test(name)) deps.fs.removeTree(posix.join(deps.root, name));
      }
    },
    create() {
      const hex = Array.from(deps.random.bytes(8), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const path = posix.join(deps.root, `${SCRATCH_PREFIX}${hex}`);
      deps.fs.makeDirectory(path);
      return path;
    },
    remove(path) {
      // Only a directory this module made: the name is checked again, so a bug cannot delete anything else.
      if (posix.dirname(path) === deps.root && SCRATCH_NAME.test(posix.basename(path))) {
        deps.fs.removeTree(path);
      }
    },
  };
}
