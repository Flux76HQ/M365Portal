// WIZARD STEPS 3 TO 5: CONFIGURE, VERIFY, FINISH (T-B-302; FR-B-221, FR-B-219 web half, FR-B-318 web half;
// EB-06, EB-09, EB-36; US-B2, US-B4 item 1). The network is a mock; the UI renders keys, never Microsoft text.
import { createTranslator, type Locale } from '@m365portal/shared/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProofList } from '../src/features/connection/ProofList';
import { hintText, resultText } from '../src/features/setup/hints';
import type { Proof } from '../src/features/setup/setup-api';
import { LanguageProvider, createLanguageController } from '../src/lib/locale';
import { createStorage } from '../src/lib/storage';
import { sampleBranding, sampleMe } from './helpers/boot-fixtures';
import { createMockApi, problem, type Handler } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import {
  APP_ID,
  APP_OBJECT_ID,
  GROUP_ID,
  OWNER_ID,
  SP_ID,
  TENANT_ID,
  iso,
  loadAllLazyNamespaces,
  sampleRunStatus,
  sampleSetupState,
  sampleSnapshot,
  stepsOf,
} from './helpers/setup-fixtures';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const tr = (language: Locale) => createTranslator(language);

type Steps = ReturnType<typeof stepsOf>;

function api(
  steps: Steps,
  extra: Record<string, Handler> = {},
  options: { state?: Parameters<typeof sampleSetupState>[0]; snapshot?: Parameters<typeof sampleSnapshot>[0] } = {},
) {
  return createMockApi({
    'GET /api/v1/setup/status': () => ({ state: 'in_progress', tokenRequired: false }),
    'GET /api/v1/setup/state': () => sampleSetupState({ steps, ...options.state }),
    'GET /api/v1/connection/runs/current': () => sampleSnapshot({ steps, serverTime: new Date().toISOString(), ...options.snapshot }),
    'GET /api/v1/branding': () => sampleBranding('Acme'),
    ...extra,
  });
}

async function open(mock: ReturnType<typeof createMockApi>, language: Locale = 'en') {
  const view = await renderApp({
    me: sampleMe({ kind: 'setup', setupState: 'in_progress', permissions: [] }),
    branding: sampleBranding('Acme'),
    path: '/setup',
    language,
    fetch: mock.fetch,
  });
  // The environment step stays on screen once after it passed, until the person goes on.
  await view.user.click(await screen.findByRole('button', { name: tr(language).t('setup.continue') }));
  return view;
}

const DONE = { environment: 'succeeded', connect: 'succeeded' } as const;

describe('step 3, configure', () => {
  const waitingSteps = (): Steps =>
    stepsOf(
      { ...DONE, configure: 'running' },
      {
        application: {
          status: 'succeeded',
          hint: { key: 'setup.hint.application', params: { name: 'M365Portal', objectId: APP_OBJECT_ID, appId: APP_ID } },
        },
        service_principal: {
          status: 'waiting',
          attempt: 2,
          hint: { key: 'setup.hint.service_principal', params: { name: 'M365Portal', objectId: SP_ID, appId: APP_ID } },
          waiting: { attempt: 2, max: 6, nextAttemptAt: new Date(Date.now() + 8_000).toISOString() },
        },
        certificate: {
          status: 'pending',
          hint: { key: 'setup.hint.certificate', params: { thumbprint8: 'a1b2c3d4', objectId: APP_OBJECT_ID } },
        },
      },
    );

  it('shows each sub-action with its status, the attempt, a countdown and the rollback hints', async () => {
    const steps = waitingSteps();
    const mock = api(steps, { 'POST /api/v1/connection/runs/current/retry-now': () => sampleRunStatus() }, {
      snapshot: { run: sampleRunStatus({ status: 'waiting' }) },
    });
    const view = await open(mock);
    const en = tr('en');
    await screen.findByRole('heading', { level: 2, name: en.t('setup.configure.title') });
    const panel = document.querySelector<HTMLElement>('[data-step-panel="configure"]')!;
    const rows = within(panel).getAllByRole('listitem').filter((row) => row.hasAttribute('data-sub'));
    expect(rows).toHaveLength(7);
    const sp = panel.querySelector<HTMLElement>('[data-sub="service_principal"]')!;
    expect(sp).toHaveTextContent(en.t('setup.sub.service_principal'));
    expect(sp).toHaveTextContent(en.t('setup.status.waiting'));
    expect(sp).toHaveTextContent(/Waiting for Microsoft\. Next attempt in [789] s\./);
    expect(sp).toHaveTextContent(en.t('setup.configure.attempt', { attempt: 2 }));
    expect(panel.querySelector('[data-sub="application"]')).toHaveTextContent(en.t('setup.status.succeeded'));
    expect(panel.querySelector('[data-sub="certificate"]')).toHaveTextContent(en.t('setup.status.pending'));

    // The hints name what was created, with the parameters filled in.
    const hints = panel.querySelector<HTMLElement>('[data-slot="rollback-hints"]')!;
    expect(hints).toHaveTextContent(en.t('setup.hintTitle'));
    expect(hints).toHaveTextContent(`Delete the application “M365Portal” (object ID ${APP_OBJECT_ID}, application ID ${APP_ID}) in Microsoft Entra.`);
    expect(hints).toHaveTextContent(`object ID ${SP_ID}`);
    expect(hints).toHaveTextContent(`thumbprint a1b2c3d4 from the application with object ID ${APP_OBJECT_ID}`);
    expect(hints.textContent).not.toMatch(/\{[a-zA-Z]+\}/);

    await view.user.click(within(sp).getByRole('button', { name: en.t('setup.configure.retryNow') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/runs/current/retry-now')).toHaveLength(1);
    });
  });

  it('names the existing application in the adoption prompt and adopts only after the acknowledgement', async () => {
    const steps = stepsOf(
      { ...DONE, configure: 'running' },
      { application: { status: 'waiting', errorCode: 'application_adoption_required' } },
    );
    const adoption = {
      kind: 'application' as const,
      candidate: {
        objectId: APP_OBJECT_ID,
        appId: APP_ID,
        displayName: 'M365Portal',
        foreign: { keyCredentials: 2, owners: 1, servicePrincipalKeyCredentials: 0, servicePrincipalOwners: 3 },
      },
      requiresAcknowledgement: true,
    };
    const mock = api(steps, { 'POST /api/v1/connection/adopt': () => sampleRunStatus() }, {
      snapshot: { run: sampleRunStatus({ status: 'waiting' }), adoption },
    });
    const view = await open(mock);
    const en = tr('en');
    const prompt = await screen.findByRole('region', { name: en.t('setup.adopt.title') });
    expect(prompt).toHaveTextContent(en.t('setup.adopt.message', { name: 'M365Portal' }));
    expect(prompt).toHaveTextContent(en.t('setup.adopt.foreign', { keys: 2, owners: 4 }));
    const confirm = within(prompt).getByRole('button', { name: en.t('setup.adopt.confirm') });
    expect(confirm).toBeDisabled();
    await view.user.click(within(prompt).getByRole('checkbox', { name: en.t('setup.adopt.acknowledge') }));
    expect(confirm).toBeEnabled();
    await view.user.click(confirm);
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/adopt')).toHaveLength(1);
    });
    expect(mock.callsTo('POST /api/v1/connection/adopt')[0]?.body).toEqual({
      kind: 'application',
      objectId: APP_OBJECT_ID,
      confirm: true,
      acknowledgeForeign: true,
    });
  });

  it('needs no acknowledgement when nothing foreign is on the application', async () => {
    const steps = stepsOf({ ...DONE, configure: 'running' }, { application: { status: 'waiting' } });
    const mock = api(steps, { 'POST /api/v1/connection/adopt': () => sampleRunStatus() }, {
      snapshot: {
        run: sampleRunStatus({ status: 'waiting' }),
        adoption: {
          kind: 'application',
          candidate: { objectId: APP_OBJECT_ID, appId: APP_ID, displayName: 'M365Portal', foreign: { keyCredentials: 0, owners: 0, servicePrincipalKeyCredentials: 0, servicePrincipalOwners: 0 } },
          requiresAcknowledgement: false,
        },
      },
    });
    const view = await open(mock);
    const en = tr('en');
    const prompt = await screen.findByRole('region', { name: en.t('setup.adopt.title') });
    expect(within(prompt).queryByRole('checkbox')).toBeNull();
    await view.user.click(within(prompt).getByRole('button', { name: en.t('setup.adopt.confirm') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/adopt')[0]?.body).toMatchObject({ confirm: true, acknowledgeForeign: false });
    });
  });

  it('lets the person choose another name instead', async () => {
    const steps = stepsOf({ ...DONE, configure: 'running' }, { application: { status: 'waiting' } });
    const mock = api(steps, { 'POST /api/v1/connection/runs/current/cancel': () => sampleRunStatus({ cancelRequested: true }) }, {
      snapshot: {
        run: sampleRunStatus({ status: 'waiting' }),
        adoption: {
          kind: 'application',
          candidate: { objectId: APP_OBJECT_ID, appId: APP_ID, displayName: 'M365Portal', foreign: { keyCredentials: 0, owners: 0, servicePrincipalKeyCredentials: 0, servicePrincipalOwners: 0 } },
          requiresAcknowledgement: false,
        },
      },
    });
    const view = await open(mock);
    const en = tr('en');
    await view.user.click(await screen.findByRole('button', { name: en.t('setup.adopt.decline') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/runs/current/cancel')).toHaveLength(1);
    });
    expect(await screen.findByLabelText(en.t('setup.adopt.nameLabel'))).toBeInTheDocument();
  });

  it('explains an ambiguous application in words, with a way to go on', async () => {
    const steps = stepsOf(
      { ...DONE, configure: 'failed' },
      { application: { status: 'failed', errorCode: 'application_ambiguous' } },
    );
    await open(api(steps));
    const en = tr('en');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.t('setup.result.application_ambiguous'));
    expect(alert).toHaveTextContent(en.t('setup.remedy.application_ambiguous'));
    expect(screen.getByRole('button', { name: en.t('setup.retry') })).toBeInTheDocument();
  });

  it('renders the remedy of an untrusted application and offers no way to adopt it', async () => {
    const steps = stepsOf(
      { ...DONE, configure: 'failed' },
      { application: { status: 'failed', errorCode: 'application_untrusted' } },
    );
    await open(api(steps));
    const en = tr('en');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.t('setup.remedy.application_untrusted'));
    expect(screen.queryByRole('button', { name: en.t('setup.adopt.confirm') })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('retries from the configure step, or signs in again when the sign-in is gone', async () => {
    const steps = stepsOf(
      { ...DONE, configure: 'failed' },
      { application: { status: 'failed', errorCode: 'graph_error' } },
    );
    const mock = api(steps, { 'POST /api/v1/connection/runs': () => problem(409, 'setup_step_not_ready') });
    const view = await open(mock);
    const en = tr('en');
    await view.user.click(await screen.findByRole('button', { name: en.t('setup.retry') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/runs')[0]?.body).toEqual({ steps: ['configure', 'verify'], mode: 'continue' });
    });
    mock.on('POST /api/v1/connection/runs', () => sampleRunStatus());
    await view.user.click(await screen.findByRole('button', { name: en.t('setup.connect.start') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/runs')[1]?.body).toEqual({ steps: ['connect', 'configure', 'verify'], mode: 'continue' });
    });
  });
});

describe('result and hint texts', () => {
  it('turns a code this bundle does not know into a generic message with the number', () => {
    for (const language of ['en', 'nl'] as const) {
      const t = tr(language);
      const text = resultText(t, 'brand_new_code');
      expect(text.message).toBe(t.t('setup.unknownResult', { code: 'brand_new_code' }));
      expect(text.remedy).toBe(t.t('setup.unknownRemedy'));
      expect(text.message).not.toContain('setup.');
    }
  });

  it('never leaves a placeholder in a hint, and skips a key that is not a hint', () => {
    const t = tr('en');
    expect(hintText(t, { key: 'setup.hint.grants', params: {} }, { subAction: 'graph_permissions' })).toContain('User.Read.All');
    expect(hintText(t, { key: 'setup.hint.grants', params: {} }, { subAction: 'exchange_permissions' })).toContain('Exchange.ManageAsApp');
    expect(hintText(t, { key: 'setup.hint.exchange_role', params: { name: 'exchange_administrator' } })).toContain('Exchange Administrator');
    expect(hintText(t, { key: 'setup.hint.certificate', params: {} })).not.toMatch(/\{/);
    expect(hintText(t, { key: 'setup.hint.bootstrap_consent', params: {} })).toContain('Graph Command Line Tools');
    expect(hintText(t, { key: 'setup.hint.nonsense', params: {} })).toBeNull();
  });
});

describe('the proof list', () => {
  const proof: Proof = {
    generatedAt: iso(),
    mode: 'automatic',
    items: [
      { key: 'application' as const, status: 'ok' as const, at: iso(-1000), params: {} },
      { key: 'service_principal' as const, status: 'ok' as const, at: iso(-1000), params: {} },
      { key: 'certificate' as const, status: 'ok' as const, at: iso(-1000), params: { thumbprint8: 'a1b2c3d4', notAfter: '2027-08-01T00:00:00.000Z' } },
      { key: 'graph_roles' as const, status: 'ok' as const, at: iso(-1000), params: { count: 4, extra: 0, missing: 0 } },
      { key: 'exchange_roles' as const, status: 'warning' as const, at: iso(-1000), params: { count: 3, extra: 1, missing: 0 } },
      { key: 'entra_role' as const, status: 'ok' as const, at: iso(-1000), params: {} },
      { key: 'check_v2' as const, status: 'ok' as const, at: iso(-1000), params: {} },
      { key: 'check_v4' as const, status: 'warning' as const, at: iso(-1000), params: { passwordCredentials: 1, foreignKeyCredentials: 2, owners: 3, code: 'foreign_credential_present' } },
      { key: 'check_v5' as const, status: 'not_checked' as const, at: null, params: {} },
      { key: 'check_v6' as const, status: 'failed' as const, at: iso(-1000), params: { code: 'optional_claim_missing' } },
    ],
  };

  function show(language: Locale = 'en') {
    const controller = createLanguageController({
      storage: createStorage(null),
      languages: [language],
      root: document.createElement('html'),
    });
    return render(
      <LanguageProvider controller={controller}>
        <ProofList
          proof={proof}
          application={{ appId: APP_ID, displayName: 'M365Portal' }}
          tenant={{ name: 'Contoso', initialDomain: 'contoso.onmicrosoft.com' }}
        />
      </LanguageProvider>,
    );
  }

  for (const language of ['en', 'nl'] as const) {
    it(`lists each item with a status in words and its detail (${language})`, () => {
      show(language);
      const t = tr(language);
      const item = (key: string) => document.querySelector(`[data-proof="${key}"]`)!;
      expect(item('application')).toHaveTextContent(t.t('connection.proofDetail.application', { name: 'M365Portal', appId: APP_ID }));
      expect(item('application')).toHaveTextContent(t.t('connection.proofStatus.ok'));
      expect(item('certificate')).toHaveTextContent('a1b2c3d4');
      expect(item('graph_roles')).toHaveTextContent('User.Read.All');
      expect(item('graph_roles')).toHaveTextContent('Organization.Read.All');
      expect(item('exchange_roles')).toHaveTextContent(t.t('connection.proofStatus.warning'));
      expect(item('exchange_roles')).toHaveTextContent(t.t('connection.proofDetail.roleCounts', { count: 3, missing: 0, extra: 1 }));
      expect(item('entra_role')).toHaveTextContent('Exchange Administrator');
      expect(item('check_v2')).toHaveTextContent('Contoso');
      expect(item('check_v5')).toHaveTextContent(t.t('connection.proofStatus.not_checked'));
      expect(item('check_v5')).toHaveTextContent(t.t('connection.proofDetail.notChecked'));
      // A time for every checked item, none for the unchecked one.
      expect(item('application').querySelector('time')).not.toBeNull();
      expect(item('check_v5').querySelector('time')).toBeNull();
      // A failed item says why, in the panel's words.
      expect(item('check_v6')).toHaveTextContent(t.t('setup.result.optional_claim_missing'));
      expect(item('check_v6')).toHaveTextContent(t.t('setup.remedy.optional_claim_missing'));
    });
  }

  it('warns about credentials and owners the panel did not add, with the counts', () => {
    show();
    const v4 = document.querySelector<HTMLElement>('[data-proof="check_v4"]')!;
    const en = tr('en');
    expect(v4).toHaveTextContent(en.t('connection.proofDetail.check_v4', { passwordCredentials: 1, foreignKeyCredentials: 2, owners: 3 }));
    expect(v4).toHaveTextContent(en.t('connection.proofDetail.foreignWarning'));
  });

  it('says there is no proof yet', () => {
    const controller = createLanguageController({ storage: createStorage(null), languages: ['en'], root: document.createElement('html') });
    render(
      <LanguageProvider controller={controller}>
        <ProofList proof={null} />
      </LanguageProvider>,
    );
    expect(screen.getByText(tr('en').t('connection.proofEmpty'))).toBeInTheDocument();
  });
});

describe('step 4, verify', () => {
  it('shows a warning, not a failure, when Exchange was skipped', async () => {
    const steps = stepsOf(
      { ...DONE, configure: 'succeeded', verify: 'warning' },
      { exchange_probe: { status: 'warning', errorCode: 'exchange_unavailable' } },
    );
    const mock = api(steps, {}, { state: { exchangeEnabled: false } });
    await open(mock);
    const en = tr('en');
    // Verify has ended with a warning, so the page is on the finish step; the warning stays visible.
    await screen.findByRole('heading', { level: 2, name: en.t('setup.finish.title') });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(en.t('setup.verify.exchangeSkipped'))).toBeInTheDocument();
  });

  it('offers to verify again when the verification failed, and starts it', async () => {
    const steps = stepsOf(
      { ...DONE, configure: 'succeeded', verify: 'failed' },
      { organization: { status: 'failed', errorCode: 'organization_mismatch' } },
    );
    const mock = api(steps, { 'POST /api/v1/connection/runs': () => sampleRunStatus({ steps: ['verify'] }) });
    const view = await open(mock);
    const en = tr('en');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.t('setup.result.organization_mismatch'));
    await view.user.click(screen.getByRole('button', { name: en.t('setup.verify.run') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/runs')[0]?.body).toEqual({ steps: ['verify'], mode: 'continue' });
    });
  });
});

describe('step 5, finish', () => {
  const finishSteps = () => stepsOf({ ...DONE, configure: 'succeeded', verify: 'succeeded' });
  const owner = { oid: OWNER_ID, upnLabel: 'anna@contoso.com', nameLabel: 'Anna Example' };
  const state = {
    designatedOwner: owner,
    tenant: { proposedTenantId: null, tenantId: TENANT_ID, name: 'Contoso', initialDomain: 'contoso.onmicrosoft.com' },
    application: { appId: APP_ID, objectId: APP_OBJECT_ID, displayName: 'M365Portal' },
  };

  it('shows the owner, a language choice, a group search and a summary, and finishes only after the confirmation', async () => {
    const mock = api(finishSteps(), {
      'GET /api/v1/setup/groups': () => ({ groups: [{ id: GROUP_ID, displayName: 'Helpdesk admins' }] }),
      'POST /api/v1/setup/finish': () => ({
        state: 'awaiting_first_signin',
        designatedOwner: owner,
        signinUrl: '/auth/login?returnTo=%2F',
      }),
    }, { state });
    const view = await open(mock);
    const en = tr('en');
    await screen.findByRole('heading', { level: 2, name: en.t('setup.finish.title') });
    expect(screen.getByText(en.t('setup.finish.owner.message', { name: 'Anna Example' }))).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: en.t('setup.finish.summary') });
    expect(summary).toHaveTextContent('Contoso');
    expect(summary).toHaveTextContent('M365Portal');
    expect(summary).toHaveTextContent(en.t('setup.finish.mode.automatic'));

    const finish = screen.getByRole('button', { name: en.t('setup.finish.submit') });
    expect(finish).toBeDisabled();

    // Group search: a GET with q, never a group created.
    await view.user.type(screen.getByLabelText(en.t('setup.finish.group.label')), 'Help');
    await view.user.click(screen.getByRole('button', { name: en.t('setup.finish.group.search') }));
    const choice = await screen.findByRole('button', { name: 'Helpdesk admins' });
    expect(mock.callsTo('GET /api/v1/setup/groups')[0]?.query.get('q')).toBe('Help');
    await view.user.click(choice);
    expect(screen.getByText(en.t('setup.finish.group.selected', { name: 'Helpdesk admins' }))).toBeInTheDocument();
    expect(mock.calls.filter((call) => call.method !== 'GET' && call.path.includes('group'))).toHaveLength(0);

    await view.user.click(screen.getByRole('radio', { name: en.t('setup.finish.language.nl') }));
    expect(finish).toBeDisabled();
    await view.user.click(screen.getByRole('checkbox', { name: en.t('setup.finish.owner.confirm') }));
    expect(finish).toBeEnabled();
    await view.user.click(finish);

    const link = await screen.findByRole('link', { name: en.t('setup.finish.signIn') });
    expect(link).toHaveAttribute('href', '/auth/login?returnTo=%2F');
    expect(screen.getByText(en.t('setup.finish.done.title'))).toBeInTheDocument();
    expect(mock.callsTo('POST /api/v1/setup/finish')[0]?.body).toEqual({
      confirmOwnerOid: OWNER_ID,
      language: 'nl',
      beheerderGroupId: GROUP_ID,
    });
  });

  it('says that no group was found, and sends the finish without a group when none is chosen', async () => {
    const mock = api(finishSteps(), {
      'GET /api/v1/setup/groups': () => ({ groups: [] }),
      'POST /api/v1/setup/finish': () => ({ state: 'awaiting_first_signin', designatedOwner: owner, signinUrl: '/auth/login?returnTo=%2F' }),
    }, { state });
    const view = await open(mock);
    const en = tr('en');
    await view.user.type(await screen.findByLabelText(en.t('setup.finish.group.label')), 'zzz');
    await view.user.click(screen.getByRole('button', { name: en.t('setup.finish.group.search') }));
    expect(await screen.findByText(en.t('setup.finish.group.none'))).toBeInTheDocument();
    await view.user.click(screen.getByRole('checkbox', { name: en.t('setup.finish.owner.confirm') }));
    await view.user.click(screen.getByRole('button', { name: en.t('setup.finish.submit') }));
    await screen.findByRole('link', { name: en.t('setup.finish.signIn') });
    const body = mock.callsTo('POST /api/v1/setup/finish')[0]?.body as Record<string, unknown>;
    expect(body.confirmOwnerOid).toBe(OWNER_ID);
    expect(body.beheerderGroupId ?? null).toBeNull();
  });

  it('shows the message of a changed owner and keeps the form', async () => {
    const mock = api(finishSteps(), {
      'POST /api/v1/setup/finish': () => problem(422, 'validation_failed', { errors: [{ pointer: '/confirmOwnerOid', code: 'owner_changed' }] }),
    }, { state });
    const view = await open(mock);
    const en = tr('en');
    await view.user.click(await screen.findByRole('checkbox', { name: en.t('setup.finish.owner.confirm') }));
    await view.user.click(screen.getByRole('button', { name: en.t('setup.finish.submit') }));
    expect(await screen.findByText(en.t('setup.result.owner_changed'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.t('setup.finish.submit') })).toBeEnabled();
  });

  it('does not let the person finish while the first Owner is not known', async () => {
    await open(api(finishSteps(), {}, { state: { designatedOwner: null } }));
    const en = tr('en');
    expect(await screen.findByText(en.t('setup.finish.owner.unknown'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.t('setup.finish.submit') })).toBeDisabled();
  });

  it('loads the Appearance form lazily and lets the person skip it', async () => {
    const mock = api(finishSteps(), {}, { state });
    const view = await open(mock);
    const en = tr('en');
    const section = await screen.findByRole('region', { name: en.t('setup.finish.appearance.title') });
    expect(await within(section).findByLabelText(new RegExp(tr('en').t('appearance.name.label')))).toBeInTheDocument();
    await view.user.click(within(section).getByRole('button', { name: en.t('setup.finish.appearance.skip') }));
    expect(screen.queryByLabelText(new RegExp(tr('en').t('appearance.name.label')))).toBeNull();
    fireEvent.click(document.body);
  });

  it('shows the done panel with the sign-in when the wizard already finished', async () => {
    const steps = stepsOf({ ...DONE, configure: 'succeeded', verify: 'succeeded', finish: 'succeeded' });
    await open(api(steps, {}, { state: { ...state, state: 'awaiting_first_signin' } }));
    const en = tr('en');
    expect(await screen.findByText(en.t('setup.finish.done.title'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.t('setup.finish.signIn') })).toHaveAttribute('href', '/auth/login?returnTo=%2F');
  });

  it('is in Dutch', async () => {
    await open(api(finishSteps(), {}, { state }), 'nl');
    const nl = tr('nl');
    expect(await screen.findByRole('heading', { level: 2, name: nl.t('setup.finish.title') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: nl.t('setup.finish.submit') })).toBeInTheDocument();
  });
});
