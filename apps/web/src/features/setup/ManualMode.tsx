import { buildDesiredState, desiredStateChecklist, INSTALL_TAG_PREFIX } from '@m365portal/shared/setup/desired-state';
import { EXCHANGE_APP_ROLES, GRAPH_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import { GuidSchema } from '@m365portal/shared/schemas/common';
import { ManualRequestSchema } from '@m365portal/shared/schemas/setup';
import { useMutation } from '@tanstack/react-query';
import { DownloadIcon, ExternalLinkIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { Button } from '../../components/ui/button';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { useLanguage } from '../../lib/locale';
import { ActionError } from './StepFrame';
import { setupApi, type ManualRequest } from './setup-api';
import type { WizardContext } from './wizard-context';

const NO_CONTROL = /^[^\p{Cc}\u2028\u2029]*$/u;

/**
 * The form's own schema: the two ids are those of `ManualRequestSchema` (picked, so the rule is written once)
 * and the first Owner is one line of text, an object id or a user principal name, that
 * `toManualRequest` turns into the request's `firstOwner`.
 */
export const ManualFormSchema = ManualRequestSchema.pick({ applicationClientId: true, tenantId: true }).extend({
  firstOwner: z.string().trim().min(3).max(256).regex(NO_CONTROL),
});
export type ManualForm = z.infer<typeof ManualFormSchema>;

/** The request for the server from validated form values. An object id is lower-cased as the wire wants it. */
export function toManualRequest(form: ManualForm): ManualRequest {
  const owner = form.firstOwner;
  return {
    applicationClientId: form.applicationClientId,
    tenantId: form.tenantId,
    firstOwner: GuidSchema.safeParse(owner).success ? { kind: 'oid', value: owner } : { kind: 'upn', value: owner },
  };
}

// Pages of Microsoft Learn the checklist points to (the catalogue holds the link texts).
export const MANUAL_LEARN_LINKS = Object.freeze([
  ['setup.manual.learn.register', 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app'],
  ['setup.manual.learn.certificate', 'https://learn.microsoft.com/entra/identity-platform/how-to-add-credentials'],
  ['setup.manual.learn.permissions', 'https://learn.microsoft.com/entra/identity-platform/quickstart-configure-app-access-web-apis'],
  ['setup.manual.learn.role', 'https://learn.microsoft.com/entra/identity/role-based-access-control/manage-roles-portal'],
] as const);

interface Item {
  readonly label: string;
  readonly values: readonly string[];
}

const DEFAULT_APPLICATION_NAME = 'M365Portal';

/**
 * The checklist for the portal, made from the same function that builds the document the automatic mode
 * sends (`buildDesiredState`), so the two cannot drift. Role ids are placeholders (the checklist shows
 * names). The install tag comes from the server (`installTag` of the setup state); its id builds the tag and
 * the description item, which verification (V3) checks on the application.
 */
function checklistFor(
  publicBaseUrl: string,
  installTag: string,
  exchange: boolean,
  thumbprint: string | null,
  t: (key: never) => string,
): Item[] {
  const names = [...GRAPH_APP_ROLES, ...(exchange ? [EXCHANGE_APP_ROLES.required] : [])];
  const roleIds = Object.fromEntries(names.map((name, index) => [name, `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`]));
  const desired = buildDesiredState({
    baseUrl: publicBaseUrl,
    installId: installTag.slice(INSTALL_TAG_PREFIX.length),
    applicationName: DEFAULT_APPLICATION_NAME,
    roleIds,
    exchange,
  });
  const byKey = new Map(desiredStateChecklist(desired, roleIds).map((item) => [item.key, item]));
  const list = (key: string): string[] => {
    const value = byKey.get(key)?.value;
    return Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : [];
  };
  const off = t('setup.manual.item.implicitFlows' as never);
  const items: Item[] = [
    { label: t('setup.manual.item.name' as never), values: list('application_name') },
    { label: t('setup.manual.item.description' as never), values: list('description') },
    { label: t('setup.manual.item.tags' as never), values: list('tags') },
    { label: t('setup.manual.item.redirectUris' as never), values: list('redirect_uris') },
    { label: off, values: [] },
    { label: t('setup.manual.item.graphPermissions' as never), values: list('graph_roles') },
  ];
  if (exchange) items.push({ label: t('setup.manual.item.exchangePermissions' as never), values: list('exchange_roles') });
  items.push(
    { label: t('setup.manual.item.consent' as never), values: [] },
    { label: t('setup.manual.item.optionalClaims' as never), values: list('optional_claims') },
    { label: t('setup.manual.item.certificate' as never), values: thumbprint === null ? [] : [thumbprint] },
  );
  if (exchange) items.push({ label: t('setup.manual.item.entraRole' as never), values: [t('setup.exchangeRole.exchange_administrator' as never)] });
  return items;
}

export interface ManualModeProps {
  readonly context: WizardContext;
  /** Back to the automatic way; absent once the server holds manual inputs. */
  readonly onBack?: () => void;
}

/** Manual mode (FR-B-218, EB-04): the checklist, the certificate to upload, and the three values to hand over. */
export function ManualMode({ context, onBack }: ManualModeProps) {
  const { t } = useLanguage().translator;
  const { state } = context;
  const [values, setValues] = useState({ applicationClientId: '', tenantId: '', firstOwner: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof typeof values, string>>>({});
  const items = useMemo(
    () => checklistFor(state.publicBaseUrl, state.installTag, state.exchangeEnabled, state.certificate?.thumbprintSha1.toLowerCase() ?? null, t as never),
    [state.publicBaseUrl, state.installTag, state.exchangeEnabled, state.certificate, t],
  );
  const send = useMutation({
    mutationFn: async (request: ManualRequest) => {
      await setupApi(context.api).manual(request);
    },
    onSuccess: () => {
      context.refresh();
      // The values are in; everything else the panel checks itself, with its own certificate.
      context.actions.start({ steps: ['verify'], mode: 'continue' });
    },
  });

  const submit = (): void => {
    const lower = (text: string): string => text.trim().toLowerCase();
    const parsed = ManualFormSchema.safeParse({
      applicationClientId: lower(values.applicationClientId),
      tenantId: lower(values.tenantId),
      firstOwner: values.firstOwner.trim(),
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'applicationClientId' || field === 'tenantId') next[field] = t('setup.manual.field.invalidGuid');
        else if (field === 'firstOwner') next.firstOwner = t('setup.manual.field.invalidOwner');
      }
      setErrors(next);
      return;
    }
    setErrors({});
    send.mutate(toManualRequest(parsed.data));
  };

  const field = (name: keyof typeof values, label: string, hint?: string) => (
    <FormField label={label} {...(hint === undefined ? {} : { hint })} {...(errors[name] === undefined ? {} : { error: errors[name] })}>
      {(control) => (
        <Input
          {...control}
          name={name}
          autoComplete="off"
          spellCheck={false}
          value={values[name]}
          onChange={(event) => {
            setValues({ ...values, [name]: event.target.value });
          }}
        />
      )}
    </FormField>
  );

  return (
    <section aria-labelledby="manual-title" className="flex flex-col gap-4">
      <h3 id="manual-title" className="text-subtitle font-semibold text-fg">
        {t('setup.manual.title')}
      </h3>
      <p className="max-w-prose text-body text-fg-secondary">{t('setup.manual.lead')}</p>
      <ol aria-label={t('setup.manual.checklist')} className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.label} className="rounded-md border border-line-subtle bg-surface-raised px-3 py-2">
            <p className="text-body font-medium text-fg">{item.label}</p>
            {item.values.length === 0 ? null : (
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {item.values.map((value) => (
                  <li key={value}>
                    <code className="select-all break-all font-mono text-body-sm text-fg-secondary">{value}</code>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-1">
        <a
          href="/api/v1/setup/certificate.cer"
          download
          className="inline-flex min-h-target w-fit items-center gap-1.5 rounded-sm text-accent-text underline underline-offset-4 hover:bg-accent-subtle"
        >
          <DownloadIcon aria-hidden="true" className="size-4" />
          {t('setup.manual.downloadCertificate')}
        </a>
        <p className="text-body-sm text-fg-muted">{t('setup.manual.downloadNote')}</p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-body-sm font-medium text-fg-secondary">{t('setup.manual.learn')}</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {MANUAL_LEARN_LINKS.map(([key, href]) => (
            <li key={key}>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-target items-center gap-1.5 rounded-sm text-accent-text underline underline-offset-4 hover:bg-accent-subtle"
              >
                {t(key)}
                <ExternalLinkIcon aria-hidden="true" className="size-4" />
              </a>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-body-sm text-fg-secondary">{t('setup.manual.partial')}</p>
      <form
        noValidate
        className="flex max-w-md flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {field('applicationClientId', t('setup.manual.field.clientId'))}
        {field('tenantId', t('setup.manual.field.tenantId'))}
        {field('firstOwner', t('setup.manual.field.owner'), t('setup.manual.field.ownerHelp'))}
        {send.isError ? <ActionError error={send.error} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={send.isPending || context.actions.busy}>
            {send.isPending ? t('setup.manual.submitting') : t('setup.manual.submit')}
          </Button>
          {onBack === undefined ? null : (
            <Button type="button" variant="secondary" onClick={onBack}>
              {t('setup.back')}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
