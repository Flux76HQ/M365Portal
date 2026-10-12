// THE BREAK-GLASS PAGES (T-B-305; FR-B-522 web half, FR-B-523 UI, FR-B-607; US-B10). `/break-glass` is
// Not-found unless the server has the account configured; the form posts through lib/api (Origin and CSRF);
// `/settings/restore-access` is for the break-glass session only and offers one write: restore the Owner.
import { createTranslator, type Locale } from '@m365portal/shared/i18n';
import { LIMITS } from '@m365portal/shared/limits';
import { screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleBranding, sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
import { createMockApi, problem, type Handler } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import { OWNER_ID, loadAllLazyNamespaces } from './helpers/setup-fixtures';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const tr = (language: Locale) => createTranslator(language);

async function openForm(handlers: Record<string, Handler> = {}, options: { enabled?: boolean; language?: Locale } = {}) {
  const mock = createMockApi(handlers);
  const view = await renderApp({
    me: sampleMe({ breakGlass: options.enabled ?? true }),
    branding: sampleBranding('Acme'),
    path: '/break-glass',
    language: options.language ?? 'en',
    fetch: mock.fetch,
  });
  return { ...view, mock };
}

describe('/break-glass', () => {
  it('renders Not-found unless the server has break-glass configured', async () => {
    await openForm({}, { enabled: false });
    expect(await screen.findByRole('heading', { level: 1, name: tr('en').t('pages.notFound.title') })).toBeInTheDocument();
    expect(screen.queryByLabelText(tr('en').t('breakglass.form.username'))).toBeNull();
  });

  for (const language of ['en', 'nl'] as const) {
    it(`shows the form with the red warning in ${language}`, async () => {
      await openForm({}, { language });
      const t = tr(language);
      expect(await screen.findByRole('heading', { level: 1, name: t.t('breakglass.form.title') })).toBeInTheDocument();
      expect(screen.getByLabelText(t.t('breakglass.form.username'))).toBeInTheDocument();
      const password = screen.getByLabelText(t.t('breakglass.form.password'));
      expect(password).toHaveAttribute('type', 'password');
      expect(password).toHaveAttribute('autocomplete', 'off');
      const warning = screen.getByText(t.t('breakglass.form.warning', { minutes: LIMITS.breakGlass.sessionMinutes }));
      expect(warning.closest('[data-slot="banner"]')).toHaveAttribute('data-tone', 'danger');
      expect(screen.getByRole('link', { name: t.t('breakglass.form.normalSignIn') })).toHaveAttribute('href', '/signin');
    });
  }

  it('asks for both fields before it sends anything', async () => {
    const { user, mock } = await openForm();
    const en = tr('en');
    await user.click(await screen.findByRole('button', { name: en.t('breakglass.form.submit') }));
    expect((await screen.findAllByText(en.t('breakglass.form.required'))).length).toBe(2);
    expect(mock.callsTo('POST /api/v1/auth/break-glass')).toHaveLength(0);
  });

  it('posts the username and password, clears the password and goes to the restore page', async () => {
    const { user, mock, moves } = await openForm({
      'POST /api/v1/auth/break-glass': () => ({ redirect: '/settings/restore-access' }),
    });
    const en = tr('en');
    await user.type(await screen.findByLabelText(en.t('breakglass.form.username')), 'emergency');
    await user.type(screen.getByLabelText(en.t('breakglass.form.password')), 'a-throwaway-secret');
    await user.click(screen.getByRole('button', { name: en.t('breakglass.form.submit') }));
    await waitFor(() => {
      expect(moves).toEqual(['assign /settings/restore-access']);
    });
    expect(mock.callsTo('POST /api/v1/auth/break-glass')[0]?.body).toEqual({ username: 'emergency', password: 'a-throwaway-secret' });
    expect(screen.getByLabelText(en.t('breakglass.form.password'))).toHaveValue('');
    expect(document.body.innerHTML).not.toContain('a-throwaway-secret');
  });

  it('never navigates to an address the server made up', async () => {
    const { user, moves } = await openForm({
      'POST /api/v1/auth/break-glass': () => ({ redirect: 'https://evil.example/' }),
    });
    const en = tr('en');
    await user.type(await screen.findByLabelText(en.t('breakglass.form.username')), 'emergency');
    await user.type(screen.getByLabelText(en.t('breakglass.form.password')), 'x');
    await user.click(screen.getByRole('button', { name: en.t('breakglass.form.submit') }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(moves).toEqual([]);
  });

  it('answers a refused sign-in with one generic message, and does not leave the page', async () => {
    const { user, moves } = await openForm({
      'POST /api/v1/auth/break-glass': () => problem(401, 'unauthenticated'),
    });
    const en = tr('en');
    await user.type(await screen.findByLabelText(en.t('breakglass.form.username')), 'emergency');
    await user.type(screen.getByLabelText(en.t('breakglass.form.password')), 'wrong');
    await user.click(screen.getByRole('button', { name: en.t('breakglass.form.submit') }));
    expect(await screen.findByText(en.t('breakglass.form.invalid'))).toBeInTheDocument();
    expect(moves).toEqual([]);
    expect(screen.getByLabelText(en.t('breakglass.form.password'))).toHaveValue('');
  });

  it('shows the lock with a countdown and keeps the button off', async () => {
    const { user } = await openForm({
      'POST /api/v1/auth/break-glass': () => problem(429, 'break_glass_locked', { retryAfter: 60 }),
    });
    const en = tr('en');
    await user.type(await screen.findByLabelText(en.t('breakglass.form.username')), 'emergency');
    await user.type(screen.getByLabelText(en.t('breakglass.form.password')), 'x');
    await user.click(screen.getByRole('button', { name: en.t('breakglass.form.submit') }));
    expect(await screen.findByText(en.t('problem.break_glass_locked', { seconds: 60 }))).toBeInTheDocument();
    await screen.findByText(/You can try again in (59|60) s\./);
    await user.type(screen.getByLabelText(en.t('breakglass.form.password')), 'y');
    expect(screen.getByRole('button', { name: en.t('breakglass.form.submit') })).toBeDisabled();
  });
});

describe('/settings/restore-access', () => {
  const breakGlassMe = () => sampleMe({ kind: 'break_glass', breakGlass: true, permissions: ['rbac:manage'] });

  async function openRestore(handlers: Record<string, Handler> = {}, me = breakGlassMe(), language: Locale = 'en') {
    const mock = createMockApi(handlers);
    const view = await renderApp({
      me,
      branding: sampleBranding('Acme'),
      path: '/settings/restore-access',
      language,
      fetch: mock.fetch,
    });
    return { ...view, mock };
  }

  it('is Not-found for a signed-in Owner', async () => {
    await openRestore({}, sampleSignedInMe({ roles: ['owner'] }));
    expect(await screen.findByRole('heading', { level: 1, name: tr('en').t('pages.notFound.title') })).toBeInTheDocument();
  });

  it('is Not-found for an anonymous visitor too (the gate sends them to sign in first)', async () => {
    await openRestore({}, sampleMe());
    expect(await screen.findByRole('heading', { level: 1 })).not.toHaveTextContent(tr('en').t('breakglass.restore.title'));
  });

  for (const language of ['en', 'nl'] as const) {
    it(`offers "restore the Owner" to the break-glass session (${language})`, async () => {
      await openRestore({}, breakGlassMe(), language);
      const t = tr(language);
      expect(await screen.findByRole('heading', { level: 1, name: t.t('breakglass.restore.title') })).toBeInTheDocument();
      expect(screen.getByLabelText(t.t('breakglass.restore.field'))).toBeInTheDocument();
      expect(screen.getByRole('button', { name: t.t('breakglass.restore.submit') })).toBeInTheDocument();
    });
  }

  it('checks the id, posts it, and offers to sign out of break-glass access afterwards', async () => {
    const { user, mock } = await openRestore({
      'POST /api/v1/rbac/restore-owner': () => ({}),
    });
    const en = tr('en');
    const field = await screen.findByLabelText(en.t('breakglass.restore.field'));
    await user.type(field, 'not-a-guid');
    await user.click(screen.getByRole('button', { name: en.t('breakglass.restore.submit') }));
    expect(await screen.findByText(en.t('breakglass.restore.invalidId'))).toBeInTheDocument();
    expect(mock.callsTo('POST /api/v1/rbac/restore-owner')).toHaveLength(0);
    await user.clear(field);
    await user.type(field, OWNER_ID.toUpperCase());
    await user.click(screen.getByRole('button', { name: en.t('breakglass.restore.submit') }));
    expect(await screen.findByText(en.t('breakglass.restore.done'))).toBeInTheDocument();
    expect(mock.callsTo('POST /api/v1/rbac/restore-owner')[0]?.body).toEqual({ userId: OWNER_ID });
    expect(screen.getByRole('button', { name: en.t('breakglass.restore.signOut') })).toBeInTheDocument();
  });

  it('says that the account is disabled', async () => {
    const { user } = await openRestore({
      'POST /api/v1/rbac/restore-owner': () => problem(422, 'principal_unknown', { errors: [{ pointer: '/userId', code: 'principal_disabled' }] }),
    });
    const en = tr('en');
    await user.type(await screen.findByLabelText(en.t('breakglass.restore.field')), OWNER_ID);
    await user.click(screen.getByRole('button', { name: en.t('breakglass.restore.submit') }));
    expect(await screen.findByText(en.t('breakglass.restore.disabled'))).toBeInTheDocument();
  });

  it('says that the user already is an Owner', async () => {
    const { user } = await openRestore({
      'POST /api/v1/rbac/restore-owner': () => problem(409, 'assignment_exists'),
    });
    const en = tr('en');
    await user.type(await screen.findByLabelText(en.t('breakglass.restore.field')), OWNER_ID);
    await user.click(screen.getByRole('button', { name: en.t('breakglass.restore.submit') }));
    expect(await screen.findByText(en.t('problem.assignment_exists'))).toBeInTheDocument();
  });

  it('offers the unverified confirmation when Microsoft cannot be reached, and sends it only on request', async () => {
    let calls = 0;
    const { user, mock } = await openRestore({
      'POST /api/v1/rbac/restore-owner': (call) => {
        calls += 1;
        return (call.body as { confirmUnverified?: boolean }).confirmUnverified === true ? {} : problem(503, 'graph_unavailable');
      },
    });
    const en = tr('en');
    await user.type(await screen.findByLabelText(en.t('breakglass.restore.field')), OWNER_ID);
    await user.click(screen.getByRole('button', { name: en.t('breakglass.restore.submit') }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(en.t('breakglass.restore.unverified.title'));
    expect(dialog).toHaveTextContent(en.t('breakglass.restore.unverified.message'));
    expect(calls).toBe(1);
    await user.click(screen.getByRole('button', { name: en.t('breakglass.restore.unverified.confirm') }));
    expect(await screen.findByText(en.t('breakglass.restore.done'))).toBeInTheDocument();
    expect(mock.callsTo('POST /api/v1/rbac/restore-owner')[1]?.body).toEqual({ userId: OWNER_ID, confirmUnverified: true });
  });

  it('offers no other write: the page holds one form and a sign-out', async () => {
    await openRestore();
    const main = await screen.findByRole('main');
    expect(main.querySelectorAll('form')).toHaveLength(1);
  });
});
