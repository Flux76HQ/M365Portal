import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../../components/pages/PageHeader';
import { Skeleton } from '../../components/ui/skeleton';
import { Banner } from '../../components/ui/banner';
import { useLanguage } from '../../lib/locale';
import { useRouterContext } from '../../lib/router-context';
import { LoadError } from '../setup/LoadError';
import { LogRegion } from '../setup/LogRegion';
import { connectionApi, setupKeys } from '../setup/setup-api';
import { useRunPolling } from '../setup/useRunPolling';
import { useWizardActions } from '../setup/useWizardActions';
import { CertificateCard } from './CertificateCard';
import { ProofList } from './ProofList';
import { RepairPanel } from './RepairPanel';

function Section({ id, title, children }: { readonly id: string; readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-lg border border-line-subtle bg-surface-raised p-4">
      <h2 id={id} className="text-subtitle font-semibold text-fg">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * `/settings/connection` (T-B-303; FR-B-111, FR-B-220, FR-B-319; US-B9, US-B12): how the panel is connected to
 * the tenant and whether it is healthy. Read from `GET /api/v1/connection`; a repair or a verification is a
 * write through the step-up (the server asks, the dialog opens). The page needs `settings:connection`; the
 * route shows the in-place No-access content otherwise.
 */
export function ConnectionPage() {
  const { translator } = useLanguage();
  const { t } = translator;
  const { api } = useRouterContext();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: setupKeys.connection,
    queryFn: ({ signal }) => connectionApi(api).get(signal),
    staleTime: 0,
  });
  const reload = (): void => {
    void queryClient.invalidateQueries({ queryKey: setupKeys.connection });
  };
  const { state: poll, poke } = useRunPolling({ api, onSettled: reload });
  const actions = useWizardActions(api, poke);
  const verify = useMutation({ mutationFn: () => connectionApi(api).verify(), onSuccess: reload });

  let content;
  if (query.data === undefined) {
    content = query.isError ? (
      <LoadError
        title={t('connection.loadError')}
        error={query.error}
        retryLabel={t('connection.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    ) : (
      <div aria-busy="true" aria-label={t('connection.loading')} className="flex flex-col gap-4">
        <Skeleton height={96} />
        <Skeleton height={240} />
      </div>
    );
  } else {
    const data = query.data;
    const manual = data.mode === 'manual';
    content =
      data.tenant === null || data.application === null ? (
        <p className="text-body text-fg-secondary">{t('connection.notConnected')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {data.secrets.status === 'ok' ? null : (
            <Banner tone="danger" title={t('connection.secretsLabel')} className="rounded-md border border-line-subtle">
              {t(`connection.secrets.${data.secrets.status}`)}
            </Banner>
          )}
          <Section id="connection-tenant" title={t('connection.section.tenant')}>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-body">
              <dt className="text-fg-secondary">{t('connection.field.tenantName')}</dt>
              <dd className="text-fg">{data.tenant.name ?? t('connection.unknown')}</dd>
              <dt className="text-fg-secondary">{t('connection.field.initialDomain')}</dt>
              <dd className="text-fg">{data.tenant.initialDomain ?? t('connection.unknown')}</dd>
              <dt className="text-fg-secondary">{t('connection.field.tenantId')}</dt>
              <dd className="break-all font-mono text-body-sm text-fg">{data.tenant.tenantId}</dd>
              <dt className="text-fg-secondary">{t('connection.field.mode')}</dt>
              <dd className="text-fg">{t(`connection.mode.${data.mode}`)}</dd>
            </dl>
          </Section>
          <Section id="connection-application" title={t('connection.section.application')}>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-body">
              <dt className="text-fg-secondary">{t('connection.field.applicationName')}</dt>
              <dd className="text-fg">{data.application.displayName}</dd>
              <dt className="text-fg-secondary">{t('connection.field.appId')}</dt>
              <dd className="break-all font-mono text-body-sm text-fg">{data.application.appId}</dd>
              <dt className="text-fg-secondary">{t('connection.field.exchange')}</dt>
              <dd className="text-fg">{data.exchange.enabled ? t('connection.exchange.enabled') : t('connection.exchange.disabled')}</dd>
              <dt className="text-fg-secondary">{t('connection.field.permissionSet')}</dt>
              <dd className="text-fg">{data.permissionSetVersion}</dd>
              <dt className="text-fg-secondary">{t('connection.field.redirectUris')}</dt>
              <dd className="break-all text-fg">{data.redirectUris.join(', ')}</dd>
            </dl>
          </Section>
          {data.certificate === null ? null : (
            <Section id="connection-certificate" title={t('connection.section.certificate')}>
              <CertificateCard
                certificate={data.certificate}
                pending={data.pendingCertificate}
                applicationName={data.application.displayName}
                busy={actions.busy}
                {...(manual
                  ? {}
                  : {
                      onRenew: () => {
                        actions.start({ steps: 'repair', mode: 'reconcile' });
                      },
                    })}
              />
            </Section>
          )}
          <Section id="connection-proof" title={t('connection.section.proof')}>
            {data.verifiedAt === null ? null : (
              <p className="text-body-sm text-fg-muted">
                {t('connection.field.verifiedAt')}: {translator.d(Date.parse(data.verifiedAt), { dateStyle: 'medium', timeStyle: 'short' })}
              </p>
            )}
            <ProofList proof={data.proof} application={data.application} tenant={data.tenant} />
          </Section>
          <Section id="connection-repair" title={t('connection.repair.title')}>
            <RepairPanel
              connection={data}
              poll={poll}
              actions={actions}
              verify={{ run: () => { verify.mutate(); }, pending: verify.isPending, error: verify.error }}
            />
          </Section>
        </div>
      );
  }

  return (
    <>
      <PageHeader title={t('connection.title')} description={t('connection.lead')} />
      {content}
      <div className="mt-4">
        <Section id="connection-log" title={t('connection.section.log')}>
          {poll.lines.length === 0 ? (
            <p className="text-body-sm text-fg-muted">{t('connection.log.empty')}</p>
          ) : (
            <LogRegion lines={poll.lines} truncated={poll.truncated} />
          )}
        </Section>
      </div>
    </>
  );
}
