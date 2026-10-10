// CONFIRMDIALOG (FR-A-124, T-A-126): a confirmation always names the object it acts on.
//
// Type level: `objectName` is required, so a ConfirmDialog without it does not compile (the
// `@ts-expect-error` below fails the typecheck the day the prop becomes optional), and the module
// exports no generic "Are you sure?" variant. Runtime: the dialog text includes the object name, the
// focus moves in, is trapped, Esc closes and the focus goes back to the trigger, and the destructive
// action is never the default focus.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as confirmDialogModule from '../src/components/ui/confirm-dialog';
import { ConfirmDialog, type ConfirmDialogProps } from '../src/components/ui/confirm-dialog';

const LABELS = {
  title: 'Delete contact',
  description: 'This removes the contact from every list. It cannot be undone.',
  confirmLabel: 'Delete',
  cancelLabel: 'Cancel',
} as const;

function Harness({
  onConfirm,
  objectName = 'Alice Example',
  ...rest
}: {
  readonly onConfirm?: () => void;
  readonly objectName?: string;
} & Partial<ConfirmDialogProps>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open confirmation
      </button>
      <ConfirmDialog
        {...LABELS}
        open={open}
        onOpenChange={setOpen}
        objectName={objectName}
        onConfirm={onConfirm ?? (() => undefined)}
        {...rest}
      />
    </>
  );
}

describe('ConfirmDialog: the type contract', () => {
  const base = {
    ...LABELS,
    open: true,
    onOpenChange: () => undefined,
    onConfirm: () => undefined,
  };

  it('does not compile without the name of the object', () => {
    // @ts-expect-error objectName is required: there is no generic confirmation
    const missing: ConfirmDialogProps = base;
    expect(missing.open).toBe(true);
  });

  it('does not compile in JSX without the name of the object either', () => {
    // @ts-expect-error objectName is required
    const element = <ConfirmDialog {...base} />;
    expect(element.type).toBe(ConfirmDialog);
  });

  it('does not accept an undefined object name', () => {
    // @ts-expect-error objectName must be a string, not undefined
    const undefinedName: ConfirmDialogProps = { ...base, objectName: undefined };
    expect(undefinedName.open).toBe(true);
  });

  it('compiles with the name', () => {
    const named: ConfirmDialogProps = { ...base, objectName: 'Alice Example' };
    expect(named.objectName).toBe('Alice Example');
  });

  it('exports the dialog and nothing that stands in for a generic confirmation', () => {
    expect(Object.keys(confirmDialogModule)).toEqual(['ConfirmDialog']);
  });
});

describe('ConfirmDialog: the runtime contract', () => {
  it('names the object in the dialog text and in its accessible description', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete contact' });
    expect(within(dialog).getByText('Alice Example')).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription(/Alice Example/);
    expect(dialog).toHaveAccessibleDescription(/cannot be undone/);
  });

  it('refuses an empty or blank object name at run time as well, even while closed', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Harness objectName="  " />)).toThrow(/object/i);
      expect(() =>
        render(
          <ConfirmDialog
            {...LABELS}
            open
            onOpenChange={() => undefined}
            onConfirm={() => undefined}
            objectName=""
          />,
        ),
      ).toThrow(/object/i);
    } finally {
      errors.mockRestore();
    }
  });

  it('moves the focus in on open, onto Cancel and not onto the destructive action', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Delete' })).not.toHaveFocus();
  });

  it('traps the focus: Tab and Shift+Tab cycle inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));
    const dialog = await screen.findByRole('alertdialog');
    const inside = within(dialog).getAllByRole('button');
    expect(inside).toHaveLength(2);

    for (let step = 0; step < inside.length * 2 + 1; step += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let step = 0; step < inside.length + 1; step += 1) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    expect(
      screen.getByRole('button', { name: 'Open confirmation', hidden: true }),
    ).not.toHaveFocus();
  });

  it('closes with Escape and gives the focus back to the trigger', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Open confirmation' });
    await user.click(trigger);
    await screen.findByRole('alertdialog');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // Radix hands the focus back one macrotask after the dialog unmounts.
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms only through the confirm button, and cancels through Cancel', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('does not close itself on confirm: the caller closes it when the action has succeeded', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('does not close on a click outside (an accidental click must not decide)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));
    await screen.findByRole('alertdialog');
    const scrim = document.querySelector('[data-slot="dialog-overlay"]');
    expect(scrim).not.toBeNull();
    await user.click(scrim!);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('keeps the dialog open while the action is pending and does not confirm twice', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} pending />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));
    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    });

    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('draws the destructive action with the danger role and a neutral confirmation with the accent', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));
    expect(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    ).toHaveClass('text-danger');
    unmount();

    render(<Harness destructive={false} />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));
    expect(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    ).toHaveClass('bg-accent');
  });
});
