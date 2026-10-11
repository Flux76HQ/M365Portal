import type { ReactNode } from 'react';
import { AlertDialog } from 'radix-ui';
import { Button } from './button';
import {
  DIALOG_LAYER_CLASS,
  DIALOG_SCRIM_CLASS,
  DIALOG_SURFACE_CLASS,
  useFocusReturn,
} from './dialog';
import { cn } from '../../lib/cn';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * The name of the thing the action is applied to ("Alice Example", "Appearance of Contoso").
   * Required, and it must not be blank: there is no generic "Are you sure?" confirmation in this
   * application (FR-A-124). The name is shown as its own line and is part of the dialog's
   * accessible description, so it is read out when the dialog opens.
   */
  readonly objectName: string;
  /**
   * The same sentence as nodes, shown instead of the plain `objectName` when text a person typed (an
   * organisation name) is part of it: build it with `isolatedMessage` so a right-to-left name sits in
   * a `<bdi>` and does not reorder the sentence (E-07). `objectName` stays the blank check and the
   * text equivalent.
   */
  readonly objectContent?: ReactNode;
  /** The question or the action, without the object ("Delete contact"). */
  readonly title: string;
  /** What happens, and whether it can be undone. */
  readonly description?: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly onConfirm: () => void;
  /** Draw the confirm button in the danger role (the default); `false` draws it in the accent. */
  readonly destructive?: boolean;
  /** The action is running: the confirm button is disabled and says so to assistive technology. */
  readonly pending?: boolean;
}

/**
 * A confirmation that names its object. It is Radix's AlertDialog: role `alertdialog`, the focus
 * lands on Cancel (never on the destructive action), Tab is trapped, Esc and Cancel close it, and a
 * click outside does not. It does not close itself on confirm: the caller closes it once the action
 * has succeeded, so a failure can be shown in place.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  objectName,
  objectContent,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  destructive = true,
  pending = false,
}: ConfirmDialogProps) {
  const returnFocus = useFocusReturn(open);
  if (objectName.trim() === '') {
    throw new Error('ConfirmDialog needs the name of the object it acts on (objectName is blank)');
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
            <div className="flex flex-col gap-2 px-6 pt-6">
              <AlertDialog.Title className="text-title-3 font-semibold text-fg">
                {title}
              </AlertDialog.Title>
              <AlertDialog.Description asChild>
                <div className="flex flex-col gap-1 text-body text-fg-secondary">
                  <span data-slot="confirm-object" className="font-semibold break-words text-fg">
                    {objectContent ?? objectName}
                  </span>
                  {description === undefined ? null : <span>{description}</span>}
                </div>
              </AlertDialog.Description>
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-line-subtle px-6 py-4">
              <AlertDialog.Cancel asChild>
                <Button variant="secondary">{cancelLabel}</Button>
              </AlertDialog.Cancel>
              <Button
                variant={destructive ? 'destructive' : 'primary'}
                disabled={pending}
                aria-busy={pending ? true : undefined}
                onClick={onConfirm}
              >
                {confirmLabel}
              </Button>
            </div>
          </AlertDialog.Content>
        </div>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
