// THE LOG REGION AND THE POLLING (T-B-300; FR-B-211 web half, FR-B-609; SB-19). The clock is fake.
//
// `role="log"` with polite announcements, auto-scroll only while the person is at the bottom, polling
// once per second while a run is active or the device code is shown and every two seconds in a hidden tab,
// the `after=<seq>` cursor, and lines made from catalogue keys and parameters only (never server text).
import { createTranslator, type Locale } from '@m365portal/shared/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogRegion } from '../src/features/setup/LogRegion';
import { createRunPoller, isActive } from '../src/features/setup/useRunPolling';
import { createApiClient } from '../src/lib/api';
import { createLanguageController, LanguageProvider } from '../src/lib/locale';
import { createStorage } from '../src/lib/storage';
import { sampleMe } from './helpers/boot-fixtures';
import { createMockApi } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import {
  loadAllLazyNamespaces,
  logLine,
  sampleRunStatus,
  sampleSetupState,
  sampleSnapshot,
  stepsOf,
  T0,
} from './helpers/setup-fixtures';

beforeAll(async () => {
  await loadAllLazyNamespaces();
  // The wizard is a lazy chunk of the page; with the module already loaded it resolves without a timer.
  await import('../src/features/setup/Wizard');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (milliseconds: number) => act(() => vi.advanceTimersByTimeAsync(milliseconds));
const tr = (language: Locale) => createTranslator(language);

function inLanguage(language: Locale, children: React.ReactNode) {
  const controller = createLanguageController({
    storage: createStorage(null),
    languages: [language],
    root: document.createElement('html'),
  });
  return <LanguageProvider controller={controller}>{children}</LanguageProvider>;
}

describe('LogRegion', () => {
  it('is a polite log region with a name, and says so when it is empty', () => {
    render(inLanguage('en', <LogRegion lines={[]} />));
    const log = screen.getByRole('log', { name: tr('en').t('setup.logRegion.label') });
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('aria-relevant', 'additions');
    expect(log).toHaveTextContent(tr('en').t('setup.logRegion.empty'));
  });

  for (const language of ['en', 'nl'] as const) {
    it(`renders lines from keys and parameters only, in ${language}`, () => {
      const t = tr(language);
      const lines = [
        logLine(1, 'setup.log.created', { kind: 'application', name: 'M365Portal' }),
        logLine(2, 'setup.log.step_started', { step: 'configure' }),
        logLine(3, 'setup.log.waiting_replication', { attempt: 2, max: 6, seconds: 8 }, 'warn'),
        logLine(4, 'setup.log.permanent_error', { code: 'graph_error' }, 'error'),
      ];
      render(inLanguage(language, <LogRegion lines={lines} />));
      const items = screen.getAllByRole('listitem');
      expect(items).toHaveLength(4);
      expect(items[0]).toHaveTextContent(
        t.t('setup.log.created', { kind: t.t('setup.kind.application'), name: 'M365Portal' }),
      );
      expect(items[1]).toHaveTextContent(
        t.t('setup.log.step_started', { step: t.t('setup.step.configure') }),
      );
      expect(items[2]).toHaveTextContent(
        t.t('setup.log.waiting_replication', { attempt: 2, max: 6, seconds: 8 }),
      );
      expect(items[3]).toHaveTextContent(t.t('setup.result.graph_error'));
      // The level is in words too, not colour alone.
      expect(items[2]).toHaveTextContent(t.t('setup.logLevel.warn'));
      expect(items[3]).toHaveTextContent(t.t('setup.logLevel.error'));
      expect(items[0]?.querySelector('time')).toHaveAttribute('dateTime', lines[0]?.ts);
    });
  }

  it('never shows a raw key for text the server could have written', () => {
    render(
      inLanguage(
        'en',
        <LogRegion lines={[logLine(1, 'setup.log.read', { what: 'organization' })]} />,
      ),
    );
    const item = screen.getByRole('listitem');
    expect(item.textContent).not.toContain('setup.log.');
    expect(item).toHaveTextContent('Read from Microsoft: organization.');
  });

  describe('auto-scroll', () => {
    function geometry(element: HTMLElement, height: { value: number }) {
      Object.defineProperty(element, 'scrollHeight', {
        configurable: true,
        get: () => height.value,
      });
      Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => 200 });
    }

    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        logLine(index + 1, 'setup.log.unchanged', { kind: 'application' }),
      );

    it('follows the newest line while at the bottom, and stops when the person scrolls up', () => {
      const height = { value: 1000 };
      const view = render(inLanguage('en', <LogRegion lines={many(3)} />));
      const log = screen.getByRole('log');
      geometry(log, height);
      // Start at the bottom.
      log.scrollTop = 800;
      fireEvent.scroll(log);
      height.value = 1100;
      view.rerender(inLanguage('en', <LogRegion lines={many(4)} />));
      expect(log.scrollTop).toBe(1100);

      // The person scrolls up to read: new lines no longer move the view.
      log.scrollTop = 100;
      fireEvent.scroll(log);
      height.value = 1200;
      view.rerender(inLanguage('en', <LogRegion lines={many(5)} />));
      expect(log.scrollTop).toBe(100);
      const jump = screen.getByRole('button', { name: tr('en').t('setup.logRegion.toBottom') });

      // The button brings the newest line back and the log follows again.
      fireEvent.click(jump);
      expect(log.scrollTop).toBe(1200);
      expect(
        screen.queryByRole('button', { name: tr('en').t('setup.logRegion.toBottom') }),
      ).toBeNull();
      height.value = 1300;
      view.rerender(inLanguage('en', <LogRegion lines={many(6)} />));
      expect(log.scrollTop).toBe(1300);
    });
  });

  it('says that older lines were removed', () => {
    render(
      inLanguage('en', <LogRegion lines={[logLine(1, 'setup.log.tenant_pinned')]} truncated />),
    );
    expect(screen.getByText(tr('en').t('setup.logRegion.truncated'))).toBeInTheDocument();
  });
});

describe('the run poller', () => {
  function poller(options: { visible?: () => boolean; onSettled?: () => void } = {}) {
    let snapshot = sampleSnapshot();
    const mock = createMockApi({
      // Like the server: only the lines after the cursor.
      'GET /api/v1/connection/runs/current': (call) => {
        const after = Number(call.query.get('after') ?? '0');
        return {
          ...snapshot,
          log: { ...snapshot.log, lines: snapshot.log.lines.filter((line) => line.seq > after) },
        };
      },
    });
    const api = createApiClient({ buildVersion: null, fetch: mock.fetch });
    const instance = createRunPoller({ api, ...options });
    return { instance, mock, set: (next: ReturnType<typeof sampleSnapshot>) => (snapshot = next) };
  }
  const running = (lines: ReturnType<typeof logLine>[] = [], lastSeq = 0) =>
    sampleSnapshot({
      run: sampleRunStatus({ status: 'running' }),
      log: { lines, lastSeq, hasMore: false, truncated: false },
    });

  it('asks once, and stops when nothing is going on', async () => {
    const { instance, mock } = poller();
    instance.start();
    await advance(0);
    expect(mock.callsTo('GET /api/v1/connection/runs/current')).toHaveLength(1);
    await advance(10_000);
    expect(mock.callsTo('GET /api/v1/connection/runs/current')).toHaveLength(1);
    instance.stop();
  });

  it('asks once per second while a run is active, with the cursor of the last line', async () => {
    const { instance, mock, set } = poller();
    const first = logLine(1, 'setup.log.run_started', { mode: 'continue', steps: 'connect' });
    set(running([first], 1));
    instance.start();
    await advance(0);
    await advance(1000);
    set(running([first, logLine(2, 'setup.log.step_started', { step: 'connect' })], 2));
    await advance(1000);
    await advance(1000);
    const calls = mock.callsTo('GET /api/v1/connection/runs/current');
    expect(calls.map((call) => call.query.get('after'))).toEqual(['0', '1', '1', '2']);
    // 1, 2: each line once, in order.
    expect(instance.getState().lines.map((line) => line.seq)).toEqual([1, 2]);
    instance.stop();
  });

  it('asks every two seconds in a hidden tab', async () => {
    const hidden = poller({ visible: () => false });
    hidden.set(running());
    hidden.instance.start();
    await advance(0);
    await advance(1000);
    expect(hidden.mock.callsTo('GET /api/v1/connection/runs/current')).toHaveLength(1);
    await advance(1000);
    expect(hidden.mock.callsTo('GET /api/v1/connection/runs/current')).toHaveLength(2);
    await advance(2000);
    expect(hidden.mock.callsTo('GET /api/v1/connection/runs/current')).toHaveLength(3);
    hidden.instance.stop();

    const shown = poller({ visible: () => true });
    shown.set(running());
    shown.instance.start();
    await advance(0);
    await advance(3000);
    expect(shown.mock.callsTo('GET /api/v1/connection/runs/current')).toHaveLength(4);
    shown.instance.stop();
  });

  it('keeps asking while the device code is shown, and tells the page when the run ended', async () => {
    const settled = vi.fn();
    const { instance, mock, set } = poller({ onSettled: settled });
    set(
      sampleSnapshot({
        deviceCode: {
          userCode: 'ABCD-1234',
          verificationUri: 'https://microsoft.com/devicelogin',
          expiresAt: new Date(T0 + 900_000).toISOString(),
          intervalSeconds: 5,
          state: 'waiting_for_user',
        },
      }),
    );
    instance.start();
    await advance(0);
    await advance(3000);
    expect(mock.callsTo('GET /api/v1/connection/runs/current').length).toBe(4);
    expect(settled).not.toHaveBeenCalled();
    set(
      sampleSnapshot({
        run: sampleRunStatus({ status: 'succeeded', finishedAt: new Date(T0).toISOString() }),
      }),
    );
    await advance(1000);
    expect(settled).toHaveBeenCalledTimes(1);
    await advance(5000);
    expect(mock.callsTo('GET /api/v1/connection/runs/current').length).toBe(5);
    instance.stop();
  });

  it('wakes up on poke after it had stopped', async () => {
    const { instance, mock, set } = poller();
    instance.start();
    await advance(0);
    set(running());
    instance.poke();
    await advance(0);
    await advance(1000);
    expect(mock.callsTo('GET /api/v1/connection/runs/current').length).toBe(3);
    instance.stop();
  });

  it('counts a waiting run and an adoption prompt as active', () => {
    expect(isActive(sampleSnapshot({ run: sampleRunStatus({ status: 'waiting' }) }))).toBe(true);
    expect(
      isActive(
        sampleSnapshot({
          run: sampleRunStatus({ status: 'failed', finishedAt: new Date(T0).toISOString() }),
        }),
      ),
    ).toBe(false);
    expect(isActive(null)).toBe(false);
  });
});

describe('in the wizard', () => {
  it('shows the lines of a running run in the log, polling once per second', async () => {
    const steps = stepsOf({ environment: 'succeeded', connect: 'running' });
    const first = logLine(1, 'setup.log.run_started', { mode: 'continue', steps: 'connect' });
    let snapshot = sampleSnapshot({
      steps,
      run: sampleRunStatus({ status: 'running' }),
      log: { lines: [first], lastSeq: 1, hasMore: false, truncated: false },
    });
    const api = createMockApi({
      'GET /api/v1/setup/status': () => ({ state: 'in_progress', tokenRequired: false }),
      'GET /api/v1/setup/state': () => sampleSetupState({ steps }),
      'GET /api/v1/connection/runs/current': () => snapshot,
    });
    await renderApp({
      me: sampleMe({ kind: 'setup', setupState: 'in_progress' }),
      path: '/setup',
      fetch: api.fetch,
      advanceTimers: (ms) => {
        vi.advanceTimersByTime(ms);
      },
    });
    for (let round = 0; round < 12; round += 1) await advance(0);
    // The environment step is still on screen (once, after it passed): go on without userEvent (fake timers).
    fireEvent.click(screen.getByRole('button', { name: tr('en').t('setup.continue') }));
    for (let round = 0; round < 4; round += 1) await advance(0);
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('Started: Connect to Microsoft (continue).');
    snapshot = {
      ...snapshot,
      log: {
        lines: [logLine(2, 'setup.log.bootstrap_waiting', { seconds: 30 })],
        lastSeq: 2,
        hasMore: false,
        truncated: false,
      },
    };
    await advance(1000);
    expect(log).toHaveTextContent('Waiting for the administrator to sign in at Microsoft (30 s).');
    expect(log).toHaveTextContent('Started: Connect to Microsoft (continue).');
    const polls = api.callsTo('GET /api/v1/connection/runs/current');
    expect(polls.at(-1)?.query.get('after')).toBe('1');
  });
});
