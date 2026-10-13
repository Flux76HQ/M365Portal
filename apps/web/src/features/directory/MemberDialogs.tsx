// The two dialogs of member editing: who to add (a picker) and the confirmation of who is removed. They are
// a chunk of their own, loaded when the first button is pressed (`MemberActions`), so a page that only shows
// members does not carry the dialog, the picker and the alert dialog.
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { Dialog } from '../../components/ui/dialog';
import { useTranslator } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import { useMe } from '../../lib/router-context';
import type { PickerCandidate, PickerSearch } from './candidates';
import { MemberPicker } from './MemberPicker';
import type { MemberSelection } from './useMemberSelection';

/** The names listed in a confirmation: the first ten, and how many more. */
const NAMES_SHOWN = 10;

export interface MemberDialogsProps {
  readonly targetName: string;
  readonly scope: readonly unknown[];
  readonly search: PickerSearch;
  readonly variant: 'usersAndContacts' | 'users';
  readonly max: number;
  readonly stepUpAbove: number;
  readonly pending: boolean;
  readonly adding: boolean;
  readonly picked: readonly PickerCandidate[];
  readonly onPick: (next: readonly PickerCandidate[]) => void;
  readonly addError: unknown;
  readonly onCloseAdd: () => void;
  readonly onSubmitAdd: () => void;
  readonly removing: boolean;
  readonly selection: MemberSelection;
  readonly onCancelRemove: () => void;
  readonly onConfirmRemove: () => void;
}

export default function MemberDialogs({
  targetName,
  scope,
  search,
  variant,
  max,
  stepUpAbove,
  pending,
  adding,
  picked,
  onPick,
  addError,
  onCloseAdd,
  onSubmitAdd,
  removing,
  selection,
  onCancelRemove,
  onConfirmRemove,
}: MemberDialogsProps) {
  const translator = useTranslator();
  const { t } = translator;
  const me = useMe();

  const shownNames = [...selection.names.values()].slice(0, NAMES_SHOWN);
  const more = selection.count - shownNames.length;
  const removeDescription = `${t('distributionLists.remove.description', {
    names: shownNames.join(', '),
  })}${more > 0 ? ` ${t('distributionLists.remove.moreNames', { count: more })}` : ''}`;

  return (
    <>
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (!open) onCloseAdd();
        }}
        title={t('distributionLists.add.title')}
        description={t(
          variant === 'users'
            ? 'distributionLists.add.descriptionUsers'
            : 'distributionLists.add.description',
          { name: targetName },
        )}
        closeLabel={t('common.close')}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={onCloseAdd}>
              {t('distributionLists.add.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={picked.length === 0 || pending}
              aria-busy={pending ? true : undefined}
              onClick={onSubmitAdd}
            >
              {t('distributionLists.add.confirm', { count: picked.length })}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <MemberPicker
            scope={scope}
            search={search}
            selected={picked}
            onChange={onPick}
            max={max}
            variant={variant}
          />
          {picked.length > stepUpAbove ? (
            <p className="text-body-sm text-fg-secondary">
              {t('distributionLists.add.stepUp', { max: stepUpAbove })}
            </p>
          ) : null}
          {addError === null ? null : (
            <div role="alert" className="flex flex-col gap-1 text-body-sm">
              <p className="font-medium text-danger">{t('distributionLists.results.writeError')}</p>
              <p className="text-fg-secondary">
                {messageForError(translator, addError, { publicOrigin: me.publicOrigin })}
              </p>
            </div>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={removing}
        onOpenChange={(open) => {
          if (!open) onCancelRemove();
        }}
        objectName={targetName}
        title={t('distributionLists.remove.title', { count: selection.count })}
        description={removeDescription}
        confirmLabel={t('distributionLists.remove.confirm', { count: selection.count })}
        cancelLabel={t('distributionLists.remove.cancel')}
        pending={pending}
        onConfirm={onConfirmRemove}
      />
    </>
  );
}
