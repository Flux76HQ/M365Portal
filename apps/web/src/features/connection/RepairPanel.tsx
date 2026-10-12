import { Button } from '../../components/ui/button';
import { useLanguage } from '../../lib/locale';
import { DeviceCodePanel } from '../setup/DeviceCodePanel';
import { ActionError } from '../setup/StepFrame';
import type { ConnectionState } from '../setup/setup-api';
import type { RunPollState } from '../setup/useRunPolling';
import type { WizardActions } from '../setup/wizard-context';

/** The parts of the connection that a repair puts back. */
const REPAIRABLE = ['application', 'service_principal', 'certificate', 'graph_roles', 'exchange_roles', 'entra_role'] as const;

export interface RepairPanelProps {
  readonly connection: ConnectionState;
  readonly poll: RunPollState;
  readonly actions: WizardActions;
  readonly verify: { readonly run: () => void; readonly pending: boolean; readonly error: unknown };
}

/**
 * Repair and verify (FR-B-220, US-B9): "Repair everything" and, for a part that drifted, "Repair: <part>"
 * both start the one reconcile run (it only adds what is missing and reports what is extra; it never removes a
 * permission). A repair needs a fresh sign-in by an administrator, so the server asks for the step-up first
 * (the dialog opens, the write is not replayed) and the run shows a device code. A panel that was set up by
 * hand is repaired by hand, and "Verify" checks the result.
 */
export function RepairPanel({ connection, poll, actions, verify }: RepairPanelProps) {
  const { t } = useLanguage().translator;
  const run = poll.snapshot?.run ?? null;
  const active = connection.runActive || (run !== null && (run.status === 'running' || run.status === 'waiting'));
  const deviceCode = poll.snapshot?.deviceCode ?? null;
  const manual = connection.mode === 'manual';
  const drifted =
    connection.proof?.items.filter(
      (item) => item.status === 'failed' && (REPAIRABLE as readonly string[]).includes(item.key),
    ) ?? [];
  const repair = (): void => {
    actions.start({ steps: 'repair', mode: 'reconcile' });
  };
  const finished = !active && run?.kind === 'repair' && (run.status === 'succeeded' || run.status === 'warning');

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-prose text-body text-fg-secondary">{t('connection.repair.lead')}</p>
      {active ? (
        <>
          <p role="status" className="text-body font-medium text-fg">{t('connection.repair.running')}</p>
          {deviceCode === null ? null : (
            <DeviceCodePanel panel={deviceCode} offsetMs={poll.offsetMs} busy={actions.busy} onCancel={actions.cancel} />
          )}
        </>
      ) : (
        <>
          {finished ? <p role="status" className="text-body text-fg">{t('connection.repair.done')}</p> : null}
          {manual ? (
            <p className="text-body text-fg-secondary">{t('connection.repair.manualNote')}</p>
          ) : (
            <>
              <p className="text-body-sm text-fg-secondary">{t('connection.repair.needsSignIn')}</p>
              <p className="text-body-sm text-fg-secondary">{t('connection.repair.stepUpNote')}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={actions.busy} onClick={repair}>
                  {t('connection.repair.all')}
                </Button>
                {drifted.map((item) => (
                  <Button key={item.key} variant="secondary" disabled={actions.busy} onClick={repair}>
                    {t('connection.repair.oneFor', { part: t(`connection.proof.${item.key}`) })}
                  </Button>
                ))}
              </div>
            </>
          )}
          <div>
            <Button variant="secondary" disabled={verify.pending} onClick={verify.run}>
              {verify.pending ? t('connection.repair.verifying') : t('connection.repair.verify')}
            </Button>
          </div>
        </>
      )}
      {actions.error === null ? null : <ActionError error={actions.error} />}
      {verify.error === null ? null : <ActionError error={verify.error} />}
    </div>
  );
}
