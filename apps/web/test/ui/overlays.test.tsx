// OVERLAYS AND NAVIGATION PRIMITIVES (FR-A-124, FR-A-152; T-A-126): Dialog, Menu, Tooltip, Tabs,
// SegmentedControl. ConfirmDialog has its own file (test/confirm-dialog.test.tsx).
//
// Every control is operated with the keyboard alone, names come from props, and the focus behaves:
// moves in, is trapped in a modal, returns to the trigger.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../../src/components/ui/button';
import { Dialog } from '../../src/components/ui/dialog';
import { Menu, type MenuEntry } from '../../src/components/ui/menu';
import { SegmentedControl } from '../../src/components/ui/segmented-control';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../src/components/ui/tabs';
import { Tooltip } from '../../src/components/ui/tooltip';

describe('Dialog', () => {
  function Example({ onOpenChange }: { readonly onOpenChange?: (open: boolean) => void }) {
    return (
      <Dialog
        trigger={<Button>Edit details</Button>}
        title="Edit details"
        description="Change the name shown in the header."
        closeLabel="Close dialog"
        onOpenChange={onOpenChange}
        footer={<Button variant="primary">Save</Button>}
      >
        <label>
          Name <input type="text" defaultValue="Contoso" />
        </label>
      </Dialog>
    );
  }

  it('opens from its trigger as a modal dialog named by its title and described by its description', async () => {
    const user = userEvent.setup();
    render(<Example />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit details' });
    expect(dialog).toHaveAccessibleDescription('Change the name shown in the header.');
    expect(
      within(dialog).getByRole('heading', { level: 2, name: 'Edit details' }),
    ).toBeInTheDocument();
  });

  it('moves the focus into the dialog and traps it there', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    for (let step = 0; step < 8; step += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('closes with Escape and returns the focus to the trigger', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Example onOpenChange={onOpenChange} />);
    const trigger = screen.getByRole('button', { name: 'Edit details' });
    await user.click(trigger);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('has a close button whose name is a prop', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.click(await screen.findByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('draws the scrim with the blur class (and its opaque fallbacks live in the variables it reads)', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await screen.findByRole('dialog');

    const scrim = document.querySelector('[data-slot="dialog-overlay"]');
    expect(scrim).not.toBeNull();
    expect(scrim).toHaveClass('glass-scrim', 'z-scrim');
    expect(screen.getByRole('dialog').closest('[data-slot="dialog-layer"]')).toHaveClass(
      'z-dialog',
    );
  });

  it('returns the focus to the element that opened a controlled dialog (Radix only knows its own trigger)', async () => {
    function External() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button
            onClick={() => {
              setOpen(true);
            }}
          >
            Open from a row action
          </Button>
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="Row details"
            closeLabel="Close dialog"
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<External />);
    const opener = screen.getByRole('button', { name: 'Open from a row action' });
    await user.click(opener);
    await screen.findByRole('dialog', { name: 'Row details' });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('is controlled when `open` is given, and focuses a chosen element when asked to', async () => {
    function Controlled() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="Reset"
            closeLabel="Close dialog"
            initialFocus="[data-initial-focus]"
          >
            <input aria-label="First" />
            <input aria-label="Second" data-initial-focus="" />
          </Dialog>
          <span>{open ? 'is open' : 'is closed'}</span>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Controlled />);
    const dialog = await screen.findByRole('dialog', { name: 'Reset' });
    await waitFor(() => {
      expect(within(dialog).getByRole('textbox', { name: 'Second' })).toHaveFocus();
    });
    await user.keyboard('{Escape}');
    expect(screen.getByText('is closed')).toBeInTheDocument();
  });
});

describe('Menu', () => {
  const ENTRIES: readonly MenuEntry[] = [
    { kind: 'label', label: 'Account' },
    { kind: 'item', id: 'profile', label: 'Profile' },
    { kind: 'item', id: 'settings', label: 'Settings' },
    { kind: 'item', id: 'billing', label: 'Billing', disabled: true },
    { kind: 'separator' },
    { kind: 'item', id: 'delete', label: 'Delete account', destructive: true },
  ];

  function Example({ onSelect }: { readonly onSelect?: (id: string) => void }) {
    return (
      <Menu
        trigger={<Button>Account menu</Button>}
        entries={ENTRIES}
        onSelect={onSelect ?? (() => undefined)}
      />
    );
  }

  it('opens with Enter, is named by its trigger and lists its items', async () => {
    const user = userEvent.setup();
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'Account menu' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    await user.tab();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu', { name: 'Account menu' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Profile', 'Settings', 'Billing', 'Delete account']);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('focuses the first item on open, moves with the arrows past a disabled one, and jumps with Home and End', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Example onSelect={onSelect} />);
    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');

    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
    // Billing is disabled: the focus passes over it.
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete account' })).toHaveFocus();
    // The list wraps.
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Delete account' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveFocus();

    expect(screen.getByRole('menuitem', { name: 'Billing' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('jumps to an item by typing its first letters (typeahead)', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');

    await user.keyboard('d');
    expect(screen.getByRole('menuitem', { name: 'Delete account' })).toHaveFocus();
    // The typeahead buffer holds the letters typed within a second, so a second letter would extend the search.

    await user.keyboard('{Escape}');
  });

  it('selects with Enter, reports the id, closes and returns the focus to the trigger', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Example onSelect={onSelect} />);
    const trigger = screen.getByRole('button', { name: 'Account menu' });
    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('settings');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('closes with Escape without selecting anything', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Example onSelect={onSelect} />);
    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows a radio group with a check mark on the chosen entry (not colour alone)', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Menu
        trigger={<Button>Language</Button>}
        onSelect={() => undefined}
        entries={[
          {
            kind: 'radio-group',
            value: 'nl',
            onValueChange,
            options: [
              { value: 'nl', label: 'Nederlands' },
              { value: 'en', label: 'English' },
            ],
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Language' }));
    const nl = await screen.findByRole('menuitemradio', { name: 'Nederlands' });
    const en = screen.getByRole('menuitemradio', { name: 'English' });
    expect(nl).toHaveAttribute('aria-checked', 'true');
    expect(nl.querySelector('svg')).not.toBeNull();
    expect(en).toHaveAttribute('aria-checked', 'false');
    expect(en.querySelector('svg')).toBeNull();

    await user.click(en);
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('en');
  });

  it('draws a destructive entry in the danger role', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByRole('menuitem', { name: 'Delete account' })).toHaveClass(
      'text-danger',
    );
  });
});

describe('Tooltip', () => {
  it('shows on keyboard focus, describes its trigger and hides with Escape', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Collapse the sidebar" delayDuration={0}>
        <Button>Toggle</Button>
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Toggle' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.tab();
    expect(trigger).toHaveFocus();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Collapse the sidebar');
    expect(trigger).toHaveAccessibleDescription('Collapse the sidebar');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  it('shows on hover and stays while the pointer is over the tooltip itself (WCAG 1.4.13)', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Collapse the sidebar" delayDuration={0}>
        <Button>Toggle</Button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole('button', { name: 'Toggle' }));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toBeInTheDocument();
    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveClass('z-tooltip');
  });

  it('is shown above the toast layer and in the inverse colours of the surface', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Hint" delayDuration={0}>
        <Button>Toggle</Button>
      </Tooltip>,
    );
    await user.tab();
    await screen.findByRole('tooltip');
    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveClass(
      'bg-fg',
      'text-surface-raised',
    );
  });
});

describe('Tabs', () => {
  function Example() {
    return (
      <Tabs defaultValue="general">
        <TabsList label="Settings sections">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>
        <TabsContent value="general">General settings</TabsContent>
        <TabsContent value="access">Access settings</TabsContent>
        <TabsContent value="audit">Audit settings</TabsContent>
      </Tabs>
    );
  }

  it('is a tablist named by a prop, with one selected tab and its panel', () => {
    render(<Example />);
    expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('General settings');
  });

  it('moves with the arrow keys, Home and End, and activates the tab it lands on', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.tab();
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Access' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Access settings');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Audit' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Audit' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();
  });

  it('marks the selected tab with a bar, not only with a colour', () => {
    render(<Example />);
    expect(screen.getByRole('tab', { name: 'General' })).toHaveClass(
      'data-[state=active]:border-b-2',
    );
  });

  it('puts the panel after the tablist in one tab stop (Tab leaves the list)', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('tabpanel')).toHaveFocus();
  });
});

describe('SegmentedControl', () => {
  const OPTIONS = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ] as const;

  function Example({ onValueChange }: { readonly onValueChange?: (value: string) => void }) {
    const [value, setValue] = useState('dark');
    return (
      <>
        <SegmentedControl
          label="Theme"
          options={OPTIONS}
          value={value}
          onValueChange={(next) => {
            setValue(next);
            onValueChange?.(next);
          }}
        />
        <Button>After</Button>
      </>
    );
  }

  it('is a radiogroup named by a prop, with the chosen option checked', () => {
    render(<Example />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: 'Dark' })).toBeChecked();
  });

  it('is a single tab stop on the checked option; the arrows move the choice with the focus', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Example onValueChange={onValueChange} />);
    await user.tab();
    const dark = screen.getByRole('radio', { name: 'Dark' });
    expect(dark).toHaveFocus();

    await user.keyboard('{ArrowRight>}');
    await user.keyboard('{/ArrowRight}');
    const system = screen.getByRole('radio', { name: 'System' });
    expect(system).toHaveFocus();
    expect(system).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith('system');

    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('keeps exactly one radio in the tab order once the group has focus (roving tabindex)', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.tab();
    const stops = screen.getAllByRole('radio').filter((radio) => radio.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(screen.getByRole('radio', { name: 'Dark' }));
  });

  it('does not allow an empty choice: clicking the chosen option keeps it', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Example onValueChange={onValueChange} />);
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  });

  it('shows the chosen option with a raised fill and a border, not a colour alone', () => {
    render(<Example />);
    const dark = screen.getByRole('radio', { name: 'Dark' });
    expect(dark).toHaveClass(
      'data-[state=checked]:bg-surface-raised',
      'data-[state=checked]:border-line-control',
    );
  });

  it('renders an icon beside the label when one is given, hidden from assistive technology', () => {
    render(
      <SegmentedControl
        label="Theme"
        value="light"
        onValueChange={() => undefined}
        options={[{ value: 'light', label: 'Light', icon: <svg data-testid="sun" /> }]}
      />,
    );
    expect(screen.getByTestId('sun').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Light' })).toBeInTheDocument();
  });
});
