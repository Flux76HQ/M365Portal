// FEEDBACK AND IDENTITY PRIMITIVES (FR-A-124, FR-A-103; T-A-127): Banner, Skeleton, EmptyState,
// ErrorState, Persona. Toast has its own file (test/toast.test.tsx).
//
// Every visible string is a prop (contract C12); the state is never colour alone (WCAG 1.4.1): a
// banner and an error carry an icon and text.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Banner } from '../../src/components/ui/banner';
import { Button } from '../../src/components/ui/button';
import { EmptyState } from '../../src/components/ui/empty-state';
import { ErrorState } from '../../src/components/ui/error-state';
import { Persona } from '../../src/components/ui/persona';
import { Skeleton } from '../../src/components/ui/skeleton';

describe('Banner', () => {
  it('is a status region with no close button (it cannot be dismissed)', () => {
    render(<Banner tone="warning">Preview mode: everyone is an administrator.</Banner>);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Preview mode: everyone is an administrator.');
    expect(within(banner).queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows an icon beside the text for every tone (not colour alone), hidden from assistive technology', () => {
    for (const tone of ['info', 'success', 'warning', 'danger'] as const) {
      const { unmount } = render(<Banner tone={tone}>{`Message for ${tone}`}</Banner>);
      const banner = screen.getByRole('status');
      expect(banner.querySelector('svg[aria-hidden="true"]'), tone).not.toBeNull();
      expect(banner).toHaveAttribute('data-tone', tone);
      unmount();
    }
  });

  it('can carry a title and an action next to the message', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Banner
        tone="info"
        title="Update available"
        action={<Button onClick={onClick}>Reload</Button>}
      >
        A new version was installed.
      </Banner>,
    );
    const banner = screen.getByRole('status');
    expect(within(banner).getByText('Update available')).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: 'Reload' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('draws its text in the primary colour on a raised surface, and names the tone with the tone colour on the icon', () => {
    render(<Banner tone="danger">Storage is unavailable.</Banner>);
    const banner = screen.getByRole('status');
    expect(banner).toHaveClass('bg-surface-raised', 'text-fg');
    expect(banner.querySelector('svg')).toHaveClass('text-danger');
  });
});

describe('Skeleton', () => {
  it('reserves the height it is given, so the content that replaces it does not shift the page', () => {
    render(<Skeleton data-testid="row" height="2.5rem" />);
    expect(screen.getByTestId('row').style.height).toBe('2.5rem');
  });

  it('takes a number as pixels, and a width', () => {
    render(<Skeleton data-testid="line" height={20} width="12rem" />);
    const line = screen.getByTestId('line');
    expect(line.style.height).toBe('20px');
    expect(line.style.width).toBe('12rem');
  });

  it('is decoration: hidden from assistive technology, and it does not animate (every animation is at most 200 ms)', () => {
    render(<Skeleton data-testid="row" height={16} />);
    const skeleton = screen.getByTestId('row');
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    expect(skeleton.className).not.toMatch(/animate-/);
    expect(skeleton).toHaveClass('bg-line-subtle', 'rounded-md');
  });
});

describe('EmptyState', () => {
  it('renders the title, the description and an action, under a heading of the level it is given', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <EmptyState
        headingLevel={2}
        title="No contacts yet"
        description="Contacts arrive in Phase D."
        action={<Button onClick={onClick}>Learn more</Button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'No contacts yet' })).toBeInTheDocument();
    expect(screen.getByText('Contacts arrive in Phase D.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Learn more' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('works without a description and an action, and puts an icon above the title when given one', () => {
    render(<EmptyState headingLevel={3} title="Nothing here" icon={<svg data-testid="icon" />} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Nothing here' })).toBeInTheDocument();
    expect(screen.getByTestId('icon').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('renders the title, the description, an action and the request id, as an alert with an icon', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ErrorState
        headingLevel={2}
        title="Something went wrong"
        description="The request could not be completed."
        action={<Button onClick={onRetry}>Try again</Button>}
        requestIdLabel="Request id"
        requestId="req_0123456789abcdef"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(
      within(alert).getByRole('heading', { level: 2, name: 'Something went wrong' }),
    ).toBeInTheDocument();
    expect(within(alert).getByText('The request could not be completed.')).toBeInTheDocument();
    expect(alert.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    expect(within(alert).getByText('Request id')).toBeInTheDocument();
    expect(within(alert).getByText('req_0123456789abcdef')).toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('leaves the request id slot out when there is none (no empty label)', () => {
    render(
      <ErrorState headingLevel={2} title="Something went wrong" requestIdLabel="Request id" />,
    );
    expect(screen.queryByText('Request id')).not.toBeInTheDocument();
  });

  it('never shows anything but what it is given (no stack, no English detail of its own)', () => {
    render(<ErrorState headingLevel={2} title="Oops" />);
    expect(screen.getByRole('alert').textContent).toBe('Oops');
  });
});

describe('Persona', () => {
  it('shows the initials it is given and has an accessible name from a prop', () => {
    render(<Persona initials="AE" label="Alice Example" />);
    const persona = screen.getByRole('img', { name: 'Alice Example' });
    expect(persona).toHaveTextContent('AE');
  });

  it('hides the initials from assistive technology, so the name is read once', () => {
    render(<Persona initials="AE" label="Alice Example" />);
    const persona = screen.getByRole('img', { name: 'Alice Example' });
    expect(persona.querySelector('[aria-hidden="true"]')).toHaveTextContent('AE');
  });

  it('is round (an avatar is one of the uses of the full radius), in three sizes', () => {
    const { rerender } = render(<Persona initials="AE" label="Alice" size="sm" />);
    expect(screen.getByRole('img', { name: 'Alice' })).toHaveClass('rounded-full', 'size-6');
    rerender(<Persona initials="AE" label="Alice" size="md" />);
    expect(screen.getByRole('img', { name: 'Alice' })).toHaveClass('size-8');
    rerender(<Persona initials="AE" label="Alice" size="lg" />);
    expect(screen.getByRole('img', { name: 'Alice' })).toHaveClass('size-10');
  });

  it('keeps a border under forced colours, where the fill that makes it a circle is replaced', () => {
    render(<Persona initials="AE" label="Alice" />);
    expect(screen.getByRole('img', { name: 'Alice' })).toHaveClass('forced-colors:border');
  });

  it('uses the accent pair, whose contrast is guaranteed for any brand colour', () => {
    render(<Persona initials="AE" label="Alice" />);
    expect(screen.getByRole('img', { name: 'Alice' })).toHaveClass('bg-accent', 'text-on-accent');
  });
});
