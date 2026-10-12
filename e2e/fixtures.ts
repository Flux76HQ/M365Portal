// The fixtures every e2e spec imports instead of `@playwright/test` (FR-A-157, FR-A-042).
//
// The `guard` fixture is automatic. It watches every page of the test's browser context and makes
// the test FAIL (in the fixture teardown) on:
//   - a `securitypolicyviolation` event (CSP or Trusted Types),
//   - a `pageerror` (uncaught exception) and a `console.error`,
//   - a console warning that mentions `Permissions-Policy` (a browser upgrade that drops a feature name),
//   - a same-origin response with status 4xx or 5xx that the test did not allow,
//   - a request to another origin than the two instances (FR-A-007).
// A test that provokes one of them on purpose reads it with `guard.take(kind)`, which also removes
// it from the list that is checked at the end.
//
// The other fixture, `app`, opens pages of the two instances (A: configured, B: empty), waits until
// the app is ready and asserts what P19 and P21 of the stack probe demand: dark mode is really dark
// (computed background) and the self-hosted font is really loaded (this host has Inter installed).
//
// Phase B (T-B-370): every context starts with the storage state of a principal (`principal`, default
// `owner` on instance A; `anonymous` means none), and the three Microsoft host names resolve to the
// fake tenant (`microsoft-hosts.ts`). A Microsoft NAVIGATION is how a sign-in works and is
// allowed; a request to a Microsoft host from page scripts is a problem (FR-B-317, FR-B-606).
import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from '@playwright/test';
import { relativeLuminanceOfChannels } from '@m365portal/shared/branding/contrast';
import {
  originOf,
  resetEmptyInstance,
  restartServer,
  startServer,
  statesDir,
  takeSetupBudget,
  stopServer,
  type InstanceName,
} from './servers.js';
import { ApiClient } from './support/api-client.js';
import { freshClientAddress } from './support/client-address.js';
import { FakeControl } from './support/fake-control.js';
import { isMicrosoftUrl } from './support/microsoft-hosts.js';
import type { PrincipalName, StoredPrincipalName } from './support/principals.js';
import { signInAs, type SignInAsOptions } from './support/sign-in.js';
import { join } from 'node:path';

export { expect };
export type { InstanceName };
export type { PrincipalName, StoredPrincipalName };

export type AppTheme = 'light' | 'dark' | 'system';

/** Per-project options (playwright.config.ts). */
export interface AppOptions {
  /** The stored theme choice written before the first navigation; `system` writes nothing. */
  appTheme: AppTheme;
  /** An init script makes `localStorage` and `sessionStorage` throw (E-06). */
  blockStorage: boolean;
  /**
   * Who the context is signed in as when the test starts: the storage state global-setup wrote for
   * that principal. `anonymous` starts without cookies (`norole` has none either: no session).
   */
  principal: StoredPrincipalName | 'anonymous';
  /**
   * Send an `X-Forwarded-For` of its own so that this context is its own client (instance A trusts
   * one proxy hop; see support/client-address.ts). Specs of instance B turn it off: B trusts none.
   */
  ownClientAddress: boolean;
}

export type ProblemKind = 'violation' | 'pageerror' | 'console' | 'status' | 'origin';

export interface Problem {
  readonly kind: ProblemKind;
  readonly text: string;
  /** For `console` and `status` problems: the URL they concern. */
  readonly url?: string;
}

export interface AllowedResponse {
  readonly status?: number | readonly number[];
  readonly url?: string | RegExp;
}

export interface Guard {
  /** Everything seen so far that would fail the test. */
  readonly problems: readonly Problem[];
  /** Returns and forgets the problems of one kind (for a test that provokes them on purpose). */
  take(kind: ProblemKind): Problem[];
  /** Same-origin responses matching this are not a problem (and neither is their console line). */
  allowResponse(allowed: AllowedResponse): void;
  /** Another origin the test legitimately talks to (the foreign site of a cross-site link). */
  allowOrigin(origin: string): void;
  /** Throws when something was seen. Called by the fixture teardown. */
  assertClean(): void;
}

/** The origins the browser may talk to: the two instances and nothing else. */
export function allowedOrigins(): readonly string[] {
  return [originOf('a'), originOf('b')];
}

export const STORAGE_KEY_THEME = 'm365portal.theme';
export const STORAGE_KEY_LOCALE = 'm365portal.locale';

function describeProblems(problems: readonly Problem[]): string {
  return problems.map((p) => `  [${p.kind}] ${p.text}`).join('\n');
}

function matches(allowed: AllowedResponse, status: number, url: string): boolean {
  if (allowed.status !== undefined) {
    const list = typeof allowed.status === 'number' ? [allowed.status] : allowed.status;
    if (!list.includes(status)) return false;
  }
  if (allowed.url !== undefined) {
    if (typeof allowed.url === 'string' ? !url.includes(allowed.url) : !allowed.url.test(url)) {
      return false;
    }
  }
  return true;
}

function createGuard(context: BrowserContext): Guard {
  const problems: Problem[] = [];
  const allowed: AllowedResponse[] = [];
  const origins = new Set(allowedOrigins());

  // Reported by the init script below through a binding, so it survives navigations and workers
  // of the page are not needed.
  void context.exposeBinding('__m365Violation', (_source, text: string) => {
    problems.push({ kind: 'violation', text });
  });
  void context.addInitScript(() => {
    const report = (window as unknown as { __m365Violation?: (text: string) => void })
      .__m365Violation;
    document.addEventListener(
      'securitypolicyviolation',
      (event) => {
        report?.(
          `${event.violatedDirective} blocked ${event.blockedURI || '(inline)'} ${event.sample}`.trim(),
        );
      },
      true,
    );
  });

  context.on('weberror', (webError) => {
    problems.push({ kind: 'pageerror', text: webError.error().message });
  });
  context.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') {
      problems.push({ kind: 'console', text, url: message.location().url });
    } else if (message.type() === 'warning' && /permissions-policy/i.test(text)) {
      problems.push({ kind: 'console', text: `warning: ${text}` });
    }
  });
  context.on('response', (response) => {
    const url = response.url();
    if (!origins.has(new URL(url).origin) || response.status() < 400) return;
    problems.push({ kind: 'status', text: `${String(response.status())} ${url}`, url });
  });
  context.on('request', (request) => {
    const url = request.url();
    if (!/^https?:/.test(url)) return;
    if (isMicrosoftUrl(url)) {
      // A sign-in or a sign-out is a navigation to Microsoft and is how the product works; anything
      // else (fetch, XHR, a script, an image) is a request from page code (FR-B-317).
      if (!request.isNavigationRequest()) {
        problems.push({
          kind: 'origin',
          text: `page request to a Microsoft host: ${request.method()} ${new URL(url).origin}${new URL(url).pathname}`,
          url,
        });
      }
      return;
    }
    if (!origins.has(new URL(url).origin)) {
      problems.push({ kind: 'origin', text: `${request.method()} ${url}`, url });
    }
  });

  const isAllowed = (problem: Problem): boolean => {
    if (problem.kind === 'status') {
      const [status = '0'] = problem.text.split(' ');
      return allowed.some((a) => matches(a, Number(status), problem.url ?? ''));
    }
    if (problem.kind === 'console' && problem.text.startsWith('Failed to load resource')) {
      // The browser's own line for an allowed 4xx or 5xx response.
      const status = /status of (\d{3})/.exec(problem.text)?.[1];
      return allowed.some((a) => matches(a, Number(status ?? 0), problem.url ?? ''));
    }
    return false;
  };

  return {
    get problems() {
      return problems.filter((problem) => !isAllowed(problem));
    },
    take(kind) {
      const taken = problems.filter((p) => p.kind === kind);
      for (const p of taken) problems.splice(problems.indexOf(p), 1);
      return taken;
    },
    allowResponse(response) {
      allowed.push(response);
    },
    allowOrigin(origin) {
      origins.add(origin);
    },
    assertClean() {
      const open = problems.filter((problem) => !isAllowed(problem));
      if (open.length > 0) {
        throw new Error(`the page misbehaved (FR-A-042, FR-A-157):\n${describeProblems(open)}`);
      }
    },
  };
}

export interface GotoOptions {
  readonly instance?: InstanceName;
  /** Skip the wait for the app shell (pages that are not the app, for example the offline page). */
  readonly raw?: boolean;
}

export interface App {
  /** The origin of an instance; default A. */
  origin(instance?: InstanceName): string;
  url(path: string, instance?: InstanceName): string;
  /** Navigates and waits until the app is ready. Returns the navigation response. */
  goto(path: string, options?: GotoOptions): Promise<Response | null>;
  /** Waits for the shell, the theme (P19) and the self-hosted font (P21). */
  ready(): Promise<void>;
  /** The theme asserted against the computed background of `body` (P19). */
  expectTheme(theme: 'light' | 'dark'): Promise<void>;
  /** The instance helpers: stop, start, restart on the same DATA_DIR (V-16). */
  readonly servers: {
    stop(instance: InstanceName): Promise<void>;
    start(instance: InstanceName, env?: Record<string, string>): Promise<void>;
    restart(instance: InstanceName, env?: Record<string, string>): Promise<void>;
    /** Instance B back to empty: no data, a fresh tenant in the fake (every wizard spec starts here). */
    resetEmpty(): Promise<void>;
  };
  /** The real sign-in of a principal in this page's context (CB17). */
  signInAs(principal: PrincipalName, options?: SignInAsOptions): Promise<void>;
}

/** Relative luminance of a `rgb()` / `rgba()` / `color(srgb ...)` string, 0 (black) to 1 (white). */
export function cssColourBrightness(color: string): number {
  const numbers = (color.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  if (numbers.length < 3) throw new Error(`cannot read the colour ${color}`);
  const isSrgbFloat = color.startsWith('color(');
  const [r = 0, g = 0, b = 0] = numbers.slice(isSrgbFloat ? 1 : 0, isSrgbFloat ? 4 : 3);
  const scale = isSrgbFloat ? 255 : 1;
  return relativeLuminanceOfChannels(r * scale, g * scale, b * scale);
}

async function bodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

/**
 * After the setup is complete, `/setup` and `/api/v1/setup/status` answer 404 on purpose, byte for byte
 * like an unknown address (FR-B-206): a spec that walks every route of a configured instance expects
 * both, and nothing else.
 */
export function allowLockedSetup(guard: Guard): void {
  guard.allowResponse({ status: 404, url: /\/setup(\/|$)/ });
  guard.allowResponse({ status: 404, url: '/api/v1/setup/status' });
}

/**
 * A second browser context, signed in as another person (the specs about two people): the storage
 * state of that principal, a client address of its own and the project's locale and time zone. The
 * caller closes it. The guard watches the test's own context only.
 */
export async function contextAs(
  browser: Browser,
  principal: StoredPrincipalName | 'anonymous',
): Promise<BrowserContext> {
  return browser.newContext({
    locale: 'en-US',
    timezoneId: 'UTC',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'x-forwarded-for': freshClientAddress() },
    ...(principal === 'anonymous' ? {} : { storageState: join(statesDir(), `${principal}.json`) }),
  });
}

/** The control surface of an instance's tenant in the fake (default A): device approval, toggles, call record. */
export function fakeOf(instance: InstanceName = 'a'): FakeControl {
  return new FakeControl(instance);
}

export const test = base.extend<AppOptions & { guard: Guard; app: App }>({
  appTheme: ['light', { option: true }],
  blockStorage: [false, { option: true }],
  principal: ['owner', { option: true }],
  ownClientAddress: [true, { option: true }],

  storageState: async ({ principal }, use) => {
    await use(principal === 'anonymous' ? undefined : join(statesDir(), `${principal}.json`));
  },

  guard: [
    async ({ context }, use) => {
      const guard = createGuard(context);
      await use(guard);
      guard.assertClean();
    },
    { auto: true },
  ],

  context: async ({ context, appTheme, blockStorage, ownClientAddress }, use) => {
    if (ownClientAddress) {
      await context.setExtraHTTPHeaders({ 'x-forwarded-for': freshClientAddress() });
    }
    if (blockStorage) {
      await context.addInitScript(() => {
        for (const name of ['localStorage', 'sessionStorage'] as const) {
          Object.defineProperty(window, name, {
            configurable: true,
            get() {
              throw new DOMException('storage is blocked for this test', 'SecurityError');
            },
          });
        }
      });
    } else if (appTheme !== 'system') {
      await context.addInitScript(
        (entry: { key: string; value: string }) => {
          try {
            if (window.localStorage.getItem(entry.key) === null) {
              window.localStorage.setItem(entry.key, entry.value);
            }
          } catch {
            // storage unavailable: the app falls back to its defaults
          }
        },
        { key: STORAGE_KEY_THEME, value: appTheme },
      );
    }
    await use(context);
  },

  app: async ({ page, appTheme }, use) => {
    // Instances this test signed somebody in on: the session is ended afterwards, so that a run does
    // not pile up live sessions (a principal holds at most ten; the oldest, which may be the one in
    // the shared storage state, is evicted).
    const dynamicSignIns = new Set<InstanceName>();
    const app: App = {
      origin: (instance = 'a') => originOf(instance),
      url: (path, instance = 'a') => `${originOf(instance)}${path}`,
      async signInAs(principal, options) {
        await signInAs(page, principal, options);
        dynamicSignIns.add(options?.instance ?? 'a');
      },
      async expectTheme(theme) {
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const luminance = cssColourBrightness(await bodyBackground(page));
        if (theme === 'dark')
          expect(luminance, 'the dark theme paints a dark body').toBeLessThan(0.2);
        else expect(luminance, 'the light theme paints a light body').toBeGreaterThan(0.6);
      },
      async ready() {
        await page.locator('main').first().waitFor();
        // A long page (the showcase) mounts in parts and says so until the last part is in.
        await page.waitForFunction(
          () => document.querySelector('[data-progressive="pending"]') === null,
        );
        // P21: the host has Inter installed system-wide, so a loaded font face must be proven.
        await page.waitForFunction(() =>
          [...document.fonts].some(
            (face) => face.family.includes('Inter') && face.status === 'loaded',
          ),
        );
        if (appTheme === 'light' || appTheme === 'dark') await app.expectTheme(appTheme);
      },
      async goto(path, options = {}) {
        if (options.instance === 'b') await takeSetupBudget();
        const response = await page.goto(app.url(path, options.instance), {
          waitUntil: 'load',
        });
        if (options.raw !== true) await app.ready();
        return response;
      },
      servers: {
        stop: stopServer,
        start: startServer,
        restart: restartServer,
        resetEmpty: resetEmptyInstance,
      },
    };
    await use(app);
    for (const instance of dynamicSignIns) {
      const cookie = (await page.context().cookies(originOf(instance))).find(
        (candidate) => candidate.name === 'm365portal_session',
      );
      if (cookie === undefined) continue;
      // Best effort: the test may have signed out already (the call is then a 401 and nothing else).
      await new ApiClient(instance, { m365portal_session: cookie.value })
        .post('/api/v1/auth/logout')
        .catch(() => undefined);
    }
  },
});
