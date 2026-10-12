// WIZARD STEPS 1 AND 2: ENVIRONMENT, DEVICE CODE, MANUAL MODE (T-B-301; FR-B-221, FR-B-214 link rule,
// FR-B-218 web half; EB-03, EB-04; US-B2). The network is a mock; no Microsoft text is ever rendered.
import { createTranslator, type Locale } from '@m365portal/shared/i18n';
import { ENVIRONMENT_CHECK_KEYS } from '@m365portal/shared/setup/result-codes';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { DeviceCodePanel } from '../src/features/setup/DeviceCodePanel';
import { ManualFormSchema } from '../src/features/setup/ManualMode';
import { LanguageProvider, createLanguageController } from '../src/lib/locale';
import { createStorage } from '../src/lib/storage';
import { sampleBranding, sampleMe } from './helpers/boot-fixtures';
import { createMockApi, problem } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import {
  APP_ID,
  OWNER_ID,
  TENANT_ID,
  loadAllLazyNamespaces,
  sampleEnvironment,
  sampleRunStatus,
  sampleSetupState,
  sampleSnapshot,
  stepsOf,
} from './helpers/setup-fixtures';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const tr = (language: Locale) => createTranslator(language);

function api(
  steps = stepsOf(),
  extra: Record<string, (call: never) => unknown> = {},
  options: { mode?: 'automatic' | 'manual'; snapshot?: ReturnType<typeof sampleSnapshot> } = {},
) {
  return createMockApi({
    'GET /api/v1/setup/status': () => ({ state: 'in_progress', tokenRequired: false }),
    'GET /api/v1/setup/state': () => sampleSetupState({ steps, mode: options.mode ?? 'automatic' }),
    'GET /api/v1/connection/runs/current': () => options.snapshot ?? sampleSnapshot({ steps }),
    'POST /api/v1/setup/environment': () => sampleEnvironment(),
    ...(extra as Record<string, never>),
  });
}

async function open(mock: ReturnType<typeof createMockApi>, language: Locale = 'en') {
  return renderApp({
    me: sampleMe({ kind: 'setup', setupState: 'in_progress' }),
    branding: sampleBranding('Acme'),
    path: '/setup',
    language,
    fetch: mock.fetch,
  });
}

describe('step 1, the environment', () => {
  it('runs the six checks on arrival and shows each with an icon, words and, when not ok, the remedy', async () => {
    const mock = api(stepsOf(), {
      'POST /api/v1/setup/environment': () =>
        sampleEnvironment({
          node_version: { status: 'warn', code: 'node_version_unsupported' },
          time_skew: { status: 'warn', code: 'time_skew_warning' },
        }),
    });
    await open(mock);
    const en = tr('en');
    await screen.findByRole('heading', { level: 2, name: en.t('setup.environment.title') });
    const panel = document.querySelector<HTMLElement>('[data-step-panel="environment"]')!;
    const rows = await within(panel).findAllByRole('listitem');
    expect(rows).toHaveLength(ENVIRONMENT_CHECK_KEYS.length);
    expect(mock.callsTo('POST /api/v1/setup/environment')).toHaveLength(1);
    ENVIRONMENT_CHECK_KEYS.forEach((key, index) => {
      expect(rows[index]).toHaveTextContent(en.t(`setup.sub.${key}`));
      expect(rows[index]?.querySelector('svg')).not.toBeNull();
    });
    // ok: words and the sentence of the check
    expect(rows[0]).toHaveTextContent(en.t('setup.check.ok'));
    expect(rows[0]).toHaveTextContent(en.t('setup.checkOk.public_base_url'));
    // warn: words, the message and the remedy of the code
    const node = rows[ENVIRONMENT_CHECK_KEYS.indexOf('node_version')];
    expect(node).toHaveTextContent(en.t('setup.check.warn'));
    expect(node).toHaveTextContent(en.t('setup.result.node_version_unsupported'));
    expect(node).toHaveTextContent(en.t('setup.remedy.node_version_unsupported'));
    expect(screen.getByText(en.t('setup.environment.warnings'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.t('setup.continue') })).toBeEnabled();
  });

  it('blocks the next step while a check failed, and runs again on "Check again"', async () => {
    let attempt = 0;
    const mock = api(stepsOf(), {
      'POST /api/v1/setup/environment': () => {
        attempt += 1;
        return attempt === 1
          ? sampleEnvironment({ data_dir: { status: 'fail', code: 'data_dir_not_writable' } })
          : sampleEnvironment();
      },
    });
    const view = await open(mock);
    const en = tr('en');
    await screen.findByText(en.t('setup.environment.blocking'));
    expect(screen.queryByRole('button', { name: en.t('setup.continue') })).toBeNull();
    const rows = within(
      document.querySelector<HTMLElement>('[data-step-panel="environment"]')!,
    ).getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent(en.t('setup.check.fail'));
    expect(rows[1]).toHaveTextContent(en.t('setup.remedy.data_dir_not_writable'));
    await view.user.click(screen.getByRole('button', { name: en.t('setup.environment.recheck') }));
    await screen.findByText(en.t('setup.environment.allOk'));
    expect(mock.callsTo('POST /api/v1/setup/environment')).toHaveLength(2);
    expect(screen.getByRole('button', { name: en.t('setup.continue') })).toBeEnabled();
  });

  it('shows a failed run of the checks with a way to try again', async () => {
    const mock = api(stepsOf(), {
      'POST /api/v1/setup/environment': () => problem(503, 'storage_unavailable'),
    });
    const view = await open(mock);
    const en = tr('en');
    expect(await screen.findByRole('alert')).toHaveTextContent(en.t('problem.storage_unavailable'));
    await view.user.click(screen.getByRole('button', { name: en.t('setup.environment.recheck') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/setup/environment')).toHaveLength(2);
    });
  });

  it('is in Dutch', async () => {
    await open(api(), 'nl');
    const nl = tr('nl');
    expect(
      await screen.findByRole('heading', { level: 2, name: nl.t('setup.environment.title') }),
    ).toBeInTheDocument();
    expect(await screen.findByText(nl.t('setup.environment.allOk'))).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: nl.t('setup.environment.recheck') }),
    ).toBeInTheDocument();
  });
});

describe('step 2, connect', () => {
  const ready = () => stepsOf({ environment: 'succeeded' });

  async function toConnect(mock: ReturnType<typeof createMockApi>, language: Locale = 'en') {
    const view = await open(mock, language);
    const t = tr(language);
    await view.user.click(await screen.findByRole('button', { name: t.t('setup.continue') }));
    await screen.findByRole('heading', { level: 2, name: t.t('setup.connect.title') });
    return view;
  }

  it('offers an optional tenant and "Sign in with Microsoft", which starts the run', async () => {
    const mock = api(ready(), { 'POST /api/v1/connection/runs': () => sampleRunStatus() });
    const view = await toConnect(mock);
    const en = tr('en');
    const field = screen.getByLabelText(en.t('setup.connect.tenant.label'));
    await view.user.type(field, 'contoso.onmicrosoft.com');
    expect(screen.getByText(en.t('setup.connect.consentWarning'))).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: en.t('setup.connect.start') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/runs')).toHaveLength(1);
    });
    expect(mock.callsTo('POST /api/v1/connection/runs')[0]?.body).toEqual({
      steps: ['connect', 'configure', 'verify'],
      mode: 'continue',
      tenantHint: 'contoso.onmicrosoft.com',
    });
  });

  it('refuses a tenant hint that is not a domain or a tenant id, and sends nothing', async () => {
    const mock = api(ready(), { 'POST /api/v1/connection/runs': () => sampleRunStatus() });
    const view = await toConnect(mock);
    const en = tr('en');
    for (const bad of ['common', 'has space.com', 'a/b', 'ORGANIZATIONS']) {
      const field = screen.getByLabelText(en.t('setup.connect.tenant.label'));
      await view.user.clear(field);
      await view.user.type(field, bad);
      await view.user.click(screen.getByRole('button', { name: en.t('setup.connect.start') }));
      expect(await screen.findByText(en.t('setup.connect.tenant.invalid'))).toBeInTheDocument();
    }
    expect(mock.callsTo('POST /api/v1/connection/runs')).toHaveLength(0);
  });

  it('starts without a tenant when the field is empty', async () => {
    const mock = api(ready(), { 'POST /api/v1/connection/runs': () => sampleRunStatus() });
    const view = await toConnect(mock);
    await view.user.click(screen.getByRole('button', { name: tr('en').t('setup.connect.start') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/runs')).toHaveLength(1);
    });
    expect(mock.callsTo('POST /api/v1/connection/runs')[0]?.body).toEqual({
      steps: ['connect', 'configure', 'verify'],
      mode: 'continue',
    });
  });

  it('shows why a start was refused, in words', async () => {
    const mock = api(ready(), {
      'POST /api/v1/connection/runs': () => problem(409, 'setup_step_busy'),
    });
    const view = await toConnect(mock);
    const en = tr('en');
    await view.user.click(screen.getByRole('button', { name: en.t('setup.connect.start') }));
    expect(await screen.findByText(en.t('problem.setup_step_busy'))).toBeInTheDocument();
  });

  it('shows the device-code panel from the snapshot, with the code as text and the instruction', async () => {
    const steps = stepsOf({ environment: 'succeeded', connect: 'running' });
    const mock = api(
      steps,
      {},
      {
        snapshot: sampleSnapshot({
          steps,
          serverTime: new Date().toISOString(),
          run: sampleRunStatus(),
          deviceCode: {
            userCode: 'AB12-CD34',
            verificationUri: 'https://microsoft.com/devicelogin',
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            intervalSeconds: 5,
            state: 'waiting_for_user',
          },
        }),
      },
    );
    const view = await toConnect(mock);
    const en = tr('en');
    const panel = await screen.findByRole('region', { name: en.t('setup.device.title') });
    expect(within(panel).getByText('AB12-CD34').tagName).toBe('CODE');
    expect(within(panel).getByText(en.t('setup.device.instruction'))).toBeInTheDocument();
    expect(within(panel).getByText(en.t('setup.connect.consentWarning'))).toBeInTheDocument();
    expect(within(panel).getByText(/The code expires in (14:5\d|15:0[0-5])\./)).toBeInTheDocument();
    const link = within(panel).getByRole('link', { name: new RegExp(en.t('setup.device.link')) });
    expect(link).toHaveAttribute('href', 'https://microsoft.com/devicelogin');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    mock.on('POST /api/v1/connection/runs/current/cancel', () =>
      sampleRunStatus({ cancelRequested: true }),
    );
    await view.user.click(within(panel).getByRole('button', { name: en.t('setup.device.cancel') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/runs/current/cancel')).toHaveLength(1);
    });
  });

  it('names Conditional Access for a blocked device code and offers the manual mode, never a client id', async () => {
    const steps = stepsOf(
      { environment: 'succeeded', connect: 'failed' },
      { device_code: { status: 'failed', errorCode: 'device_code_blocked' } },
    );
    const mock = api(steps);
    const view = await toConnect(mock);
    const en = tr('en');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Conditional Access');
    expect(alert).toHaveTextContent(en.t('setup.result.device_code_blocked'));
    expect(screen.queryByLabelText(/client id/i)).toBeNull();
    await view.user.click(screen.getByRole('button', { name: en.t('setup.connect.manualLink') }));
    expect(
      await screen.findByRole('heading', { level: 3, name: en.t('setup.manual.title') }),
    ).toBeInTheDocument();
    // Back to the automatic way.
    await view.user.click(screen.getByRole('button', { name: en.t('setup.back') }));
    expect(
      await screen.findByRole('button', { name: en.t('setup.connect.start') }),
    ).toBeInTheDocument();
  });
});

describe('the device-code panel (a closed set of links)', () => {
  function panel(uri: string | null, language: Locale = 'en') {
    const controller = createLanguageController({
      storage: createStorage(null),
      languages: [language],
      root: document.createElement('html'),
    });
    return render(
      <LanguageProvider controller={controller}>
        <DeviceCodePanel
          panel={{
            userCode: 'AB12-CD34',
            verificationUri: uri,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            intervalSeconds: 5,
            state: 'waiting_for_user',
          }}
          offsetMs={0}
          busy={false}
          onCancel={() => undefined}
        />
      </LanguageProvider>,
    );
  }

  it.each([
    'https://microsoft.com/devicelogin',
    'https://www.microsoft.com/link',
    'https://login.microsoftonline.com/common/oauth2/deviceauth',
  ])('renders a link for %s', (uri) => {
    panel(uri);
    expect(screen.getByRole('link', { name: /Open the Microsoft sign-in page/ })).toHaveAttribute(
      'href',
      uri,
    );
  });

  it.each([
    'javascript:alert(1)',
    'https://microsoft.com.evil.test/devicelogin',
    'http://microsoft.com/devicelogin',
    'https://evil.test/devicelogin',
    'https://user@microsoft.com/devicelogin',
    'https://microsoft.com:8443/devicelogin',
    'data:text/html,hi',
    null,
  ])('renders no link for %s, only the code and the instruction', (uri) => {
    panel(uri);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(tr('en').t('setup.device.noLink'))).toBeInTheDocument();
    expect(screen.getByText('AB12-CD34')).toBeInTheDocument();
  });

  it('copies the code and says so, or says it could not', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    panel('https://microsoft.com/devicelogin');
    const en = tr('en');
    fireEvent.click(screen.getByRole('button', { name: en.t('setup.device.copy') }));
    expect(await screen.findByText(en.t('setup.device.copied'))).toBeInTheDocument();
    expect(written).toEqual(['AB12-CD34']);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    fireEvent.click(screen.getByRole('button', { name: en.t('setup.device.copy') }));
    expect(await screen.findByText(en.t('setup.device.copyFailed'))).toBeInTheDocument();
  });

  it('says in words what became of the sign-in', () => {
    for (const state of ['signed_in', 'expired', 'declined', 'cancelled', 'blocked'] as const) {
      const controller = createLanguageController({
        storage: createStorage(null),
        languages: ['en'],
        root: document.createElement('html'),
      });
      const { unmount } = render(
        <LanguageProvider controller={controller}>
          <DeviceCodePanel
            panel={{
              userCode: 'AB12-CD34',
              verificationUri: null,
              expiresAt: new Date(Date.now()).toISOString(),
              intervalSeconds: 5,
              state,
            }}
            offsetMs={0}
            busy={false}
            onCancel={() => undefined}
          />
        </LanguageProvider>,
      );
      expect(screen.getByRole('status')).toHaveTextContent(
        tr('en').t(`setup.deviceState.${state}`),
      );
      unmount();
    }
  });
});

describe('manual mode', () => {
  const ready = () => stepsOf({ environment: 'succeeded' });

  async function toManual(mock: ReturnType<typeof createMockApi>, language: Locale = 'en') {
    const view = await open(mock, language);
    const t = tr(language);
    await view.user.click(await screen.findByRole('button', { name: t.t('setup.continue') }));
    await view.user.click(
      await screen.findByRole('button', { name: t.t('setup.connect.manualLink') }),
    );
    await screen.findByRole('heading', { level: 3, name: t.t('setup.manual.title') });
    return view;
  }

  it('lists the install tag and the description the verification asks for, in both languages', async () => {
    await toManual(api(ready()));
    const en = tr('en');
    const section = screen.getByRole('region', { name: en.t('setup.manual.title') });
    const checklist = within(section).getByRole('list', { name: en.t('setup.manual.checklist') });
    const installTag = `m365portal-install-${'1234abcd'.repeat(4)}`;
    const tags = within(checklist).getByText(en.t('setup.manual.item.tags')).closest('li');
    expect(tags?.textContent).toContain('m365portal');
    expect(tags?.textContent).toContain(installTag);
    const description = within(checklist)
      .getByText(en.t('setup.manual.item.description'))
      .closest('li');
    expect(description?.textContent).toContain(
      'Created by the M365Portal setup wizard (install 1234abcd)',
    );
    // The placeholder install id of the old checklist is gone.
    expect(checklist.textContent).not.toContain('0'.repeat(32));
    expect(tr('nl').t('setup.manual.item.tags')).not.toBe(en.t('setup.manual.item.tags'));
    expect(tr('nl').t('setup.manual.item.description')).not.toBe(
      en.t('setup.manual.item.description'),
    );
  });

  it('shows the checklist built from the desired state, the certificate download and three inputs', async () => {
    await toManual(api(ready()));
    const en = tr('en');
    const section = screen.getByRole('region', { name: en.t('setup.manual.title') });
    const checklist = within(section).getByRole('list', { name: en.t('setup.manual.checklist') });
    const text = checklist.textContent;
    expect(text).toContain(en.t('setup.manual.item.name'));
    expect(text).toContain('M365Portal');
    expect(text).toContain('https://panel.example.com/auth/callback');
    for (const role of [
      'User.Read.All',
      'GroupMember.Read.All',
      'GroupMember.ReadWrite.All',
      'Organization.Read.All',
      'Exchange.ManageAsApp',
    ]) {
      expect(text).toContain(role);
    }
    expect(text).toContain('amr');
    expect(text).toContain('auth_time');
    // A role the product never grants is not in the list.
    expect(text).not.toContain('Application.ReadWrite.All');
    const download = within(section).getByRole('link', {
      name: en.t('setup.manual.downloadCertificate'),
    });
    expect(download).toHaveAttribute('href', '/api/v1/setup/certificate.cer');
    expect(download).toHaveAttribute('download');
    expect(within(section).getByLabelText(en.t('setup.manual.field.clientId'))).toBeInTheDocument();
    expect(within(section).getByLabelText(en.t('setup.manual.field.tenantId'))).toBeInTheDocument();
    expect(within(section).getByLabelText(en.t('setup.manual.field.owner'))).toBeInTheDocument();
    const links = within(section)
      .getAllByRole('link')
      .filter((link) => link !== download);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/^https:\/\/learn\.microsoft\.com\//);
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('validates the three inputs inline and sends nothing while one is wrong', async () => {
    const mock = api(ready());
    const view = await toManual(mock);
    const en = tr('en');
    await view.user.type(screen.getByLabelText(en.t('setup.manual.field.clientId')), 'not-a-guid');
    await view.user.type(screen.getByLabelText(en.t('setup.manual.field.tenantId')), TENANT_ID);
    await view.user.type(screen.getByLabelText(en.t('setup.manual.field.owner')), 'x');
    await view.user.click(screen.getByRole('button', { name: en.t('setup.manual.submit') }));
    expect((await screen.findAllByText(en.t('setup.manual.field.invalidGuid'))).length).toBe(1);
    expect(screen.getByText(en.t('setup.manual.field.invalidOwner'))).toBeInTheDocument();
    expect(screen.getByLabelText(en.t('setup.manual.field.clientId'))).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(mock.callsTo('PUT /api/v1/setup/manual')).toHaveLength(0);
  });

  it('sends an object id as an oid and a user principal name as a upn, then verifies', async () => {
    for (const [owner, expected] of [
      [OWNER_ID, { kind: 'oid', value: OWNER_ID }],
      ['anna@contoso.com', { kind: 'upn', value: 'anna@contoso.com' }],
    ] as const) {
      const mock = api(ready(), {
        'PUT /api/v1/setup/manual': () => ({
          mode: 'manual',
          applicationClientId: APP_ID,
          tenantId: TENANT_ID,
          designatedOwner: { oid: OWNER_ID, upnLabel: 'anna@contoso.com', nameLabel: null },
        }),
        'POST /api/v1/connection/runs': () => sampleRunStatus({ steps: ['verify'] }),
      });
      const view = await toManual(mock);
      const en = tr('en');
      await view.user.type(screen.getByLabelText(en.t('setup.manual.field.clientId')), APP_ID);
      await view.user.type(screen.getByLabelText(en.t('setup.manual.field.tenantId')), TENANT_ID);
      await view.user.type(screen.getByLabelText(en.t('setup.manual.field.owner')), owner);
      await view.user.click(screen.getByRole('button', { name: en.t('setup.manual.submit') }));
      await waitFor(() => {
        expect(mock.callsTo('POST /api/v1/connection/runs')).toHaveLength(1);
      });
      expect(mock.callsTo('PUT /api/v1/setup/manual')[0]?.body).toEqual({
        applicationClientId: APP_ID,
        tenantId: TENANT_ID,
        firstOwner: expected,
      });
      expect(mock.callsTo('POST /api/v1/connection/runs')[0]?.body).toEqual({
        steps: ['verify'],
        mode: 'continue',
      });
      document.body.innerHTML = '';
    }
  });

  it('shows a refused hand-over in words and keeps the values', async () => {
    const mock = api(ready(), {
      'PUT /api/v1/setup/manual': () => problem(422, 'principal_unknown'),
    });
    const view = await toManual(mock);
    const en = tr('en');
    await view.user.type(screen.getByLabelText(en.t('setup.manual.field.clientId')), APP_ID);
    await view.user.type(screen.getByLabelText(en.t('setup.manual.field.tenantId')), TENANT_ID);
    await view.user.type(screen.getByLabelText(en.t('setup.manual.field.owner')), OWNER_ID);
    await view.user.click(screen.getByRole('button', { name: en.t('setup.manual.submit') }));
    expect(await screen.findByText(en.t('problem.principal_unknown'))).toBeInTheDocument();
    expect(screen.getByLabelText(en.t('setup.manual.field.clientId'))).toHaveValue(APP_ID);
  });

  it('ManualFormSchema is derived from the request schema: the same GUID rule, one owner text', () => {
    const ok = ManualFormSchema.safeParse({
      applicationClientId: APP_ID,
      tenantId: TENANT_ID,
      firstOwner: 'anna@contoso.com',
    });
    expect(ok.success).toBe(true);
    expect(
      ManualFormSchema.safeParse({
        applicationClientId: 'x',
        tenantId: TENANT_ID,
        firstOwner: 'anna@contoso.com',
      }).success,
    ).toBe(false);
    expect(
      ManualFormSchema.safeParse({
        applicationClientId: APP_ID,
        tenantId: TENANT_ID,
        firstOwner: 'a',
      }).success,
    ).toBe(false);
    expect(
      ManualFormSchema.safeParse({
        applicationClientId: APP_ID,
        tenantId: TENANT_ID,
        firstOwner: 'a\u0000b@c.d',
      }).success,
    ).toBe(false);
  });

  it('is in Dutch', async () => {
    await toManual(api(ready()), 'nl');
    const nl = tr('nl');
    expect(screen.getByLabelText(nl.t('setup.manual.field.clientId'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: nl.t('setup.manual.submit') })).toBeInTheDocument();
  });
});
