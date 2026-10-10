// LAYOUT PRIMITIVES (FR-A-124, T-A-128): Breadcrumbs, CommandBar, DetailsPanel.
//
// Names come from props (contract C12), none of the three imports a router, and each is operated
// with the keyboard alone.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Breadcrumbs, type BreadcrumbItem } from '../../src/components/ui/breadcrumbs';
import { Button } from '../../src/components/ui/button';
import { CommandBar, type CommandBarGroup } from '../../src/components/ui/command-bar';
import { DetailsPanel } from '../../src/components/ui/details-panel';

describe('Breadcrumbs', () => {
  const ITEMS: readonly BreadcrumbItem[] = [
    { id: 'home', label: 'Dashboard', href: '/' },
    { id: 'settings', label: 'Settings', href: '/settings' },
    { id: 'appearance', label: 'Appearance' },
  ];

  it('is a navigation landmark named by a prop, with an ordered list of the path', () => {
    render(<Breadcrumbs label="You are here" items={ITEMS} />);
    const nav = screen.getByRole('navigation', { name: 'You are here' });
    const list = within(nav).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(list.tagName).toBe('OL');
  });

  it('links every ancestor and marks the last item as the current page, without a link', () => {
    render(<Breadcrumbs label="You are here" items={ITEMS} />);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    const current = screen.getByText('Appearance');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.closest('a')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('truncates a long name with an ellipsis and keeps the full name as the accessible name', () => {
    const longName =
      'Distribution list of the whole organisation including all subsidiaries and partners';
    render(
      <Breadcrumbs
        label="You are here"
        items={[
          { id: 'a', label: longName, href: '/lists' },
          { id: 'b', label: longName.toUpperCase() },
        ]}
      />,
    );
    const link = screen.getByRole('link', { name: longName });
    expect(link).toHaveClass('truncate');
    expect(link).toHaveAttribute('title', longName);
    expect(screen.getByText(longName.toUpperCase())).toHaveClass('truncate');
  });

  it('hides the separators from assistive technology', () => {
    render(<Breadcrumbs label="You are here" items={ITEMS} />);
    const nav = screen.getByRole('navigation');
    const separators = nav.querySelectorAll('svg');
    expect(separators).toHaveLength(2);
    for (const separator of separators) expect(separator).toHaveAttribute('aria-hidden', 'true');
  });

  it('lets the application render the links (a router link) without the component importing a router', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(
      <Breadcrumbs
        label="You are here"
        items={ITEMS}
        renderLink={({ href, className, children }) => (
          <button
            type="button"
            className={className}
            data-href={href}
            onClick={() => {
              navigate(href);
            }}
          >
            {children}
          </button>
        )}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/settings');
  });

  it('renders a single item as the current page', () => {
    render(<Breadcrumbs label="You are here" items={[{ id: 'home', label: 'Dashboard' }]} />);
    expect(screen.getByText('Dashboard')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('CommandBar', () => {
  function groups(handlers: Record<string, () => void> = {}): readonly CommandBarGroup[] {
    const on = (id: string) => handlers[id] ?? (() => undefined);
    return [
      {
        id: 'edit',
        label: 'Edit',
        items: [
          { id: 'add', label: 'Add member', onSelect: on('add') },
          { id: 'remove', label: 'Remove', onSelect: on('remove'), destructive: true },
        ],
      },
      {
        id: 'data',
        label: 'Data',
        items: [
          { id: 'export', label: 'Export', onSelect: on('export') },
          { id: 'refresh', label: 'Refresh', onSelect: on('refresh'), disabled: true },
          { id: 'columns', label: 'Columns', onSelect: on('columns') },
        ],
      },
    ];
  }

  it('is a toolbar named by a prop, with one named group per section', () => {
    render(<CommandBar label="Member actions" moreLabel="More actions" groups={groups()} />);
    expect(screen.getByRole('toolbar', { name: 'Member actions' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Data' })).toBeInTheDocument();
    expect(screen.getAllByRole('separator')).toHaveLength(1);
  });

  it('is one tab stop; the arrow keys, Home and End move between the actions and skip a disabled one', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Button>Before</Button>
        <CommandBar label="Member actions" moreLabel="More actions" groups={groups()} />
        <Button>After</Button>
      </>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Add member' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Export' })).toHaveFocus();
    // Refresh is disabled: the focus passes over it.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Columns' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: 'Add member' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Columns' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('runs an action with Enter and with Space, and does not run a disabled one', async () => {
    const user = userEvent.setup();
    const add = vi.fn();
    const refresh = vi.fn();
    render(
      <CommandBar
        label="Member actions"
        moreLabel="More actions"
        groups={groups({ add, refresh })}
      />,
    );
    await user.tab();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(add).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  });

  it('draws a destructive action in the danger role', () => {
    render(<CommandBar label="Member actions" moreLabel="More actions" groups={groups()} />);
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveClass('text-danger');
  });

  it('moves what does not fit into an overflow menu, whose button is named by a prop and is part of the toolbar', async () => {
    const user = userEvent.setup();
    const columns = vi.fn();
    render(
      <CommandBar
        label="Member actions"
        moreLabel="More actions"
        maxVisible={3}
        groups={groups({ columns })}
      />,
    );

    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.textContent || button.getAttribute('aria-label')),
    ).toEqual(['Add member', 'Remove', 'Export', 'More actions']);
    expect(screen.queryByRole('button', { name: 'Columns' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Refresh', 'Columns']);
    expect(items[0]).toHaveAttribute('aria-disabled', 'true');

    await user.click(within(menu).getByRole('menuitem', { name: 'Columns' }));
    expect(columns).toHaveBeenCalledOnce();
  });

  it('shows no overflow button when everything fits', () => {
    render(
      <CommandBar
        label="Member actions"
        moreLabel="More actions"
        maxVisible={10}
        groups={groups()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('reaches the overflow button with the arrow keys like any other action', async () => {
    const user = userEvent.setup();
    render(
      <CommandBar
        label="Member actions"
        moreLabel="More actions"
        maxVisible={1}
        groups={groups()}
      />,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Add member' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveFocus();
  });
});

describe('DetailsPanel', () => {
  function Example({ onOpenChange }: { readonly onOpenChange?: (open: boolean) => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button
          onClick={() => {
            setOpen(true);
          }}
        >
          Open details
        </Button>
        <DetailsPanel
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            onOpenChange?.(next);
          }}
          title="Alice Example"
          description="Member of 3 groups"
          closeLabel="Close details"
        >
          <p>Details body</p>
          <button type="button">Edit</button>
        </DetailsPanel>
      </>
    );
  }

  it('opens as a dialog named by its title, described by its description, with the body inside', async () => {
    const user = userEvent.setup();
    render(<Example />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open details' }));

    const panel = await screen.findByRole('dialog', { name: 'Alice Example' });
    expect(panel).toHaveAccessibleDescription('Member of 3 groups');
    expect(within(panel).getByText('Details body')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Close details' })).toBeInTheDocument();
  });

  it('is a right panel from 1024 px and a full-height sheet below', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Open details' }));
    const panel = await screen.findByRole('dialog');

    // Below lg: the whole screen. From lg: docked to the end edge with a fixed width.
    expect(panel).toHaveClass('h-full', 'w-full');
    expect(panel).toHaveClass('lg:max-w-md');
    expect(panel.closest('[data-slot="details-panel-layer"]')).toHaveClass(
      'justify-end',
      'z-dialog',
    );
    expect(document.querySelector('[data-slot="details-panel-overlay"]')).toHaveClass(
      'glass-scrim',
    );
  });

  it('moves the focus in, traps it, closes with Escape and restores the focus to the row that opened it', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Example onOpenChange={onOpenChange} />);
    const opener = screen.getByRole('button', { name: 'Open details' });
    await user.click(opener);
    const panel = await screen.findByRole('dialog');
    expect(panel).toContainElement(document.activeElement as HTMLElement);

    for (let step = 0; step < 5; step += 1) {
      await user.tab();
      expect(panel).toContainElement(document.activeElement as HTMLElement);
    }

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('closes with its close button', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Open details' }));
    await user.click(await screen.findByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
