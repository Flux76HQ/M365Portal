// The runner of the hostile corpus (T-A-077): what is asserted after every fixture, and the two
// adapters that put a fixture through the application.
//
// After every fixture (spec Appendix A, plan 13.2):
//   1. the outcome is the one the row lists, within 5 seconds;
//   2. nothing is left in the temporary directory or in `${DATA_DIR}/branding/.tmp/`;
//   3. no payload marker appears in any byte the application stored or served;
//   4. the local listener saw no connection (FR-A-088);
//   5. the audit log holds exactly the entries the outcome calls for.
// Each of these is a function that throws, so `expectGuardFails` can prove it does.
//
// Two adapters carry a fixture to the application:
//   - `viaPipeline`: direct calls of the image pipeline, no HTTP and no audit (usable from T-A-083);
//   - `viaHttp`: real requests to a running server (from T-A-093).
// The runner does not know which one it has; it only knows a `HostileTarget`.
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProblemCode, PROBLEM_CODES } from '@m365portal/shared/problem';
import sharp from 'sharp';
import {
  containsMarker,
  type HostileContext,
  type HostileFixture,
  type HostileInput,
} from '../fixtures/hostile-corpus.js';
import type {
  AcceptedOutcome,
  ExpectedOutcome,
  SlotName,
  TransportPlan,
  UploadInput,
} from '../fixtures/hostile/types.js';
import { OUTPUT_CHUNK_TYPES, walkPng } from '../fixtures/png-chunks.js';
import type { LocalListener } from '../helpers/local-listener.js';

/** Each fixture must finish within this long (spec Appendix A). */
export const FIXTURE_BUDGET_MS = 5_000;

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

// What a run of one input looks like from outside ------------------------------------------------------------

export interface ObservedWarning {
  readonly code: string;
  readonly categories?: readonly string[];
}

export interface Observation {
  /** The HTTP status, or the status of the problem code for the pipeline. Absent: no answer came. */
  readonly status?: number;
  /** The problem code of a refusal. */
  readonly code?: string;
  readonly warnings?: readonly ObservedWarning[];
  /** The PNG the application stored for this upload. */
  readonly output?: Uint8Array;
  /** The server closed the connection. */
  readonly closed?: boolean;
  /** The result of a burst. */
  readonly burst?: {
    readonly accepted: number;
    readonly refused: Readonly<Record<string, number>>;
    readonly maxRunning?: number;
  };
  /** The organisation name as the application returns it. */
  readonly storedName?: string;
}

export interface AuditObservation {
  readonly action: string;
  readonly outcome: string;
  readonly detail?: string;
}

export interface HostileTarget {
  readonly name: 'pipeline' | 'http';
  /** Whether the target writes audit entries (the pipeline adapter calls no route, so it writes none). */
  readonly audited: boolean;
  /** Whether the target can run this input at all. */
  supports(input: HostileInput): boolean;
  run(input: HostileInput, context: HostileContext): Promise<Observation>;
  /** Every byte stored or served so far: files of the data directory, bodies of answers. */
  storedBytes(): Promise<readonly Uint8Array[]>;
  /** Text stored or served so far: audit details, answer headers and bodies. */
  storedTexts(): Promise<readonly string[]>;
  auditEntries(): Promise<readonly AuditObservation[]>;
  close(): Promise<void>;
}

// Workspace -------------------------------------------------------------------------------------------------------

export interface Workspace {
  readonly root: string;
  readonly dataDir: string;
  /** `TMPDIR` while the workspace is open: anything the pipeline leaves in "/tmp" lands here. */
  readonly tmpDir: string;
  /** `${DATA_DIR}/branding/.tmp`: temporary files of atomic writes. */
  readonly brandingTmpDir: string;
  /** Where fixtures write the marker files their payloads try to read. */
  readonly workDir: string;
  close(): Promise<void>;
}

/**
 * A private root with a data directory, a temporary directory and a work directory. While it is
 * open `TMPDIR` points at its temporary directory, so "nothing is left in /tmp" can be checked
 * exactly, without seeing the temporary files of tests that run in other processes.
 */
export async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'm365portal-hostile-'));
  const dataDir = join(root, 'data');
  const tmpDir = join(root, 'tmp');
  const workDir = join(root, 'work');
  const brandingTmpDir = join(dataDir, 'branding', '.tmp');
  await Promise.all(
    [tmpDir, workDir, brandingTmpDir].map((dir) => mkdir(dir, { recursive: true })),
  );
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmpDir;
  let closed = false;
  return {
    root,
    dataDir,
    tmpDir,
    brandingTmpDir,
    workDir,
    close: async () => {
      if (closed) return;
      closed = true;
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

// Guards ----------------------------------------------------------------------------------------------------------------

/** An observation can only carry a code the problem registry knows. */
function statusOfCode(code: string): number | undefined {
  return isProblemCode(code) ? PROBLEM_CODES[code].status : undefined;
}

function describeObservation(observation: Observation): string {
  const { output, ...rest } = observation;
  return JSON.stringify({
    ...rest,
    output: output === undefined ? undefined : `${String(output.length)} bytes`,
  });
}

export interface OutcomeInput {
  readonly observed: Observation;
  readonly expected: ExpectedOutcome;
  readonly name?: string;
}

/** Fails when what was observed is not the expected outcome (Appendix A, Expected column). */
export function assertOutcome({ observed, expected, name }: OutcomeInput): void {
  const where = name === undefined ? '' : `${name}: `;
  const fail = (why: string): never => {
    throw new Error(`${where}${why}; observed ${describeObservation(observed)}`);
  };
  switch (expected.kind) {
    case 'accepted': {
      if (observed.status !== 200 && observed.status !== 201)
        fail('expected the upload to be accepted');
      if (observed.output === undefined) fail('an accepted upload has no stored PNG');
      const optional: readonly string[] = expected.optionalWarnings ?? [];
      const required: readonly string[] = expected.warnings;
      const codes = (observed.warnings ?? [])
        .map((warning) => warning.code)
        .filter((code) => required.includes(code) || !optional.includes(code))
        .toSorted();
      const wanted = [...expected.warnings].toSorted();
      if (JSON.stringify(codes) !== JSON.stringify(wanted)) {
        fail(`expected warnings [${wanted.join(', ')}] and got [${codes.join(', ')}]`);
      }
      if (expected.categories !== undefined) {
        const reported = new Set(
          (observed.warnings ?? [])
            .filter((warning) => warning.code === 'svg_content_removed')
            .flatMap((warning) => warning.categories ?? []),
        );
        const missing = expected.categories.filter((category) => !reported.has(category));
        if (missing.length > 0) fail(`svg_content_removed does not report ${missing.join(', ')}`);
      }
      return;
    }
    case 'rejected': {
      if (observed.code !== expected.code) fail(`expected the problem ${expected.code}`);
      const status = statusOfCode(expected.code);
      if (observed.status !== undefined && observed.status !== status) {
        fail(`expected status ${String(status)} for ${expected.code}`);
      }
      return;
    }
    case 'status': {
      if (observed.status !== expected.status) fail(`expected status ${String(expected.status)}`);
      if (expected.closed === true && observed.closed !== true)
        fail('expected the connection to be closed');
      return;
    }
    case 'cutOff': {
      const cut = observed.status === undefined || observed.status === 413;
      if (!cut || observed.closed !== true)
        fail('expected the body to be cut off and the connection closed');
      return;
    }
    case 'oneOf': {
      const failures: string[] = [];
      for (const alternative of expected.outcomes) {
        try {
          assertOutcome({
            observed,
            expected: alternative,
            ...(name === undefined ? {} : { name }),
          });
          return;
        } catch (failure) {
          failures.push(failure instanceof Error ? failure.message : String(failure));
        }
      }
      throw new Error(`${where}none of the allowed outcomes happened:\n  ${failures.join('\n  ')}`);
    }
    case 'burst': {
      const burst = observed.burst;
      if (burst === undefined) return fail('expected the result of a burst');
      const refused = Object.entries(burst.refused);
      const refusedTotal = refused.reduce((sum, [, count]) => sum + count, 0);
      if (burst.accepted + refusedTotal !== expected.total)
        fail(`expected ${String(expected.total)} answers`);
      if (burst.accepted < expected.minAccepted)
        fail(`expected at least ${String(expected.minAccepted)} to be accepted`);
      const strangers = refused.filter(([code]) => code !== expected.refusedCode);
      if (strangers.length > 0) fail(`a refusal other than ${expected.refusedCode}`);
      if (burst.maxRunning !== undefined && burst.maxRunning > expected.maxRunning) {
        fail(`${String(burst.maxRunning)} jobs ran at once`);
      }
      return;
    }
    case 'storedAsText': {
      if (observed.storedName === undefined) fail('expected the stored name');
      return;
    }
  }
}

export interface PngInput {
  readonly png: Uint8Array;
  /** Chunk types allowed in the stored PNG. Default: the list of spec H-27. */
  readonly allowedChunks?: readonly string[];
  /** The largest edge the slot allows (512 for a logo, 128 for the compact variant). */
  readonly maxEdge?: number;
}

/** Fails when a stored PNG carries anything but image data (H-25, H-26, H-27, H-40). */
export function assertCleanPng({
  png,
  allowedChunks = OUTPUT_CHUNK_TYPES,
  maxEdge = 512,
}: PngInput): void {
  const walk = walkPng(png);
  if (walk.truncated) throw new Error('the stored PNG is cut off before IEND');
  if (walk.trailing.length > 0) {
    throw new Error(`the stored PNG has ${String(walk.trailing.length)} bytes after IEND`);
  }
  const unexpected = [...new Set(walk.chunks.map((chunk) => chunk.type))].filter(
    (type) => !allowedChunks.includes(type),
  );
  if (unexpected.length > 0)
    throw new Error(`the stored PNG has the chunks ${unexpected.join(', ')}`);
  const damaged = walk.chunks.filter((chunk) => !chunk.crcValid).map((chunk) => chunk.type);
  if (damaged.length > 0)
    throw new Error(`the stored PNG has chunks with a wrong CRC: ${damaged.join(', ')}`);
  const header = walk.chunks[0];
  if (header?.type !== 'IHDR') throw new Error('the stored PNG does not start with IHDR');
  const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
  const width = view.getUint32(0, false);
  const height = view.getUint32(4, false);
  if (width > maxEdge || height > maxEdge) {
    throw new Error(
      `the stored PNG is ${String(width)} by ${String(height)}, over ${String(maxEdge)}`,
    );
  }
}

export interface ShapeInput {
  readonly png: Uint8Array;
  readonly expected: AcceptedOutcome;
}

/** Fails when the stored PNG has not the size or the colours the outcome lists (H-30, H-40, H-41). */
export async function assertOutputShape({ png, expected }: ShapeInput): Promise<void> {
  if (expected.size === undefined && expected.probes === undefined) return;
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  if (expected.size !== undefined) {
    if (info.width !== expected.size.width || info.height !== expected.size.height) {
      throw new Error(
        `the stored PNG is ${String(info.width)} by ${String(info.height)}, not ${String(expected.size.width)} by ${String(expected.size.height)}`,
      );
    }
  }
  for (const probe of expected.probes ?? []) {
    const x = Math.min(info.width - 1, Math.floor(probe.x * info.width));
    const y = Math.min(info.height - 1, Math.floor(probe.y * info.height));
    const at = (y * info.width + x) * info.channels;
    const actual = [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0];
    const off = probe.rgb.findIndex(
      (channel, index) => Math.abs(channel - (actual[index] ?? 0)) > probe.tolerance,
    );
    if (off >= 0) {
      throw new Error(
        `the colour at (${String(probe.x)}, ${String(probe.y)}) is [${actual.join(', ')}], not [${probe.rgb.join(', ')}] within ${String(probe.tolerance)}`,
      );
    }
  }
}

export interface LeftoverInput {
  readonly dirs: readonly string[];
}

/** Fails when any of the directories holds an entry (a temporary file that was not removed). */
export async function assertNothingLeft({ dirs }: LeftoverInput): Promise<void> {
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    if (entries.length > 0) throw new Error(`${dir} still holds ${entries.slice(0, 5).join(', ')}`);
  }
}

export interface MarkerSearchInput {
  readonly markers: readonly string[];
  readonly bytes: readonly Uint8Array[];
  readonly texts: readonly string[];
}

/** Fails when a payload marker is in any stored or served byte or text (FR-A-087, FR-A-088). */
export function assertNoMarkers({ markers, bytes, texts }: MarkerSearchInput): void {
  for (const marker of markers) {
    const inBytes = bytes.findIndex((candidate) => containsMarker(candidate, marker));
    if (inBytes >= 0)
      throw new Error(
        `the marker "${marker}" is in stored or served bytes (item ${String(inBytes)})`,
      );
    const inText = texts.findIndex((candidate) =>
      containsMarker(Buffer.from(candidate, 'utf8'), marker),
    );
    if (inText >= 0)
      throw new Error(
        `the marker "${marker}" is in a stored or served text (item ${String(inText)})`,
      );
  }
}

/** Fails when the local listener accepted a connection (FR-A-088: zero outbound connections). */
export function assertNoConnections(
  listener: Pick<LocalListener, 'connections' | 'requestLines'>,
): void {
  const count = listener.connections();
  if (count > 0) {
    throw new Error(
      `${String(count)} connection(s) reached the local listener: ${listener.requestLines().join(' | ')}`,
    );
  }
}

export interface AuditInput {
  readonly entries: readonly AuditObservation[];
  /** `undefined`: the outcome does not say what the audit log holds, nothing is asserted. */
  readonly expected: readonly { readonly action: string; readonly outcome: string }[] | undefined;
}

/** Fails when the audit entries written for one input are not the expected ones. */
export function assertAudit({ entries, expected }: AuditInput): void {
  if (expected === undefined) return;
  const actual = entries.map((entry) => `${entry.action}:${entry.outcome}`).toSorted();
  const wanted = expected.map((entry) => `${entry.action}:${entry.outcome}`).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`audit entries [${actual.join(', ')}] are not [${wanted.join(', ')}]`);
  }
}

/** What the audit log must hold after one input, or `undefined` when the outcome does not decide it. */
export function expectedAudit(
  input: HostileInput,
  observation: Observation,
): AuditInput['expected'] {
  switch (input.kind) {
    case 'upload': {
      if (input.expected.kind === 'accepted')
        return [{ action: 'branding.asset.stage', outcome: 'success' }];
      if (input.expected.kind === 'rejected')
        return [{ action: 'branding.asset.stage', outcome: 'rejected' }];
      if (input.expected.kind === 'oneOf') {
        return [
          {
            action: 'branding.asset.stage',
            outcome:
              observation.status === 200 || observation.status === 201 ? 'success' : 'rejected',
          },
        ];
      }
      return undefined;
    }
    case 'import':
      return input.expected.kind === 'rejected'
        ? [{ action: 'branding.import', outcome: 'rejected' }]
        : undefined;
    case 'assetGet':
      return [];
    case 'orgName':
      return [{ action: 'branding.apply', outcome: 'success' }];
    case 'burst':
      return undefined;
  }
}

// The runner ---------------------------------------------------------------------------------------------------------------

export interface RunEnvironment {
  readonly listener: LocalListener;
  readonly workspace: Workspace;
  readonly context: HostileContext;
}

export interface RunInput {
  readonly fixture: HostileFixture;
  readonly target: HostileTarget;
  readonly environment: RunEnvironment;
}

/** Fails when `work` takes longer than the budget (spec Appendix A: each fixture within 5 seconds). */
export async function withinBudget<T>(
  work: Promise<T>,
  label: string,
  budgetMs: number = FIXTURE_BUDGET_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} took more than ${String(budgetMs)} ms`));
    }, budgetMs);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** The inputs of a fixture a target can run. */
export function inputsFor(
  fixture: HostileFixture,
  target: Pick<HostileTarget, 'supports'>,
): HostileInput[] {
  return fixture.inputs.filter((input) => target.supports(input));
}

/**
 * Put every input of the fixture through the target and check everything Appendix A says about the
 * outcome. Throws on the first violation, naming the fixture and the input.
 */
export async function runFixture({ fixture, target, environment }: RunInput): Promise<void> {
  const { listener, workspace, context } = environment;
  await fixture.prepare(context);
  listener.reset();
  const inputs = inputsFor(fixture, target);
  if (inputs.length === 0)
    throw new Error(`${fixture.id}: the ${target.name} target can run none of its inputs`);

  for (const input of inputs) {
    const name = `${fixture.id} (${input.label})`;
    const before = (await target.auditEntries()).length;
    const observed = await withinBudget(target.run(input, context), name);

    assertOutcome({ observed, expected: input.expected, name });
    if (observed.output !== undefined) {
      try {
        assertCleanPng({
          png: observed.output,
          ...(input.kind === 'upload' && input.slot === 'compact' ? { maxEdge: 128 } : {}),
        });
        if (input.expected.kind === 'accepted') {
          await assertOutputShape({ png: observed.output, expected: input.expected });
        }
      } catch (failure) {
        throw new Error(`${name}: ${messageOf(failure)}`, { cause: failure });
      }
    }
    if (target.audited) {
      const after = await target.auditEntries();
      try {
        assertAudit({
          entries: after.slice(before),
          expected: expectedAudit(input, observed),
        });
      } catch (failure) {
        throw new Error(`${name}: ${messageOf(failure)}`, { cause: failure });
      }
    }
  }

  try {
    await assertNothingLeft({ dirs: [workspace.tmpDir, workspace.brandingTmpDir] });
    assertNoMarkers({
      markers: [...fixture.markers, ...fixture.fileMarkers],
      bytes: await target.storedBytes(),
      texts: await target.storedTexts(),
    });
    assertNoConnections(listener);
  } catch (failure) {
    throw new Error(`${fixture.id}: ${messageOf(failure)}`, { cause: failure });
  }
}

// Adapter: the image pipeline, called directly -------------------------------------------------------------------------

/**
 * The image pipeline as the runner needs it. T-A-083 supplies the real one (the job runner over
 * the child process); a test supplies a stand-in to prove the runner itself.
 */
export interface PipelineSubject {
  /** Resolve with the processed PNG, or reject with an error that has a problem `code`. */
  process(input: { readonly bytes: Uint8Array; readonly slot: SlotName }): Promise<{
    readonly png: Uint8Array;
    readonly warnings: readonly ObservedWarning[];
  }>;
  /** The most jobs that ran at once so far (the job runner reports it), if it can tell. */
  maxRunning?(): number;
  close?(): Promise<void>;
}

/** An error carries a problem code when it has a `code` property the registry knows. */
export function problemCodeOf(failure: unknown): string | undefined {
  if (typeof failure !== 'object' || failure === null || !('code' in failure)) return undefined;
  const { code } = failure;
  return typeof code === 'string' && isProblemCode(code) ? code : undefined;
}

export function viaPipeline(subject: PipelineSubject): HostileTarget {
  const outputs: Uint8Array[] = [];

  const runOne = async (bytes: Uint8Array, slot: SlotName): Promise<Observation> => {
    try {
      const result = await subject.process({ bytes, slot });
      outputs.push(result.png);
      return { status: 201, warnings: result.warnings, output: result.png };
    } catch (failure) {
      const code = problemCodeOf(failure);
      if (code === undefined) throw failure;
      return { status: statusOfCode(code) ?? 500, code, warnings: [] };
    }
  };

  return {
    name: 'pipeline',
    audited: false,
    supports: (input) =>
      (input.kind === 'upload' && input.layer !== 'http') || input.kind === 'burst',
    run: async (input, context) => {
      if (input.kind === 'upload')
        return runOne(await input.bytes(context), input.slot ?? 'logoLight');
      if (input.kind === 'burst') {
        const images = await input.images(context);
        const results = await Promise.all(images.map((bytes) => runOne(bytes, 'logoLight')));
        const refused: Record<string, number> = {};
        let accepted = 0;
        for (const result of results) {
          if (result.output !== undefined) accepted += 1;
          else refused[result.code ?? 'unknown'] = (refused[result.code ?? 'unknown'] ?? 0) + 1;
        }
        const maxRunning = subject.maxRunning?.();
        return {
          status: 200,
          burst: { accepted, refused, ...(maxRunning === undefined ? {} : { maxRunning }) },
        };
      }
      throw new Error(`the pipeline target cannot run a ${input.kind} input`);
    },
    storedBytes: () => Promise.resolve(outputs),
    storedTexts: () => Promise.resolve([]),
    auditEntries: () => Promise.resolve([]),
    close: async () => {
      await subject.close?.();
    },
  };
}

// Adapter: real HTTP -------------------------------------------------------------------------------------------------------

export interface ServerHandle {
  /** `http://127.0.0.1:<port>`: where the socket is. */
  readonly origin: string;
  close(): Promise<void>;
}

export interface HttpTargetOptions {
  /** The server under test. */
  readonly server: ServerHandle;
  /** `PUBLIC_BASE_URL`'s origin: sent as `Origin` and as the host of `Host`. */
  readonly publicOrigin: string;
  /** A valid CSRF token for the actor (fetched with the same cookie as the requests). */
  readonly csrfToken: () => Promise<string>;
  /** The `Cookie` header of the signed-in user the requests act as (T-B-245); none: anonymous. */
  readonly cookie?: string;
  /** `DATA_DIR` of the server, to read what it stored. */
  readonly dataDir: string;
  /** Every audit entry written so far, oldest first. */
  readonly readAudit: () => Promise<readonly AuditObservation[]>;
  /** A server with a shortened `requestTimeout`, for the slow upload (H-37). */
  readonly serverFor?: (plan: TransportPlan) => Promise<ServerHandle>;
  /**
   * A distinct client address for each request (sent as `X-Forwarded-For` to a server that trusts one
   * proxy). The upload rate class allows one client 3 uploads in a burst, so a fixture of 20 simultaneous
   * uploads (H-39) can only exercise the image queue when every upload comes from another client.
   */
  readonly clientAddress?: () => string;
}

export interface HttpResult {
  readonly status: number | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: Uint8Array;
  /** The connection ended without a complete answer, or the server closed it. */
  readonly closed: boolean;
}

export interface RawRequest {
  readonly origin: string;
  readonly method: string;
  /** Sent exactly as written: no normalisation of dots or percent escapes. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly plan?: TransportPlan;
}

/** One HTTP/1.1 request over a plain socket, with the control a transport fixture needs. */
export function sendRaw(request: RawRequest): Promise<HttpResult> {
  const url = new URL(request.origin);
  const plan = request.plan;
  return new Promise<HttpResult>((resolve) => {
    const headers: Record<string, string> = { ...request.headers };
    const chunked = plan?.framing === 'chunked';
    if (request.body !== undefined && !chunked)
      headers['content-length'] = String(request.body.length);
    if (request.body !== undefined && chunked) headers['transfer-encoding'] = 'chunked';
    const chunks: Buffer[] = [];
    let status: number | undefined;
    let responseHeaders: IncomingHttpHeaders = {};
    let settled = false;
    const isSettled = (): boolean => settled;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks), closed });
    };
    const outgoing = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        method: request.method,
        path: request.path,
        headers,
        setHost: false,
      },
      (response) => {
        status = response.statusCode;
        responseHeaders = response.headers;
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => {
          finish(response.headers.connection === 'close' || !response.complete);
        });
        response.once('error', () => {
          finish(true);
        });
        response.once('close', () => {
          finish(true);
        });
      },
    );
    outgoing.on('error', () => {
      finish(true);
    });

    const body = request.body;
    if (body === undefined) {
      outgoing.end();
      return;
    }
    if (plan === undefined) {
      outgoing.end(body);
      return;
    }
    void (async () => {
      let sent = 0;
      while (sent < body.length && !isSettled() && !outgoing.destroyed) {
        if (plan.abortAfterBytes !== undefined && sent >= plan.abortAfterBytes) {
          outgoing.destroy();
          finish(true);
          return;
        }
        const end = Math.min(body.length, sent + plan.chunkBytes);
        outgoing.write(body.subarray(sent, end));
        sent = end;
        if (plan.delayMsPerChunk !== undefined) {
          await new Promise((done) => setTimeout(done, plan.delayMsPerChunk));
        } else {
          await new Promise((done) => setImmediate(done));
        }
      }
      if (!isSettled() && !outgoing.destroyed) outgoing.end();
    })();
  });
}

export interface MultipartPart {
  readonly name: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly bytes: Uint8Array;
}

/** A `multipart/form-data` body written by hand, so a hostile file name reaches the server as written. */
export function multipartBody(
  parts: readonly MultipartPart[],
  boundary = '----m365portal-hostile-7d29a3c1',
): { readonly body: Uint8Array; readonly contentType: string } {
  const pieces: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.contentType !== undefined) head += `Content-Type: ${part.contentType}\r\n`;
    pieces.push(Buffer.from(`${head}\r\n`, 'utf8'), Buffer.from(part.bytes), Buffer.from('\r\n'));
  }
  pieces.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(pieces), contentType: `multipart/form-data; boundary=${boundary}` };
}

interface UploadAnswer {
  readonly asset?: { readonly url?: string };
  readonly warnings?: readonly ObservedWarning[];
  readonly code?: string;
}

async function filesBelow(dir: string): Promise<Uint8Array[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found: Uint8Array[] = [];
  for (const name of names) {
    try {
      found.push(await readFile(join(dir, name)));
    } catch {
      // A directory (such as `.tmp`) or a file that disappeared: nothing to read.
    }
  }
  return found;
}

export function viaHttp(options: HttpTargetOptions): HostileTarget {
  const served: Uint8Array[] = [];
  const texts: string[] = [];

  const common = async (headers: Record<string, string> = {}): Promise<Record<string, string>> => ({
    host: new URL(options.publicOrigin).host,
    origin: options.publicOrigin,
    'x-csrf-token': await options.csrfToken(),
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    ...(options.clientAddress === undefined ? {} : { 'x-forwarded-for': options.clientAddress() }),
    ...headers,
  });

  const remember = (result: HttpResult): void => {
    served.push(result.body);
    texts.push(JSON.stringify(result.headers));
  };

  const parse = (result: HttpResult): UploadAnswer => {
    try {
      return JSON.parse(Buffer.from(result.body).toString('utf8')) as UploadAnswer;
    } catch {
      return {};
    }
  };

  const upload = async (
    input: UploadInput,
    context: HostileContext,
    handle: ServerHandle,
  ): Promise<Observation> => {
    const bytes = await input.bytes(context);
    const part = multipartBody([
      {
        name: 'file',
        bytes,
        filename: input.filename ?? 'upload.bin',
        contentType: input.contentType ?? 'application/octet-stream',
      },
    ]);
    const result = await sendRaw({
      origin: handle.origin,
      method: 'POST',
      path: `/api/v1/branding/assets?slot=${input.slot ?? 'logoLight'}`,
      headers: await common({ 'content-type': part.contentType }),
      body: part.body,
      ...(input.transport === undefined ? {} : { plan: input.transport }),
    });
    remember(result);
    if (result.status === undefined) return { closed: true };
    const answer = parse(result);
    if (result.status === 200 || result.status === 201) {
      const url = answer.asset?.url;
      let output: Uint8Array | undefined;
      if (url !== undefined) {
        const fetched = await sendRaw({
          origin: handle.origin,
          method: 'GET',
          path: url,
          headers: await common(),
        });
        remember(fetched);
        if (fetched.status === 200) output = fetched.body;
      }
      return {
        status: result.status,
        warnings: answer.warnings ?? [],
        ...(output === undefined ? {} : { output }),
      };
    }
    return {
      status: result.status,
      ...(answer.code === undefined ? {} : { code: answer.code }),
      closed: result.closed,
    };
  };

  return {
    name: 'http',
    audited: true,
    supports: () => true,
    run: async (input, context) => {
      switch (input.kind) {
        case 'upload': {
          const plan = input.transport;
          const handle =
            plan?.serverRequestTimeoutMs !== undefined && options.serverFor !== undefined
              ? await options.serverFor(plan)
              : options.server;
          try {
            return await upload(input, context, handle);
          } finally {
            if (handle !== options.server) await handle.close();
          }
        }
        case 'burst': {
          const images = await input.images(context);
          const results = await Promise.all(
            images.map((bytes) =>
              upload(
                {
                  kind: 'upload',
                  label: 'burst',
                  expected: input.expected,
                  bytes: () => Promise.resolve(bytes),
                },
                context,
                options.server,
              ),
            ),
          );
          const refused: Record<string, number> = {};
          let accepted = 0;
          for (const result of results) {
            if (result.output !== undefined) accepted += 1;
            else refused[result.code ?? 'unknown'] = (refused[result.code ?? 'unknown'] ?? 0) + 1;
          }
          return { status: 200, burst: { accepted, refused } };
        }
        case 'assetGet': {
          const result = await sendRaw({
            origin: options.server.origin,
            method: 'GET',
            path: input.target,
            headers: await common(),
          });
          remember(result);
          return {
            ...(result.status === undefined ? {} : { status: result.status }),
            closed: result.closed,
          };
        }
        case 'import': {
          const current = await sendRaw({
            origin: options.server.origin,
            method: 'GET',
            path: '/api/v1/branding',
            headers: await common(),
          });
          const etag = current.headers.etag ?? '"1"';
          const result = await sendRaw({
            origin: options.server.origin,
            method: 'POST',
            path: '/api/v1/branding/import?dryRun=false',
            headers: await common({ 'content-type': 'application/json', 'if-match': etag }),
            body: await input.bytes(context),
          });
          remember(result);
          const answer = parse(result);
          return {
            ...(result.status === undefined ? {} : { status: result.status }),
            ...(answer.code === undefined ? {} : { code: answer.code }),
            closed: result.closed,
          };
        }
        case 'orgName': {
          const current = await sendRaw({
            origin: options.server.origin,
            method: 'GET',
            path: '/api/v1/branding',
            headers: await common(),
          });
          const etag = current.headers.etag ?? '"1"';
          const before = JSON.parse(Buffer.from(current.body).toString('utf8')) as {
            accent?: string;
          };
          const applied = await sendRaw({
            origin: options.server.origin,
            method: 'PUT',
            path: '/api/v1/branding',
            headers: await common({ 'content-type': 'application/json', 'if-match': etag }),
            body: Buffer.from(
              JSON.stringify({
                orgName: input.name,
                accent: before.accent ?? '#0078d4',
                logos: { light: null, dark: null, compact: null },
              }),
            ),
          });
          remember(applied);
          const read = await sendRaw({
            origin: options.server.origin,
            method: 'GET',
            path: '/api/v1/branding',
            headers: await common(),
          });
          remember(read);
          const stored = JSON.parse(Buffer.from(read.body).toString('utf8')) as {
            orgName?: string;
          };
          const page = await sendRaw({
            origin: options.server.origin,
            method: 'GET',
            path: '/',
            headers: await common({ accept: 'text/html' }),
          });
          remember(page);
          const html = Buffer.from(page.body).toString('utf8');
          const leaked = input.inertCanaries.filter((canary) => html.includes(canary));
          if (leaked.length > 0) throw new Error(`the page holds ${leaked.join(', ')} unescaped`);
          return {
            ...(applied.status === undefined ? {} : { status: applied.status }),
            ...(stored.orgName === input.name ? { storedName: stored.orgName } : {}),
          };
        }
      }
    },
    storedBytes: async () => [
      // The database and its journal files sit directly in the data directory.
      ...(await filesBelow(options.dataDir)),
      ...(await filesBelow(join(options.dataDir, 'branding'))),
      ...(await filesBelow(join(options.dataDir, 'branding', '.tmp'))),
      ...served,
    ],
    storedTexts: async () => [
      ...texts,
      ...(await options.readAudit()).map(
        (entry) => `${entry.action} ${entry.outcome} ${entry.detail ?? ''}`,
      ),
    ],
    auditEntries: () => options.readAudit(),
    close: () => options.server.close(),
  };
}

/** The SHA-256 of bytes, as the application names a stored image. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Write a file below a directory, creating the directory (helper of the stand-ins in the tests). */
export async function writeBelow(dir: string, name: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), bytes);
}
