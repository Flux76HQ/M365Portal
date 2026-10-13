// The delete dialog of a contact (FR-D-303, US-D2). It names the contact and says in how many distribution lists
// it is (Exchange removes it from them), asks for the display name to be typed, and sends that name as the
// `confirmName` of the DELETE. Nothing is sent before the name matches. The focus lands on Cancel, as in every
// confirmation (AlertDialog); the dialog closes itself only when the contact is gone, so a refusal is shown in place.
import type { ContactDetail } from '@m365portal/shared/schemas/contacts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AlertDialog } from 'radix-ui';
import { useState, type SyntheticEvent } from 'react';
import { Button } from '../../components/ui/button';
import {
  DIALOG_LAYER_CLASS,
  DIALOG_SCRIM_CLASS,
  DIALOG_SURFACE_CLASS,
  useFocusReturn,
} from '../../components/ui/dialog';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { useToast } from '../../components/ui/toast';
import { useTranslator } from '../../lib/locale';
import { cn } from '../../lib/cn';
import { messageForError } from '../../lib/problem';
import { useMe, useRouterContext } from '../../lib/router-context';
import {
  contactListsOptions,
  deleteContact,
  refreshContacts,
  refreshListsOfContacts,
} from './queries';

export interface DeleteContactDialogProps {
  readonly contact: ContactDetail;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** May the actor read distribution lists? Without it the number of lists cannot be known. */
  readonly canReadLists: boolean;
}

export function DeleteContactDialog({
  contact,
  open,
  onOpenChange,
  canReadLists,
}: DeleteContactDialogProps) {
  const translator = useTranslator();
  const { t } = translator;
  const me = useMe();
  const { api, queryClient } = useRouterContext();
  const navigate = useNavigate();
  const { toast } = useToast();
  const returnFocus = useFocusReturn(open);
  const [typed, setTyped] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const name = contact.displayName ?? '';
  const display = name === '' ? t('contacts.unnamed') : name;

  // The first page of the lists of the contact: the number the dialog names. It is the page the detail shows too.
  const lists = useQuery({
    ...contactListsOptions(api, contact.id, undefined),
    enabled: open && canReadLists,
    refetchOnWindowFocus: false,
  });

  // Opened again: an empty field and no message, adjusted while rendering.
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) {
      setTyped('');
      setMismatch(false);
      setFailure(null);
    }
  }

  let sentence: string;
  if (!canReadLists || lists.isError) sentence = t('contacts.delete.lists.unknown');
  else if (lists.data === undefined) sentence = t('contacts.delete.lists.checking');
  else if (lists.data.nextCursor !== undefined)
    sentence = t('contacts.delete.lists.more', { count: lists.data.items.length });
  else if (lists.data.items.length === 0) sentence = t('contacts.delete.lists.none');
  else sentence = t('contacts.delete.lists', { count: lists.data.items.length });

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setFailure(null);
    if (typed !== name || name === '') {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setPending(true);
    try {
      const answer = await deleteContact(api, contact.id, typed);
      refreshContacts(queryClient);
      refreshListsOfContacts(queryClient);
      const count = answer.removedFromLists.length;
      toast({
        title: count === 0 ? t('contacts.deleted.none') : t('contacts.deleted.lists', { count }),
        tone: 'success',
      });
      onOpenChange(false);
      void navigate({ to: '/contacts' });
    } catch (error) {
      setFailure(messageForError(translator, error, { publicOrigin: me.publicOrigin }));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay data-slot="dialog-overlay" className={DIALOG_SCRIM_CLASS} />
        <div data-slot="dialog-layer" className={DIALOG_LAYER_CLASS}>
          <AlertDialog.Content
            data-slot="confirm-dialog"
            className={cn(DIALOG_SURFACE_CLASS, 'max-w-md')}
            onCloseAutoFocus={returnFocus}
          >
            <form
              noValidate
              onSubmit={(event) => {
                void submit(event);
              }}
              className="flex min-h-0 flex-col"
            >
              <div className="flex flex-col gap-2 px-6 pt-6">
                <AlertDialog.Title className="text-title-3 font-semibold text-fg">
                  {t('contacts.delete.title')}
                </AlertDialog.Title>
                <AlertDialog.Description asChild>
                  <div className="flex flex-col gap-1 text-body text-fg-secondary">
                    <span data-slot="confirm-object" className="font-semibold break-words text-fg">
                      {display}
                    </span>
                    <span>{sentence}</span>
                    <span>{t('contacts.delete.description')}</span>
                  </div>
                </AlertDialog.Description>
              </div>
              <div className="flex flex-col gap-3 overflow-y-auto px-6 pt-4">
                <FormField
                  label={t('contacts.delete.confirmLabel')}
                  hint={t('contacts.delete.confirmHint')}
                  {...(mismatch ? { error: t('contacts.validation.confirm_mismatch') } : {})}
                >
                  {(control) => (
                    <Input
                      {...control}
                      value={typed}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => {
                        setTyped(event.target.value);
                      }}
                    />
                  )}
                </FormField>
                {failure === null ? null : (
                  <div role="alert" className="flex flex-col gap-1 text-body-sm">
                    <p className="font-medium text-danger">{t('contacts.delete.error')}</p>
                    <p className="text-fg-secondary">{failure}</p>
                  </div>
                )}
              </div>
              <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-line-subtle px-6 py-4">
                <AlertDialog.Cancel asChild>
                  <Button variant="secondary">{t('contacts.delete.cancel')}</Button>
                </AlertDialog.Cancel>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={pending}
                  aria-busy={pending ? true : undefined}
                >
                  {t('contacts.delete.confirm')}
                </Button>
              </div>
            </form>
          </AlertDialog.Content>
        </div>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
