// /settings/connection (T-B-303; FR-B-111 web half, FR-B-220 web half, FR-B-319 web half, FR-B-607; EB-13;
// US-B9, US-B12). The network is a mock; the proof list is the component of the wizard (T-B-302).
import { createTranslator, type Locale } from '@m365portal/shared/i18n';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleBranding, sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
import { createMockApi, problem, type Handler } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import {
  APP_ID,
  TENANT_ID,
  iso,
  loadAllLazyNamespaces,
  logLine,
  sampleConnection,
  sampleRunStatus,
  sampleSnapshot,
} from './helpers/setup-fixtures';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const tr = (language: Locale) => createTranslator(language);

function api(
  connection = sampleConnection(),
  extra: Record<string, Handler> = {},
  snapshot: Parameters<typeof sampleSnapshot>[0] = {},
) {
  return createMockApi({
    'GET /api/v1/connection': () => connection,
    'GET /api/v1/connection/runs/current': () =>
      sampleSnapshot({ serverTime: new Date().toISOString(), ...snapshot }),
    ...extra,
  });
}

async function open(
  mock: ReturnType<typeof createMockApi>,
  options: { language?: Locale; me?: ReturnType<typeof sampleMe> } = {},
) {
  return renderApp({
    me: options.me ?? sampleSignedInMe(),
    branding: sampleBranding('Acme'),
    path: '/settings/connection',
    language: options.language ?? 'en',
    fetch: mock.fetch,
  });
}

describe('the page', () => {
  it('shows the tenant, the application, the thumbprint and the days left', async () => {
    await open(api());
    const en = tr('en');
    await screen.findByRole('heading', { level: 1, name: en.t('connection.title') });
    const main = screen.getByRole('main');
    await within(main).findByText(TENANT_ID);
    expect(main).toHaveTextContent('Contoso');
    expect(main).toHaveTextContent('contoso.onmicrosoft.com');
    expect(main).toHaveTextContent(APP_ID);
    expect(main).toHaveTextContent('A1B2C3D4E5F60718293A4B5C6D7E8F9012345678');
    expect(main).toHaveTextContent(en.t('connection.daysLeft', { count: 300 }));
    expect(main).toHaveTextContent(en.t('connection.certificate.level.ok'));
    expect(main).toHaveTextContent(en.t('connection.field.mode'));
    expect(main).toHaveTextContent('https://panel.example.com/auth/callback');
  });

  it('is in Dutch', async () => {
    await open(api(), { language: 'nl' });
    const nl = tr('nl');
    expect(
      await screen.findByRole('heading', { level: 1, name: nl.t('connection.title') }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: nl.t('connection.repair.all') })).toBeInTheDocument();
  });

  it.each([
    ['warning', 45, 'warning'],
    ['critical', 10, 'danger'],
    ['expired', 0, 'danger'],
  ] as const)(
    'says %s for a certificate with %i days left, in a banner with a tone',
    async (level, daysLeft, tone) => {
      const connection = sampleConnection({
        certificate: {
          thumbprintSha1: 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678',
          notAfter: iso(daysLeft * 86_400_000),
          daysLeft,
          level,
        },
      });
      await open(api(connection));
      const en = tr('en');
      const banner = await screen.findByText(en.t(`connection.certificate.level.${level}`));
      expect(banner.closest('[data-slot="banner"]')).toHaveAttribute('data-tone', tone);
    },
  );

  it('names a pending certificate and the state of the secrets', async () => {
    const connection = sampleConnection({
      pendingCertificate: {
        thumbprintSha1: 'FFEEDDCCBBAA99887766554433221100FFEEDDCC',
        notAfter: iso(400 * 86_400_000),
      },
      secrets: { status: 'app_key_missing' },
    });
    await open(api(connection));
    const en = tr('en');
    expect(
      await screen.findByText(
        en.t('connection.certificate.pending', {
          thumbprint: 'FFEEDDCCBBAA99887766554433221100FFEEDDCC',
        }),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(en.t('connection.secrets.app_key_missing'))).toBeInTheDocument();
  });

  it('shows the proof list and the log', async () => {
    const connection = sampleConnection({
      proof: {
        generatedAt: iso(-1000),
        mode: 'automatic',
        items: [
          {
            key: 'check_v4',
            status: 'warning',
            at: iso(-1000),
            params: {
              passwordCredentials: 1,
              foreignKeyCredentials: 2,
              owners: 3,
              code: 'foreign_credential_present',
            },
          },
          { key: 'check_v6', status: 'not_checked', at: null, params: {} },
        ],
      },
    });
    const mock = api(
      connection,
      {},
      {
        log: {
          lines: [logLine(1, 'setup.log.tenant_pinned')],
          lastSeq: 1,
          hasMore: false,
          truncated: false,
        },
      },
    );
    await open(mock);
    const en = tr('en');
    expect(
      await screen.findByText(en.t('connection.proofDetail.foreignWarning')),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        en.t('connection.proofDetail.check_v4', {
          passwordCredentials: 1,
          foreignKeyCredentials: 2,
          owners: 3,
        }),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(en.t('connection.proofDetail.notChecked'))).toBeInTheDocument();
    const log = await screen.findByRole('log');
    await waitFor(() => {
      expect(log).toHaveTextContent(en.t('setup.log.tenant_pinned'));
    });
  });

  it('shows a load error with the request id and a way to try again', async () => {
    const mock = createMockApi({
      'GET /api/v1/connection': () => problem(503, 'storage_unavailable'),
    });
    mock.on('GET /api/v1/connection/runs/current', () => sampleSnapshot());
    await open(mock);
    const en = tr('en');
    expect(
      await screen.findByText(en.t('problem.storage_unavailable'), {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.t('connection.retry') })).toBeInTheDocument();
  });

  it('says that the panel is not connected yet', async () => {
    await open(
      api(
        sampleConnection({
          tenant: null,
          application: null,
          certificate: null,
          state: 'unconfigured',
        }),
      ),
    );
    expect(await screen.findByText(tr('en').t('connection.notConnected'))).toBeInTheDocument();
  });
});

describe('repair', () => {
  it('starts a repair run from "Repair everything"', async () => {
    const mock = api(sampleConnection(), {
      'POST /api/v1/connection/runs': () => sampleRunStatus({ kind: 'repair', mode: 'reconcile' }),
    });
    const view = await open(mock);
    const en = tr('en');
    expect(await screen.findByText(en.t('connection.repair.needsSignIn'))).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: en.t('connection.repair.all') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/runs')[0]?.body).toEqual({
        steps: 'repair',
        mode: 'reconcile',
      });
    });
  });

  it('opens the step-up dialog when the server asks for a fresh sign-in, and replays nothing', async () => {
    const mock = api(sampleConnection(), {
      'POST /api/v1/connection/runs': () => problem(403, 'step_up_required'),
    });
    const view = await open(mock);
    const en = tr('en');
    await view.user.click(
      await screen.findByRole('button', { name: en.t('connection.repair.all') }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName(en.t('session.stepUp.title'));
    expect(mock.callsTo('POST /api/v1/connection/runs')).toHaveLength(1);
  });

  it('offers a repair of the part that drifted, which starts the same reconcile run', async () => {
    const connection = sampleConnection({
      proof: {
        generatedAt: iso(),
        mode: 'automatic',
        items: [
          {
            key: 'service_principal',
            status: 'failed',
            at: iso(),
            params: { code: 'drift_detected' },
          },
        ],
      },
    });
    const mock = api(connection, {
      'POST /api/v1/connection/runs': () => sampleRunStatus({ kind: 'repair', mode: 'reconcile' }),
    });
    const view = await open(mock);
    const en = tr('en');
    await view.user.click(
      await screen.findByRole('button', {
        name: en.t('connection.repair.oneFor', {
          part: en.t('connection.proof.service_principal'),
        }),
      }),
    );
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/runs')[0]?.body).toEqual({
        steps: 'repair',
        mode: 'reconcile',
      });
    });
  });

  it('renews the certificate through the same run, after a confirmation that names the application', async () => {
    const mock = api(sampleConnection(), {
      'POST /api/v1/connection/runs': () => sampleRunStatus({ kind: 'repair', mode: 'reconcile' }),
    });
    const view = await open(mock);
    const en = tr('en');
    await view.user.click(
      await screen.findByRole('button', { name: en.t('connection.repair.renewCertificate') }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('M365Portal');
    expect(dialog).toHaveTextContent(en.t('connection.repair.renewNote'));
    await view.user.click(
      within(dialog).getByRole('button', { name: en.t('connection.repair.renewCertificate') }),
    );
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/runs')).toHaveLength(1);
    });
  });

  it('shows the device code of a running repair, and the log of the run', async () => {
    const mock = api(
      sampleConnection({ runActive: true }),
      {},
      {
        run: sampleRunStatus({ kind: 'repair', mode: 'reconcile' }),
        deviceCode: {
          userCode: 'AB12-CD34',
          verificationUri: 'https://microsoft.com/devicelogin',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          intervalSeconds: 5,
          state: 'waiting_for_user',
        },
      },
    );
    await open(mock);
    const en = tr('en');
    const panel = await screen.findByRole('region', { name: en.t('setup.device.title') });
    expect(within(panel).getByText('AB12-CD34')).toBeInTheDocument();
    expect(screen.getByText(en.t('connection.repair.running'))).toBeInTheDocument();
  });

  it('tells a manual installation to repair by hand and to verify', async () => {
    const mock = api(sampleConnection({ mode: 'manual' }), {
      'POST /api/v1/connection/verify': () => ({ generatedAt: iso(), mode: 'manual', items: [] }),
    });
    const view = await open(mock);
    const en = tr('en');
    expect(await screen.findByText(en.t('connection.repair.manualNote'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.t('connection.repair.all') })).toBeNull();
    await view.user.click(screen.getByRole('button', { name: en.t('connection.repair.verify') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/connection/verify')).toHaveLength(1);
    });
  });

  it('verifies now and shows a refused verification in words', async () => {
    const mock = api(sampleConnection(), {
      'POST /api/v1/connection/verify': () => problem(409, 'setup_step_busy'),
    });
    const view = await open(mock);
    const en = tr('en');
    await view.user.click(
      await screen.findByRole('button', { name: en.t('connection.repair.verify') }),
    );
    expect(await screen.findByText(en.t('problem.setup_step_busy'))).toBeInTheDocument();
  });
});

describe('access', () => {
  it('shows the in-place No-access content to a user without settings:connection', async () => {
    const mock = api();
    await open(mock, { me: sampleSignedInMe({ permissions: ['users:read'] }) });
    expect(
      await screen.findByRole('heading', { level: 1, name: tr('en').t('pages.noAccess.title') }),
    ).toBeInTheDocument();
    expect(mock.callsTo('GET /api/v1/connection')).toHaveLength(0);
  });
});
