import type { MessageKey } from '@m365portal/shared/i18n';
import { EXCHANGE_APP_ROLES, GRAPH_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, TriangleAlertIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useLanguage } from '../../lib/locale';
import { resultText } from '../setup/hints';
import type { Proof } from '../setup/setup-api';

type Item = Proof['items'][number];

const MARKS = {
  ok: { Icon: CircleCheckIcon, tone: 'text-success' },
  warning: { Icon: TriangleAlertIcon, tone: 'text-warning' },
  failed: { Icon: CircleXIcon, tone: 'text-danger' },
  not_checked: { Icon: CircleDashedIcon, tone: 'text-fg-muted' },
} as const;

export interface ProofListProps {
  readonly proof: Proof | null;
  /** What the proof items do not carry: the page knows the application and the tenant. */
  readonly application?: { readonly appId: string; readonly displayName: string } | null;
  readonly tenant?: { readonly name: string | null; readonly initialDomain: string | null } | null;
  readonly className?: string;
}

/**
 * The proof list (FR-B-309, FR-B-319): one row per check that was made, with a status in words and an icon,
 * the time it was made and what it found, in the panel's words. The server sends keys and counts, never
 * text; the roles are named from the product's own lists. Used by the wizard (verify and finish) and by
 * the connection page.
 */
export function ProofList({ proof, application = null, tenant = null, className }: ProofListProps) {
  const { translator } = useLanguage();
  const { t, d } = translator;
  if (proof === null || proof.items.length === 0) {
    return <p className="text-body text-fg-secondary">{t('connection.proofEmpty')}</p>;
  }

  const num = (item: Item, name: string): number => {
    const value = item.params[name];
    return typeof value === 'number' ? value : 0;
  };
  const text = (item: Item, name: string): string | undefined => {
    const value = item.params[name];
    return value === undefined ? undefined : String(value);
  };

  const detail = (item: Item): string[] => {
    if (item.status === 'not_checked') return [t('connection.proofDetail.notChecked')];
    const lines: string[] = [];
    switch (item.key) {
      case 'application':
        if (application !== null) lines.push(t('connection.proofDetail.application', { name: application.displayName, appId: application.appId }));
        break;
      case 'service_principal': {
        const objectId = text(item, 'objectId');
        if (objectId !== undefined) lines.push(t('connection.proofDetail.service_principal', { objectId }));
        break;
      }
      case 'certificate': {
        const thumbprint = text(item, 'thumbprint') ?? text(item, 'thumbprint8');
        const notAfter = text(item, 'notAfter');
        if (thumbprint !== undefined && notAfter !== undefined && notAfter !== '') {
          lines.push(t('connection.proofDetail.certificate', { thumbprint, notAfter: d(Date.parse(notAfter)) }));
        }
        break;
      }
      case 'graph_roles':
      case 'exchange_roles': {
        const complete = num(item, 'missing') === 0 && num(item, 'extra') === 0;
        const names = item.key === 'graph_roles' ? [...GRAPH_APP_ROLES] : Object.values(EXCHANGE_APP_ROLES);
        if (complete) {
          const held = num(item, 'count');
          const roles = names.slice(0, held > 0 ? held : names.length).join(', ');
          lines.push(t(`connection.proofDetail.${item.key}` as MessageKey, { roles }));
        } else {
          lines.push(t('connection.proofDetail.roleCounts', { count: num(item, 'count'), missing: num(item, 'missing'), extra: num(item, 'extra') }));
        }
        break;
      }
      case 'entra_role':
        if (item.status === 'ok') lines.push(t('connection.proofDetail.entra_role', { role: t('setup.exchangeRole.exchange_administrator') }));
        break;
      case 'check_v2':
        if (item.status === 'ok' && tenant?.name != null) {
          lines.push(t('connection.proofDetail.check_v2', { name: tenant.name, domain: tenant.initialDomain ?? '-' }));
        }
        break;
      case 'check_v4':
        if (item.params.owners !== undefined) {
          lines.push(
            t('connection.proofDetail.check_v4', {
              passwordCredentials: num(item, 'passwordCredentials'),
              foreignKeyCredentials: num(item, 'foreignKeyCredentials'),
              owners: num(item, 'owners'),
            }),
          );
        }
        if (item.params.code === 'foreign_credential_present') lines.push(t('connection.proofDetail.foreignWarning'));
        break;
      default:
        break;
    }
    return lines;
  };

  return (
    <div className={cn('flex flex-col gap-2', className)} data-slot="proof-list">
      <p className="text-body-sm text-fg-muted">
        {t('connection.proofGeneratedAt', { time: d(Date.parse(proof.generatedAt), { dateStyle: 'medium', timeStyle: 'short' }) })}
      </p>
      <ul className="flex flex-col gap-2">
        {proof.items.map((item) => {
          const { Icon, tone } = MARKS[item.status];
          const code = typeof item.params.code === 'string' ? item.params.code : null;
          const why = code !== null && item.status !== 'ok' && item.status !== 'not_checked' && code !== 'foreign_credential_present' ? resultText(translator, code) : null;
          return (
            <li
              key={item.key}
              data-proof={item.key}
              data-status={item.status}
              className="flex flex-col gap-1 rounded-md border border-line-subtle bg-surface-raised px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-body font-medium text-fg">{t(`connection.proof.${item.key}`)}</span>
                <span className="ms-auto inline-flex items-center gap-1.5">
                  <Icon aria-hidden="true" className={cn('size-4', tone)} />
                  <span className="text-body-sm font-medium text-fg">{t(`connection.proofStatus.${item.status}`)}</span>
                </span>
              </div>
              {item.at === null ? null : (
                <p className="text-body-sm text-fg-muted">
                  <time dateTime={item.at}>
                    {t('connection.proofCheckedAt', {
                      time: d(Date.parse(item.at), { dateStyle: 'medium', timeStyle: 'medium' }),
                    })}
                  </time>
                </p>
              )}
              {detail(item).map((line) => (
                <p key={line} className="text-body-sm text-fg-secondary">
                  {line}
                </p>
              ))}
              {why === null ? null : (
                <>
                  <p className="text-body-sm text-fg">{why.message}</p>
                  <p className="text-body-sm text-fg-secondary">
                    <span className="font-medium">{t('setup.remedyLabel')}: </span>
                    {why.remedy}
                  </p>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
