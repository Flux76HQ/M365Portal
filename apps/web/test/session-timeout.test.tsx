// SESSION TIMEOUT (T-B-298; FR-B-416, WCAG 2.2.1; US-B8 item 1; plan 12.4). The clock is fake.
//
// Two minutes before the idle deadline a dialog offers "Sessie verlengen"; the deadline is the last
// `X-Session-Idle-Expires` the client saw (the body of /me only seeds it). Five minutes before the
// absolute end a polite notice appears. At either end the page goes to
// /signin?error=session_expired&returnTo=<the current path>. A break-glass session never slides, so it
// shows the absolute countdown only (in its banner) and no dialog.
import { createTranslator } from '@m365portal/shared/i18n';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCountdown, secondsLeft } from '../src/features/auth/countdown';
import type { FetchFunction } from '../src/lib/api';
import { sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
import { renderApp } from './helpers/render-shell';

const en = createTranslator('en');
const nl = createTranslator('nl');

const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const MINUTE = 60_000;
const at = (offset: number): string => new Date(T0 + offset).toISOString();

beforeEach(() => {
  // Every timer is fake and time moves only when the test moves it: the boundaries are exact. The
  // queries below are therefore synchronous, after an `advance`; `findBy` and `waitFor` poll with timers.
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (milliseconds: number) => act(() => vi.advanceTimersByTimeAsync(milliseconds));

/** Lets promises and the zero-delay timers behind a `fetch` and a query finish, a few rounds deep. */
async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await advance(0);
}

/** The page is rendered and settled. */
async function ready(): Promise<HTMLElement> {
  await advance(0);
  await advance(0);
  return screen.getByRole('main');
}

function sessionOf(idleMinutes: number, absoluteMinutes: number) {
  return { idleExpiresAt: at(idleMinutes * MINUTE), expiresAt: at(absoluteMinutes * MINUTE) };
}

async function open(
  session: ReturnType<typeof sessionOf>,
  options: {
    fetch?: FetchFunction;
    language?: 'en' | 'nl';
    path?: string;
    breakGlass?: boolean;
  } = {},
) {
  const me = options.breakGlass
    ? sampleMe({ kind: 'break_glass', breakGlass: true, permissions: ['rbac:manage'], session })
    : sampleSignedInMe({ session });
  return renderApp({
    me,
    path: options.path ?? '/settings',
    language: options.language ?? 'en',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    advanceTimers: (ms) => {
      vi.advanceTimersByTime(ms);
    },
  });
}

describe('the countdown helpers', () => {
  it('writes minutes and seconds, and hours from an hour on', () => {
    expect(formatCountdown(120)).toBe('2:00');
    expect(formatCountdown(119)).toBe('1:59');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(3599)).toBe('59:59');
    expect(formatCountdown(3600)).toBe('1:00:00');
    expect(formatCountdown(-5)).toBe('0:00');
    expect(secondsLeft(10_001, 0)).toBe(11);
    expect(secondsLeft(0, 10)).toBe(0);
  });
});

describe('two minutes before the idle deadline', () => {
  it('opens a dialog with "Sessie verlengen", not a moment before', async () => {
    await open(sessionOf(30, 480));
    await ready();
    await advance(28 * MINUTE - 1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await advance(1);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName(en.t('session.idle.title'));
    expect(dialog).toHaveTextContent(en.t('session.idle.message', { time: '2:00' }));
    expect(
      within(dialog).getByRole('button', { name: en.t('session.idle.extend') }),
    ).toBeInTheDocument();
  });

  it('counts down in the dialog', async () => {
    await open(sessionOf(30, 480));
    await ready();
    await advance(28 * MINUTE + 30_000);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('1:30');
    await advance(10_000);
    expect(dialog).toHaveTextContent('1:20');
  });

  it('is in Dutch when the page is Dutch: "Sessie verlengen"', async () => {
    await open(sessionOf(30, 480), { language: 'nl' });
    await ready();
    await advance(28 * MINUTE);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Sessie verlengen' })).toBeInTheDocument();
  });

  it('extends the session with GET /api/v1/me, takes the new deadline from the header and closes', async () => {
    const calls: string[] = [];
    // Any request with a session slides it (a background refetch of /me too), so the fake server slides
    // only once the test has pressed the button; before that every request fails quietly.
    let pressed = false;
    const fetchFunction: FetchFunction = (input) => {
      if (!pressed || input !== '/api/v1/me') {
        // 404: a refusal is final, so no retry of a background query is still running when the test presses.
        return Promise.resolve(new Response('{}', { status: 404 }));
      }
      calls.push(input);
      const me = sampleSignedInMe({ session: sessionOf(30, 480) });
      return Promise.resolve(
        new Response(JSON.stringify(me), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            // The header is the deadline AFTER the request slid the session.
            'X-Session-Idle-Expires': at(28 * MINUTE + 30 * MINUTE),
          },
        }),
      );
    };
    const { store } = await open(sessionOf(30, 480), { fetch: fetchFunction });
    await ready();
    await advance(28 * MINUTE);
    await settle();
    const dialog = screen.getByRole('dialog');
    pressed = true;
    fireEvent.click(within(dialog).getByRole('button', { name: en.t('session.idle.extend') }));
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls).toEqual(['/api/v1/me']);
    expect(store.getSnapshot().idleExpiresAt).toBe(T0 + 58 * MINUTE);
    // It asks again two minutes before the new deadline.
    await advance(28 * MINUTE - 1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await advance(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('says so and stays open when the session could not be extended', async () => {
    let pressed = false;
    await open(sessionOf(30, 480), {
      fetch: () =>
        pressed
          ? Promise.reject(new TypeError('offline'))
          : Promise.resolve(new Response('{}', { status: 404 })),
    });
    await ready();
    await advance(28 * MINUTE);
    await settle();
    const dialog = screen.getByRole('dialog');
    pressed = true;
    fireEvent.click(within(dialog).getByRole('button', { name: en.t('session.idle.extend') }));
    await settle();
    expect(within(dialog).getByText(en.t('session.idle.extendFailed'))).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  it('closes by itself when other activity moves the deadline (a header seen on any response)', async () => {
    const { store } = await open(sessionOf(30, 480));
    await ready();
    await advance(28 * MINUTE);
    screen.getByRole('dialog');
    act(() => {
      store.noteIdleHeader(at(28 * MINUTE + 30 * MINUTE));
    });
    await advance(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('can be dismissed by signing out now, which asks the server and then navigates', async () => {
    const requests: string[] = [];
    const fetchFunction: FetchFunction = (input, init) => {
      requests.push(`${init?.method ?? 'GET'} ${input}`);
      if (input === '/api/v1/csrf') {
        return Promise.resolve(
          Response.json({ token: 't-1', expiresAt: '2099-01-01T00:00:00.000Z' }),
        );
      }
      return Promise.resolve(Response.json({ redirect: '/signin?signedout=1' }));
    };
    const { moves } = await open(sessionOf(30, 480), { fetch: fetchFunction });
    await ready();
    await advance(28 * MINUTE);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.t('session.idle.signOut') }));
    await advance(0);
    expect(moves).toEqual(['assign /signin?signedout=1']);
    expect(requests).toContain('POST /api/v1/auth/logout');
  });
});

describe('five minutes before the absolute end', () => {
  it('shows a polite notice, not a moment before', async () => {
    await open(sessionOf(90, 20));
    await ready();
    await advance(15 * MINUTE - 1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await advance(1);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(
      en.t('session.expiry.notice', {
        time: en.d(new Date(T0 + 20 * MINUTE), { timeStyle: 'short' }),
      }),
    );
    expect(within(notice).queryByRole('button')).not.toBeInTheDocument();
  });

  it('is in the language of the page', async () => {
    await open(sessionOf(90, 20), { language: 'nl' });
    await ready();
    await advance(15 * MINUTE);
    expect(screen.getByRole('status')).toHaveTextContent(
      nl.t('session.expiry.notice', {
        time: nl.d(new Date(T0 + 20 * MINUTE), { timeStyle: 'short' }),
      }),
    );
  });
});

describe('at expiry', () => {
  it('goes to /signin?error=session_expired&returnTo=<the current path> at the absolute end', async () => {
    const { moves } = await open(sessionOf(90, 20), { path: '/settings?tab=a' });
    await ready();
    await advance(20 * MINUTE - 1);
    expect(moves).toEqual([]);
    await advance(1);
    await advance(0);
    expect(moves).toEqual(['replace /signin?error=session_expired&returnTo=%2Fsettings%3Ftab%3Da']);
  });

  it('goes there at the idle deadline when nothing extended the session', async () => {
    const { moves } = await open(sessionOf(30, 480));
    await ready();
    await advance(30 * MINUTE);
    await advance(0);
    expect(moves).toEqual(['replace /signin?error=session_expired&returnTo=%2Fsettings']);
  });

  it('goes there once, however long the page stays open', async () => {
    const { moves } = await open(sessionOf(30, 480));
    await ready();
    await advance(60 * MINUTE);
    expect(moves).toHaveLength(1);
  });
});

describe('a break-glass session: the absolute countdown only', () => {
  it('opens no idle dialog and shows no notice, only the countdown of the banner', async () => {
    await open(sessionOf(30, 30), { breakGlass: true });
    await ready();
    await advance(28 * MINUTE + 30_000);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const timer = screen.getByRole('timer');
    expect(timer).toHaveTextContent('1:30');
  });

  it('goes to the sign-in page at the end', async () => {
    const { moves } = await open(sessionOf(30, 30), { breakGlass: true });
    await ready();
    await advance(30 * MINUTE);
    await advance(0);
    expect(moves).toEqual(['replace /signin?error=session_expired&returnTo=%2Fsettings']);
  });
});

describe('an actor without a session', () => {
  it('sets no timers: the setup actor has its own session, which the wizard handles', async () => {
    const { moves } = await renderApp({
      me: sampleMe({ kind: 'setup', setupState: 'in_progress' }),
      path: '/settings',
    });
    await ready();
    await advance(10 * 60 * MINUTE);
    expect(moves).toEqual([]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
