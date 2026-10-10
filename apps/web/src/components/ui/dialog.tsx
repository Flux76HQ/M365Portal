import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { IconButton } from './icon-button';

// The look shared by Dialog and ConfirmDialog (confirm-dialog.tsx builds on Radix's AlertDialog but
// must not look different). The scrim carries the glass-scrim utility: a dim layer with blur, and
// styles/a11y.css switches the blur off under forced colours, reduced transparency and without
// backdrop-filter. The layer that centres the dialog is a grid, not a translate: an animation that
// scales the dialog would otherwise fight a centring transform and make it jump.
export const DIALOG_SCRIM_CLASS =
  'glass-scrim fixed inset-0 z-scrim data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out';
export const DIALOG_LAYER_CLASS =
  'pointer-events-none fixed inset-0 z-dialog grid place-items-center p-4';
export const DIALOG_SURFACE_CLASS =
  'pointer-events-auto flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-line-subtle bg-surface-overlay text-fg shadow-3 data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out';

/**
 * Radix returns the focus to its own Trigger when a modal closes, and to nothing when the dialog is
 * controlled and opened from somewhere else (a row action, a menu item): `onCloseAutoFocus` prevents
 * the focus scope's own restore and then has no trigger to focus. This hook remembers the element that
 * had the focus when the dialog opened (a layout effect runs before the focus scope moves the focus
 * in) and hands back an `onCloseAutoFocus` that returns it. If that element is gone (it was a menu
 * item that closed with its menu) the default applies.
 */
export function useFocusReturn(open: boolean | undefined) {
  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open === true) {
      returnTo.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  }, [open]);
  return useCallback((event: Event) => {
    const target = returnTo.current;
    if (target?.isConnected === true) {
      event.preventDefault();
      target.focus();
    }
  }, []);
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' } as const;

export interface DialogProps {
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** The heading; it is also the accessible name of the dialog. */
  readonly title: string;
  readonly description?: string;
  /** The accessible name of the close button (a prop: the caller translates it). */
  readonly closeLabel: string;
  /** The element that opens the dialog (rendered as it is, with the dialog's trigger behaviour). */
  readonly trigger?: ReactNode;
  /** Buttons at the bottom edge. */
  readonly footer?: ReactNode;
  readonly size?: keyof typeof SIZES;
  /** A CSS selector, inside the dialog, of the element that takes the focus on open. Default: the first focusable. */
  readonly initialFocus?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  closeLabel,
  trigger,
  footer,
  size = 'md',
  initialFocus,
  className,
  children,
}: DialogProps) {
  const returnFocus = useFocusReturn(open);
  return (
    <DialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger === undefined ? null : (
        <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      )}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-slot="dialog-overlay" className={DIALOG_SCRIM_CLASS} />
        <div data-slot="dialog-layer" className={DIALOG_LAYER_CLASS}>
          <DialogPrimitive.Content
            data-slot="dialog-content"
            className={cn(DIALOG_SURFACE_CLASS, SIZES[size], className)}
            onCloseAutoFocus={trigger === undefined ? returnFocus : undefined}
            onOpenAutoFocus={(event) => {
              if (initialFocus === undefined) return;
              const target =
                event.currentTarget instanceof HTMLElement
                  ? event.currentTarget.querySelector<HTMLElement>(initialFocus)
                  : null;
              if (target !== null) {
                event.preventDefault();
                target.focus();
              }
            }}
          >
            <div className="flex items-start justify-between gap-4 px-6 pt-6">
              <div className="flex min-w-0 flex-col gap-1">
                <DialogPrimitive.Title className="text-title-3 font-semibold text-fg">
                  {title}
                </DialogPrimitive.Title>
                {description === undefined ? null : (
                  <DialogPrimitive.Description className="text-body text-fg-secondary">
                    {description}
                  </DialogPrimitive.Description>
                )}
              </div>
              <DialogPrimitive.Close asChild>
                <IconButton label={closeLabel} size="sm" className="-me-2 -mt-1">
                  <XIcon aria-hidden="true" className="size-4" />
                </IconButton>
              </DialogPrimitive.Close>
            </div>
            {children === undefined ? null : (
              <div className="min-h-0 overflow-y-auto px-6 py-4">{children}</div>
            )}
            {footer === undefined ? null : (
              <div className="flex flex-wrap justify-end gap-2 border-t border-line-subtle px-6 py-4">
                {footer}
              </div>
            )}
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
