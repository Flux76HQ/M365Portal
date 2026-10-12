// THE WIZARD BASE (T-B-300; FR-B-221 part, FR-B-211 web half, FR-B-609 part; US-B1, US-B2).
//
// The token form, the not-found rules, the step list and the focus rules. The UI holds no wizard state:
// everything below is built from the answers of a mocked network (test/helpers/mock-api.ts).
import { createTranslator, type Locale } from '@m365portal/shared/i18n';
import { STEP_STATUSES } from '@m365portal/shared/setup/steps';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { StepList } from '../src/features/setup/StepList';
import { RootProviders } from '../src/components/pages/root-providers';
import { sampleBranding, sampleMe } from './helpers/boot-fixtures';
import { createMockApi, problem } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import {
  loadAllLazyNamespaces,
  sampleEnvironment,
  sampleSetupState,
  sampleSnapshot,
  stepsOf,
} from './helpers/setup-fixtures';

void RootProviders;
void render;

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const tr = (language: Locale) => createTranslator(language);

const STATUS: Record<string, unknown> = { state: 'in_progress', tokenRequired: false };

function wizardApi(options: { steps?: ReturnType<typeof stepsOf>; mode?: 'automatic' | 'manual' } = {}) {
  const steps = options.steps ?? stepsOf();
  return createMockApi({
    'GET /api/v1/setup/status': () => STATUS,
    'GET /api/v1/setup/state': () => sampleSetupState({ steps, mode: options.mode ?? 'automatic' }),
    'GET /api/v1/connection/runs/current': () => sampleSnapshot({ steps }),
    'POST /api/v1/setup/environment': () => sampleEnvironment(),
  });
}

async function openSetup(
  api: ReturnType<typeof createMockApi>,
  options: { language?: Locale; path?: string } = {},
) {
  return renderApp({
    me: sampleMe({ kind: 'setup', setupState: 'in_progress' }),
    branding: sampleBranding('Acme'),
    path: options.path ?? '/setup',
    language: options.language ?? 'en',
    fetch: api.fetch,
  });
}

describe('the token form', () => {
  const locked = () =>
    createMockApi({
      'GET /api/v1/setup/status': () => ({ state: 'unconfigured', tokenRequired: true }),
    });

  it('has one password field with an accessible name, and a button', async () => {
    await openSetup(locked());
    const en = tr('en');
    const field = await screen.findByLabelText(en.t('setup.token.label'));
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(screen.getAllByLabelText(en.t('setup.token.label'))).toHaveLength(1);
    expect(screen.getByRole('button', { name: en.t('setup.token.submit') })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(en.t('setup.token.title'));
  });

  it('is in Dutch when the page is Dutch', async () => {
    await openSetup(locked(), { language: 'nl' });
    const nl = tr('nl');
    expect(await screen.findByLabelText(nl.t('setup.token.label'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: nl.t('setup.token.submit') })).toBeInTheDocument();
    expect(nl.t('setup.token.submit')).not.toBe(tr('en').t('setup.token.submit'));
  });

  it('sends the token once, clears the field and opens the wizard when it is right', async () => {
    const api = locked();
    let unlocked = false;
    api.on('GET /api/v1/setup/status', () => ({ state: unlocked ? 'in_progress' : 'unconfigured', tokenRequired: !unlocked }));
    api.on('POST /api/v1/setup/unlock', () => {
      unlocked = true;
      return { state: 'in_progress' };
    });
    api.on('GET /api/v1/setup/state', () => sampleSetupState({ steps: stepsOf() }));
    api.on('GET /api/v1/connection/runs/current', () => sampleSnapshot());
    api.on('POST /api/v1/setup/environment', () => sampleEnvironment());
    const view = await openSetup(api);
    const en = tr('en');
    const field = await screen.findByLabelText(en.t('setup.token.label'));
    await view.user.type(field, 'right-token');
    await view.user.click(screen.getByRole('button', { name: en.t('setup.token.submit') }));
    await screen.findByRole('heading', { level: 2, name: en.t('setup.environment.title') });
    expect(api.callsTo('POST /api/v1/setup/unlock')).toHaveLength(1);
    expect(api.callsTo('POST /api/v1/setup/unlock')[0]?.body).toEqual({ token: 'right-token' });
    // The token is not in the page any more.
    expect(document.body.innerHTML).not.toContain('right-token');
  });

  it('answers a wrong token with the generic message and puts the focus back in the field', async () => {
    const api = locked();
    api.on('POST /api/v1/setup/unlock', () => problem(401, 'setup_token_invalid'));
    const view = await openSetup(api);
    const en = tr('en');
    const field = await screen.findByLabelText(en.t('setup.token.label'));
    await view.user.type(field, 'wrong');
    await view.user.click(screen.getByRole('button', { name: en.t('setup.token.submit') }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.t('problem.setup_token_invalid'));
    expect(document.activeElement).toBe(screen.getByLabelText(en.t('setup.token.label')));
    expect(screen.getByLabelText(en.t('setup.token.label'))).toHaveValue('');
  });

  it('shows a countdown from Retry-After when the unlock is locked, and keeps the button off', async () => {
    const api = locked();
    api.on('POST /api/v1/setup/unlock', () => problem(429, 'setup_token_locked', { retryAfter: 30 }));
    const view = await openSetup(api);
    const en = tr('en');
    await view.user.type(await screen.findByLabelText(en.t('setup.token.label')), 'x');
    await view.user.click(screen.getByRole('button', { name: en.t('setup.token.submit') }));
    await screen.findByText(/You can try again in (29|30) s\./);
    await view.user.type(screen.getByLabelText(en.t('setup.token.label')), 'y');
    expect(screen.getByRole('button', { name: en.t('setup.token.submit') })).toBeDisabled();
  });

  it('points a finished wizard to the sign-in', async () => {
    const api = locked();
    api.on('POST /api/v1/setup/unlock', () => problem(409, 'setup_step_not_ready'));
    const view = await openSetup(api);
    const en = tr('en');
    await view.user.type(await screen.findByLabelText(en.t('setup.token.label')), 'x');
    await view.user.click(screen.getByRole('button', { name: en.t('setup.token.submit') }));
    const link = await screen.findByRole('link', { name: en.t('setup.finish.signIn') });
    expect(link).toHaveAttribute('href', '/auth/login');
  });
});

describe('Not-found', () => {
  it('renders Not-found when the gate is closed (the status answers 404)', async () => {
    const api = createMockApi({ 'GET /api/v1/setup/status': () => problem(404, 'not_found') });
    await openSetup(api);
    expect(
      await screen.findByRole('heading', { level: 1, name: tr('en').t('pages.notFound.title') }),
    ).toBeInTheDocument();
  });

  it('renders Not-found for /setup/<anything>', async () => {
    await openSetup(wizardApi(), { path: '/setup/anything' });
    expect(
      await screen.findByRole('heading', { level: 1, name: tr('en').t('pages.notFound.title') }),
    ).toBeInTheDocument();
  });

  it('loads the setup namespace through the route loader (a lazy chunk, no secret in it)', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'routes', 'setup.tsx'), 'utf8');
    expect(source).toContain("loadLazyNamespace('setup')");
    expect(source).not.toMatch(/token\s*[:=]\s*['"][^'"]+['"]/i);
  });
});

describe('StepList', () => {
  const wordsOf = (language: Locale, status: string): string => tr(language).t(`setup.status.${status}` as never);

  for (const language of ['en', 'nl'] as const) {
    it(`is an ordered list with an icon and a text status for each of the seven statuses (${language})`, async () => {
      const statuses = Object.fromEntries(
        ['environment', 'connect', 'configure', 'verify', 'finish'].map((key, index) => [
          key,
          STEP_STATUSES[index],
        ]),
      );
      const api = createMockApi({ 'GET /api/v1/setup/status': () => STATUS });
      void api;
      const t = tr(language);
      const { container } = await renderStepList(language, statuses as never, 'configure');
      const list = within(container).getByRole('list');
      expect(list.tagName).toBe('OL');
      const items = within(list).getAllByRole('listitem');
      expect(items).toHaveLength(5);
      expect(items[2]).toHaveAttribute('aria-current', 'step');
      expect(items.filter((item) => item.hasAttribute('aria-current'))).toHaveLength(1);
      items.forEach((item, index) => {
        expect(item.querySelector('svg')).not.toBeNull();
        expect(item).toHaveTextContent(wordsOf(language, STEP_STATUSES[index] ?? 'pending'));
      });
      expect(items[2]).toHaveTextContent(t.t('setup.stepCurrent'));
      // Every status exists in words, so a seventh status never shows as an empty badge.
      for (const status of STEP_STATUSES) expect(wordsOf(language, status)).not.toBe('');
      const bar = within(container).getByRole('progressbar', { name: t.t('setup.progress.label') });
      expect(bar).toHaveAttribute('value', '3');
      expect(container).toHaveTextContent(t.t('setup.progress.summary', { current: 3, total: 5 }));
    });
  }
});

async function renderStepList(
  language: Locale,
  statuses: Parameters<typeof stepsOf>[0],
  current: 'environment' | 'connect' | 'configure' | 'verify' | 'finish',
) {
  const { LanguageProvider, createLanguageController } = await import('../src/lib/locale');
  const { createStorage } = await import('../src/lib/storage');
  const controller = createLanguageController({
    storage: createStorage(null),
    languages: [language],
    root: document.createElement('html'),
  });
  return render(
    <LanguageProvider controller={controller}>
      <StepList steps={stepsOf(statuses)} current={current} />
    </LanguageProvider>,
  );
}

describe('focus', () => {
  it('moves to the step heading when the step changes', async () => {
    const steps = stepsOf({ environment: 'succeeded' });
    const api = wizardApi({ steps });
    const view = await openSetup(api);
    const en = tr('en');
    await screen.findByRole('heading', { level: 2, name: en.t('setup.environment.title') });
    await view.user.click(await screen.findByRole('button', { name: en.t('setup.continue') }));
    const heading = await screen.findByRole('heading', { level: 2, name: en.t('setup.connect.title') });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });

  it('moves to the error summary when a step failed', async () => {
    const steps = stepsOf(
      { environment: 'succeeded', connect: 'failed' },
      { device_code: { status: 'failed', errorCode: 'device_code_expired' } },
    );
    const api = wizardApi({ steps });
    const view = await openSetup(api);
    const en = tr('en');
    await view.user.click(await screen.findByRole('button', { name: en.t('setup.continue') }));
    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent(en.t('setup.result.device_code_expired'));
    expect(summary).toHaveTextContent(en.t('setup.remedy.device_code_expired'));
    await waitFor(() => {
      expect(document.activeElement).toBe(summary);
    });
  });
});

void fireEvent;
