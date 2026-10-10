import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useFocusReturn } from './dialog';
import { IconButton } from './icon-button';

export interface DetailsPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The heading; also the accessible name of the panel. */
  readonly title: string;
  readonly description?: string;
  /** The accessible name of the close button. */
  readonly closeLabel: string;
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * The details of the row that was chosen. From 1024 px (the `lg` breakpoint) it is a panel docked to
 * the end edge, 28 rem wide; below that it is a full-height sheet over the whole screen. It is modal
 * either way (Radix Dialog): the focus moves in and is trapped, Escape closes it, and the focus goes
 * back to the row that opened it. The scrim carries the same glass utility as a dialog.
 */
export function DetailsPanel({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  footer,
  className,
  children,
}: DetailsPanelProps) {
  const returnFocus = useFocusReturn(open);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="details-panel-overlay"
          className="glass-scrim fixed inset-0 z-scrim data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
        />
        <div
          data-slot="details-panel-layer"
          className="pointer-events-none fixed inset-0 z-dialog flex justify-end"
        >
          <DialogPrimitive.Content
            data-slot="details-panel"
            onCloseAutoFocus={returnFocus}
            className={cn(
              'pointer-events-auto flex h-full w-full flex-col border-line-subtle bg-surface-overlay text-fg shadow-3 lg:max-w-md lg:border-s',
              'data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right',
              className,
            )}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line-subtle px-6 py-4">
              <div className="flex min-w-0 flex-col gap-1">
                <DialogPrimitive.Title className="text-title-3 font-semibold break-words text-fg">
                  {title}
                </DialogPrimitive.Title>
                {description === undefined ? null : (
                  <DialogPrimitive.Description className="text-body text-fg-secondary">
                    {description}
                  </DialogPrimitive.Description>
                )}
              </div>
              <DialogPrimitive.Close asChild>
                <IconButton label={closeLabel} size="sm" className="-me-2">
                  <XIcon aria-hidden="true" className="size-4" />
                </IconButton>
              </DialogPrimitive.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
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
