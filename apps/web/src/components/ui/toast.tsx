import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { Toast } from 'radix-ui';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from './button';
import { IconButton } from './icon-button';

// Toasts on Radix Toast (PD-03). What Radix gives, and what this file leans on:
//   - an announcer per toast: a visually hidden live region, `polite` for the `background` type and
//     `assertive` for the `foreground` type (an error), so the announcement matches the urgency;
//   - the auto-dismiss timer pauses while the pointer is over the viewport or the focus is inside it;
//   - `duration: Infinity` never dismisses by itself.
// An error is a foreground toast with no timer: it stays until someone dismisses it (FR-A-134).

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  /** The visible text of the action button ("Undo"). */
  readonly label: string;
  /** What the action does, for people who cannot see the toast's context (read out by Radix). */
  readonly altText: string;
  readonly onAction: () => void;
}

export interface ToastOptions {
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
  readonly action?: ToastAction;
  /** Milliseconds before an info, success or warning toast goes away by itself. Ignored for errors. */
  readonly duration?: number;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  readonly toast: (options: ToastOptions) => string;
  /** Dismisses one toast, or all of them without an id. */
  readonly dismiss: (id?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** The way to show a toast. Throws outside a ToastProvider: a toast that cannot show must not fail silently. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast must be used inside a ToastProvider');
  return api;
}

const DEFAULT_DURATION_MS = 5_000;
const MAX_VISIBLE = 5;

const TONES = {
  info: { Icon: InfoIcon, iconClass: 'text-info' },
  success: { Icon: CircleCheckIcon, iconClass: 'text-success' },
  warning: { Icon: TriangleAlertIcon, iconClass: 'text-warning' },
  error: { Icon: CircleAlertIcon, iconClass: 'text-danger' },
} as const;

interface ToastEntry extends ToastOptions {
  readonly id: string;
}

export interface ToastProviderProps {
  /** The accessible name of the notification region. `{hotkey}` is replaced by the key that jumps to it (F8). */
  readonly regionLabel: string;
  /** The accessible name of the close button of a toast. */
  readonly closeLabel: string;
  /** What a screen reader says before each toast text ("Notification"); the region label when absent. */
  readonly notificationLabel?: string;
  readonly children: ReactNode;
}

export function ToastProvider({
  regionLabel,
  closeLabel,
  notificationLabel,
  children,
}: ToastProviderProps) {
  const [entries, setEntries] = useState<readonly ToastEntry[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id?: string) => {
    setEntries((current) => (id === undefined ? [] : current.filter((entry) => entry.id !== id)));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    counter.current += 1;
    const id = `toast-${String(counter.current)}`;
    setEntries((current) => [{ ...options, id }, ...current].slice(0, MAX_VISIBLE));
    return id;
  }, []);

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      <Toast.Provider
        label={notificationLabel ?? regionLabel}
        swipeDirection="right"
        duration={DEFAULT_DURATION_MS}
      >
        {children}
        {entries.map((entry) => {
          const tone = entry.tone ?? 'info';
          const { Icon, iconClass } = TONES[tone];
          const isError = tone === 'error';
          return (
            <Toast.Root
              key={entry.id}
              data-slot="toast"
              data-tone={tone}
              type={isError ? 'foreground' : 'background'}
              duration={isError ? Infinity : (entry.duration ?? DEFAULT_DURATION_MS)}
              onOpenChange={(open) => {
                if (!open) dismiss(entry.id);
              }}
              className="flex w-full items-start gap-3 rounded-lg border border-line-subtle bg-surface-overlay p-3 pe-2 text-fg shadow-3 data-[state=open]:animate-toast-in"
            >
              <Icon aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${iconClass}`} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Toast.Title data-slot="toast-title" className="text-body font-medium text-fg">
                  {entry.title}
                </Toast.Title>
                {entry.description === undefined ? null : (
                  <Toast.Description className="text-body-sm text-fg-secondary">
                    {entry.description}
                  </Toast.Description>
                )}
                {entry.action === undefined ? null : (
                  <div className="mt-1">
                    <Toast.Action altText={entry.action.altText} asChild>
                      <Button size="sm" variant="secondary" onClick={entry.action.onAction}>
                        {entry.action.label}
                      </Button>
                    </Toast.Action>
                  </div>
                )}
              </div>
              <Toast.Close asChild>
                <IconButton label={closeLabel} size="sm">
                  <XIcon aria-hidden="true" className="size-4" />
                </IconButton>
              </Toast.Close>
            </Toast.Root>
          );
        })}
        <Toast.Viewport
          label={regionLabel}
          className="fixed end-4 bottom-4 z-toast m-0 flex w-[calc(100%-2rem)] max-w-sm list-none flex-col gap-2 p-0"
        />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}
