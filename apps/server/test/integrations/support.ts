// Test support for the Microsoft client tests (T-B-070 to T-B-084). Not a test file: Vitest runs
// `*.test.ts` only. Everything here is deterministic: no real timer, no real randomness, no sleep.
import { expect } from 'vitest';
import type { Clock, RandomSource, Scheduler } from '../../src/ports/clock.js';
import type { AppTokenProvider } from '../../src/ports/identity.js';
import {
  jsonResponse,
  type FakeTenantModule,
  type HttpMethod,
} from '../fakes/fake-tenant/index.js';
import { createFakeScheduler, type FakeScheduler } from '../helpers/fake-scheduler.js';
import { fake, testClock } from '../support/msw.js';

/** A random source that plays `floats` in order and then repeats the last one; bytes count up. */
export function sequenceRandom(floats: readonly number[] = [0]): RandomSource {
  let index = 0;
  let counter = 0;
  return {
    float() {
      const value = floats[Math.min(index, floats.length - 1)] ?? 0;
      index += 1;
      return value;
    },
    bytes(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        counter += 1;
        out[i] = counter % 256;
      }
      return out;
    },
  };
}

/** One clock, one scheduler, moved together: `elapse` is "time passes". */
export interface Time {
  readonly clock: Clock;
  readonly scheduler: FakeScheduler;
  elapse(milliseconds: number): void;
}

export function createTime(): Time {
  const scheduler = createFakeScheduler();
  return {
    clock: { now: () => testClock.nowMs() },
    scheduler,
    elapse(milliseconds) {
      testClock.advance(milliseconds);
      scheduler.advance(milliseconds);
    },
  };
}

export type SchedulerLike = Scheduler;

/** Lets the MSW round trip and pending promise chains run; nothing waits on a clock. */
export async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Attaches handlers to a promise at once, so a rejection is never unhandled while the test waits. */
export interface Tracked<T> {
  readonly promise: Promise<T>;
  readonly settled: () => boolean;
  readonly value: () => T;
  readonly error: () => unknown;
}

export function track<T>(promise: Promise<T>): Tracked<T> {
  let done = false;
  let result: T | undefined;
  let failure: unknown;
  const watched = promise.then(
    (value) => {
      done = true;
      result = value;
      return value;
    },
    (error: unknown) => {
      done = true;
      failure = error;
      throw error;
    },
  );
  watched.catch(() => undefined);
  return {
    promise: watched,
    settled: () => done,
    value: () => result as T,
    error: () => failure,
  };
}

/** The error a promise rejects with. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (failure) {
    return failure;
  }
  throw new Error('the promise was expected to reject');
}

export interface ScriptedCall {
  readonly at: number;
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  readonly body: string;
}

export type ScriptStep =
  | { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> }
  | 'hang'
  | 'crash'
  | ((call: ScriptedCall) => Response | Promise<Response>);

/**
 * Mounts one route on the shared fake that plays `steps` in order (the last repeats) and records
 * every call it receives: when (the injected clock), the headers and the body.
 */
export function mountScript(
  host: 'graph.microsoft.com' | 'outlook.office365.com' | 'login.microsoftonline.com',
  method: HttpMethod,
  path: string | RegExp,
  steps: readonly ScriptStep[],
): { readonly calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const module: FakeTenantModule = (core) => {
    core.router.add({
      host,
      method,
      path,
      mutating: method !== 'GET' && method !== 'HEAD',
      handler: async ({ request, url }) => {
        const call: ScriptedCall = {
          at: testClock.nowMs(),
          method: request.method,
          path: url.pathname,
          query: url.searchParams,
          headers: request.headers,
          body: await request.text(),
        };
        calls.push(call);
        const step = steps[Math.min(calls.length - 1, steps.length - 1)];
        if (step === undefined || step === 'hang') return new Promise<Response>(() => undefined);
        if (step === 'crash') throw new Error('crash steps are armed through fake.control');
        if (typeof step === 'function') return step(call);
        return jsonResponse(step.status, step.body ?? {}, step.headers ?? {});
      },
    });
  };
  fake.mount(module);
  return { calls };
}

export function expectOneOf<T>(value: T, allowed: readonly T[]): void {
  expect(allowed).toContain(value);
}

/** `field(body, 'error', 'code')`: a value at a path in parsed JSON, `undefined` when anything on the way is missing. */
export function field(value: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

export interface RawAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

/**
 * Sends a request to the fake tenant through global `fetch` (MSW answers it), the way a client
 * would, and parses a JSON answer. Test code only: product code goes through `JsonFetch`.
 */
export async function raw(
  method: string,
  url: string,
  options: {
    token?: string | null;
    json?: unknown;
    text?: string;
    contentType?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<RawAnswer> {
  const headers = new Headers(options.headers);
  if (options.token !== null && options.token !== undefined)
    headers.set('authorization', `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    if (options.contentType !== null)
      headers.set('content-type', options.contentType ?? 'application/json');
  } else if (options.text !== undefined) {
    body = options.text;
    if (options.contentType !== null && options.contentType !== undefined)
      headers.set('content-type', options.contentType);
  }
  const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** An `AppTokenProvider` over a fixed token string that records how it was asked. */
export function staticAppTokens(value: string | (() => string)): {
  readonly provider: AppTokenProvider;
  readonly requests: { resource: string; skipCache: boolean }[];
} {
  const requests: { resource: string; skipCache: boolean }[] = [];
  return {
    requests,
    provider: {
      get(resource, options) {
        requests.push({ resource, skipCache: options?.skipCache === true });
        const current = typeof value === 'function' ? value() : value;
        return Promise.resolve({ expiresAt: Number.MAX_SAFE_INTEGER, reveal: () => current });
      },
    },
  };
}
