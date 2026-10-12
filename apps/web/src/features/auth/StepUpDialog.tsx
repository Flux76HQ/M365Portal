import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { currentReturnTo, loginUrl } from '../../lib/auth-nav';
import { useTranslator } from '../../lib/locale';
import { useAuthRuntime, useSessionSnapshot } from './runtime';

/**
 * "Bevestig met opnieuw aanmelden" (FR-B-411, FR-B-414 web half; plan 12.3). The API client records a
 * `step_up_required` answer in the session store; this dialog opens, says what happens next, and on
 * confirmation navigates to `/auth/login?purpose=stepup&returnTo=<the current path>`. The write that was
 * refused is not replayed: the person starts it again after coming back. Radix traps the focus while the
 * dialog is open and returns it to where it was.
 */
export function StepUpDialog() {
  const { t } = useTranslator();
  const { store, location } = useAuthRuntime();
  const { stepUpRequested } = useSessionSnapshot();
  return (
    <Dialog
      open={stepUpRequested}
      onOpenChange={(open) => {
        if (!open) store.dismissStepUp();
      }}
      title={t('session.stepUp.title')}
      description={t('session.stepUp.message')}
      closeLabel={t('session.close')}
      size="sm"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              store.dismissStepUp();
            }}
          >
            {t('session.stepUp.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              location.assign(
                loginUrl({ purpose: 'stepup', returnTo: currentReturnTo(location) }),
              );
            }}
          >
            {t('session.stepUp.confirm')}
          </Button>
        </>
      }
    />
  );
}
