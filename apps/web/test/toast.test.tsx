// TOAST (FR-A-134, T-A-127): built on Radix Toast (PD-03), not on sonner.
//
//   - a polite live region by default and an assertive one for errors;
//   - no auto-dismiss while the pointer is over a toast or the focus is in it;
//   - an error toast persists until it is dismissed;
//   - an action slot for Undo;
//   - every string (title, description, action, close button, region name) is a prop.
//
// The clock is injected (Vitest fake timers, also for user-event), never slept on (plan 13.2).
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../src/components/ui/button';
import { ToastProvider, useToast, type ToastOptions } from '../src/components/ui/toast';

const AUTO_DISMISS_MS = 5_000;
/** Radix renders the text of the announcement one animation frame after the toast appears. */
const ANNOUNCER_FRAME_MS = 50;

function Trigger({ options }: { readonly options: ToastOptions }) {
  const { toast } = useToast();
  return (
    <Button
      onClick={() => {
        toast(options);
      }}
    >
      Show
    </Button>
  );
}

function setup(options: ToastOptions) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(
    <ToastProvider regionLabel="Notifications" closeLabel="Dismiss notification">
      <Trigger options={options} />
    </ToastProvider>,
  );
  return user;
}

function advance(milliseconds: number): void {
  act(() => {
    vi.advanceTimersByTime(milliseconds);
  });
}

const toastOf = (title: string) => screen.queryByRole('listitem', { name: title });
const liveRegion = (politeness: 'polite' | 'assertive') =>
  document.querySelector(`[aria-live="${politeness}"]`);

beforeEach(() => {
  vi.useFakeTimers();
  // Testing Library only advances fake timers after an async user-event call when a `jest` global
  // with fake timers exists (its `jestFakeTimersAreEnabled`); without it every `await user.click()`
  // waits for a timer that nobody fires. Vitest's clock has the same shape, so say so.
  vi.stubGlobal('jest', {
    advanceTimersByTime: (milliseconds: number) => vi.advanceTimersByTime(milliseconds),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Toast: the live region', () => {
  it('announces an ordinary toast politely', async () => {
    const user = setup({ title: 'Branding saved', tone: 'success' });
    await user.click(screen.getByRole('button', { name: 'Show' }));
    advance(ANNOUNCER_FRAME_MS);

    expect(liveRegion('polite')).toHaveTextContent('Branding saved');
    expect(liveRegion('assertive')).toBeNull();
  });

  it('announces an error assertively', async () => {
    const user = setup({ title: 'Could not save', tone: 'error' });
    await user.click(screen.getByRole('button', { name: 'Show' }));
    advance(ANNOUNCER_FRAME_MS);

    expect(liveRegion('assertive')).toHaveTextContent('Could not save');
    expect(liveRegion('polite')).toBeNull();
  });

  it('puts the toasts in a named region', async () => {
    const user = setup({ title: 'Saved' });
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByRole('region', { name: /Notifications/ })).toBeInTheDocument();
  });
});

describe('Toast: when it goes away', () => {
  it('dismisses an ordinary toast by itself after the delay (positive control)', async () => {
    const user = setup({ title: 'Branding saved', tone: 'success' });
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(
      screen.getByText('Branding saved', { selector: '[data-slot="toast-title"]' }),
    ).toBeInTheDocument();

    advance(AUTO_DISMISS_MS + 100);
    expect(
      screen.queryByText('Branding saved', { selector: '[data-slot="toast-title"]' }),
    ).not.toBeInTheDocument();
  });

  it('does not dismiss while the pointer is over the toast, and does once it leaves', async () => {
    const user = setup({ title: 'Branding saved', tone: 'success' });
    await user.click(screen.getByRole('button', { name: 'Show' }));
    const title = () =>
      screen.queryByText('Branding saved', { selector: '[data-slot="toast-title"]' });

    await user.hover(title()!);
    advance(AUTO_DISMISS_MS * 4);
    expect(title()).toBeInTheDocument();

    await user.unhover(title()!);
    advance(AUTO_DISMISS_MS + 100);
    expect(title()).not.toBeInTheDocument();
  });

  it('does not dismiss while the focus is inside the toast, and does once it leaves', async () => {
    const onAction = vi.fn();
    const user = setup({
      title: 'Branding reset',
      tone: 'info',
      action: { label: 'Undo', altText: 'Undo the reset', onAction },
    });
    await user.click(screen.getByRole('button', { name: 'Show' }));
    const title = () =>
      screen.queryByText('Branding reset', { selector: '[data-slot="toast-title"]' });

    act(() => {
      screen.getByRole('button', { name: 'Undo' }).focus();
    });
    advance(AUTO_DISMISS_MS * 4);
    expect(title()).toBeInTheDocument();

    act(() => {
      screen.getByRole('button', { name: 'Show' }).focus();
    });
    advance(AUTO_DISMISS_MS + 100);
    expect(title()).not.toBeInTheDocument();
  });

  it('keeps an error until it is dismissed, however long it takes', async () => {
    const user = setup({
      title: 'Could not save',
      description: 'The server did not answer.',
      tone: 'error',
    });
    await user.click(screen.getByRole('button', { name: 'Show' }));
    const title = () =>
      screen.queryByText('Could not save', { selector: '[data-slot="toast-title"]' });

    advance(10 * 60 * 1000);
    expect(title()).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(title()).not.toBeInTheDocument();
  });

  it('can be dismissed by hand at any time, with the keyboard', async () => {
    const user = setup({ title: 'Branding saved', tone: 'success' });
    await user.click(screen.getByRole('button', { name: 'Show' }));
    const close = screen.getByRole('button', { name: 'Dismiss notification' });

    act(() => {
      close.focus();
    });
    await user.keyboard('{Enter}');
    expect(
      screen.queryByText('Branding saved', { selector: '[data-slot="toast-title"]' }),
    ).not.toBeInTheDocument();
  });
});

describe('Toast: the content', () => {
  it.each(['info', 'success', 'warning', 'error'] as const)(
    'shows an icon beside the text of a %s toast, so the tone is not a colour alone',
    async (tone) => {
      const user = setup({ title: `Tone ${tone}`, tone });
      await user.click(screen.getByRole('button', { name: 'Show' }));
      const item = screen
        .getByText(`Tone ${tone}`, { selector: '[data-slot="toast-title"]' })
        .closest('[data-slot="toast"]');
      expect(item?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(item).toHaveAttribute('data-tone', tone);
    },
  );

  it('has an action slot (Undo): the button runs the action and dismisses the toast', async () => {
    const onAction = vi.fn();
    const user = setup({
      title: 'Appearance reset',
      description: 'The previous values can be restored.',
      tone: 'info',
      action: { label: 'Undo', altText: 'Undo the reset of the appearance', onAction },
    });
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText('The previous values can be restored.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(
      screen.queryByText('Appearance reset', { selector: '[data-slot="toast-title"]' }),
    ).not.toBeInTheDocument();
  });

  it('stacks several toasts, newest first, and keeps at most five', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    function Many() {
      const { toast } = useToast();
      return (
        <Button
          onClick={() => {
            for (let index = 1; index <= 7; index += 1)
              toast({ title: `Message ${String(index)}`, tone: 'error' });
          }}
        >
          Show
        </Button>
      );
    }
    render(
      <ToastProvider regionLabel="Notifications" closeLabel="Dismiss notification">
        <Many />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Show' }));

    const region = screen.getByRole('region', { name: /Notifications/ });
    const titles = within(region)
      .getAllByRole('listitem')
      .map((item) => item.querySelector('[data-slot="toast-title"]')?.textContent);
    expect(titles).toEqual(['Message 7', 'Message 6', 'Message 5', 'Message 4', 'Message 3']);
  });

  it('refuses useToast outside a ToastProvider, loudly', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Trigger options={{ title: 'x' }} />)).toThrow(/ToastProvider/);
    } finally {
      errors.mockRestore();
    }
    expect(toastOf('x')).toBeNull();
  });
});
