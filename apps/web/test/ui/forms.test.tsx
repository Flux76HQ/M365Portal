// FORM CONTROLS (FR-A-124, FR-A-103, FR-A-152; T-A-125).
//
// What this proves, per control: the role and the accessible name, operation with the keyboard alone
// (Space, Enter, arrows), the disabled and read-only states, that a state is never carried by colour
// alone (an icon or text is present), that the control height and the target size come from the token
// utilities (h-control, min-h-target: the CSS test proves they map to --control-height and
// --target-min), and that every visible string is a prop: nothing in a component is a literal.
import { expectGuardFails } from '@m365portal/shared/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../../src/components/ui/button';
import { Checkbox } from '../../src/components/ui/checkbox';
import { FormField } from '../../src/components/ui/form-field';
import { IconButton } from '../../src/components/ui/icon-button';
import { Input } from '../../src/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../../src/components/ui/input-group';
import { RadioGroup, RadioOption } from '../../src/components/ui/radio-group';
import { Select } from '../../src/components/ui/select';
import { Switch } from '../../src/components/ui/switch';
import { Textarea } from '../../src/components/ui/textarea';

const OPTIONS = [
  { value: 'nl', label: 'Nederlands' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch', disabled: true },
] as const;

/** Radix Select needs a few browser APIs that happy-dom does not have; stubs only, no behaviour. */
function installSelectPolyfills(): void {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
}

describe('Button', () => {
  it('is a button with its text as name, and Enter and Space activate it', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });

    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('does nothing when disabled and is skipped by Tab', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <>
        <Button disabled onClick={onClick}>
          Save
        </Button>
        <Button>Other</Button>
      </>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Other' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('uses the control height of the pointer and a target of at least 24 px', () => {
    render(
      <>
        <Button>Default</Button>
        <Button size="sm">Small</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Default' })).toHaveClass('h-control');
    const small = screen.getByRole('button', { name: 'Small' });
    expect(small).toHaveClass('min-h-target');
    expect(small).toHaveClass('min-w-target');
  });

  it('draws its colours from tokens only, per variant', () => {
    render(
      <>
        <Button variant="primary">P</Button>
        <Button variant="secondary">S</Button>
        <Button variant="ghost">G</Button>
        <Button variant="destructive">D</Button>
        <Button variant="link">L</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'P' })).toHaveClass('bg-accent', 'text-on-accent');
    expect(screen.getByRole('button', { name: 'D' })).toHaveClass('text-danger', 'border-danger');
    expect(screen.getByRole('button', { name: 'L' })).toHaveClass('text-accent-text', 'underline');
  });

  it('renders its child element instead of a button with asChild (a link that looks like a button)', () => {
    render(
      <Button asChild>
        <a href="/settings">Settings</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Settings' });
    expect(link).toHaveClass('h-control');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('IconButton', () => {
  it('takes its accessible name from the label prop and hides the icon from assistive technology', () => {
    render(
      <IconButton label="Close panel">
        <svg data-testid="icon" />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Close panel' });
    expect(button).toHaveClass('min-h-target', 'min-w-target');
    expect(within(button).getByTestId('icon').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('is operated with the keyboard like any button', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <IconButton label="Close panel" onClick={onClick}>
        <svg />
      </IconButton>,
    );
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Input and Textarea', () => {
  it('are text boxes with the control height, and accept typing', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Input aria-label="Name" />
        <Textarea aria-label="Notes" />
      </>,
    );
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input).toHaveClass('h-control');
    await user.type(input, 'Contoso');
    expect(input).toHaveValue('Contoso');

    const textarea = screen.getByRole('textbox', { name: 'Notes' });
    await user.type(textarea, 'a{Enter}b');
    expect(textarea).toHaveValue('a\nb');
  });

  it('keeps the disabled and read-only states apart: read-only is focusable and selectable, disabled is neither', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Input aria-label="Locked" readOnly defaultValue="fixed" />
        <Input aria-label="Off" disabled defaultValue="off" />
      </>,
    );
    const locked = screen.getByRole('textbox', { name: 'Locked' });
    const off = screen.getByRole('textbox', { name: 'Off' });
    await user.tab();
    expect(locked).toHaveFocus();
    await user.type(locked, 'x');
    expect(locked).toHaveValue('fixed');
    expect(off).toBeDisabled();
    expect(locked).toHaveClass('read-only:bg-surface-page');
  });

  it('draws an invalid input with the danger border, and the placeholder in the muted text colour', () => {
    render(<Input aria-label="Email" aria-invalid="true" placeholder="name@example.org" />);
    const input = screen.getByRole('textbox', { name: 'Email' });
    expect(input).toHaveClass('aria-invalid:border-danger', 'placeholder:text-fg-muted');
    expect(input).toBeInvalid();
  });
});

describe('InputGroup: an input with a fixed prefix or suffix', () => {
  it('draws one bordered box around the addon and the input, and the input is named like any input', () => {
    render(
      <FormField label="Accent colour">
        {(control) => (
          <InputGroup data-testid="group">
            <InputGroupAddon>#</InputGroupAddon>
            <InputGroupInput {...control} defaultValue="0078d4" />
            <InputGroupAddon align="end">hex</InputGroupAddon>
          </InputGroup>
        )}
      </FormField>,
    );
    const input = screen.getByRole('textbox', { name: 'Accent colour' });
    const group = screen.getByTestId('group');
    expect(group).toContainElement(input);
    expect(group).toHaveClass('h-control', 'border', 'border-line-control');
    expect(within(group).getByText('#')).toBeInTheDocument();
    expect(within(group).getByText('hex')).toBeInTheDocument();
  });

  it('keeps the box and loses the border of the inner input, which draws the focus ring inside the box', () => {
    render(
      <InputGroup>
        <InputGroupInput aria-label="Host" />
      </InputGroup>,
    );
    const input = screen.getByRole('textbox', { name: 'Host' });
    expect(input).toHaveClass('border-0', 'focus-visible:-outline-offset-2');
    expect(input.className).not.toMatch(/outline-none/);
  });

  it('marks the whole box invalid when the input is, and dims it when the input is disabled', () => {
    render(
      <InputGroup>
        <InputGroupAddon>@</InputGroupAddon>
        <InputGroupInput aria-label="Handle" aria-invalid="true" disabled />
      </InputGroup>,
    );
    const group = screen.getByRole('textbox', { name: 'Handle' }).parentElement;
    expect(group).toHaveClass(
      'has-[[aria-invalid=true]]:border-danger',
      'has-[:disabled]:opacity-50',
    );
  });

  it('puts the addon on the right side for the end alignment, and the input in the middle', () => {
    render(
      <InputGroup data-testid="group">
        <InputGroupAddon align="end">suffix</InputGroupAddon>
        <InputGroupInput aria-label="Host" />
      </InputGroup>,
    );
    expect(screen.getByText('suffix')).toHaveClass('order-last', 'pe-3');
  });
});

describe('FormField: label, hint and error are tied to the control', () => {
  function Example({ error }: { readonly error?: string }) {
    return (
      <FormField
        label="Organisation name"
        hint="Shown in the header."
        error={error}
        required
        requiredLabel="required"
      >
        {(control) => <Input {...control} />}
      </FormField>
    );
  }

  it('names the control by its label, and describes it by the hint', () => {
    render(<Example />);
    const input = screen.getByRole('textbox', { name: /Organisation name/ });
    expect(screen.getByText('Shown in the header.')).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription('Shown in the header.');
    expect(input).toBeRequired();
    expect(input).not.toBeInvalid();
  });

  it('shows the requirement as text, not as a colour or a lone asterisk', () => {
    render(<Example />);
    expect(screen.getByText('required')).toBeInTheDocument();
  });

  it('marks the control invalid, describes it by hint and error, and announces the error', () => {
    render(<Example error="Enter a name of at most 64 characters." />);
    const input = screen.getByRole('textbox', { name: /Organisation name/ });
    const alert = screen.getByRole('alert');

    expect(alert).toHaveTextContent('Enter a name of at most 64 characters.');
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription(
      'Shown in the header. Enter a name of at most 64 characters.',
    );
  });

  it('never conveys an error by colour alone: the error has an icon and text', () => {
    render(<Example error="Too long." />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Too long.');
    expect(alert.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('announces an error that appears after the first render, and removes it when it is fixed', () => {
    const { rerender } = render(<Example />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    rerender(<Example error="Required." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Required.');
    rerender(<Example />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Organisation name/ })).not.toBeInvalid();
  });

  it('gives two fields on one page two different ids', () => {
    render(
      <>
        <FormField label="First">{(control) => <Input {...control} />}</FormField>
        <FormField label="Second">{(control) => <Input {...control} />}</FormField>
      </>,
    );
    const first = screen.getByRole('textbox', { name: 'First' });
    const second = screen.getByRole('textbox', { name: 'Second' });
    expect(first.id).not.toBe('');
    expect(first.id).not.toBe(second.id);
  });

  it('lays a checkbox out beside its label (inline) and keeps the association', async () => {
    const user = userEvent.setup();
    render(
      <FormField label="Send a copy" layout="inline" hint="To the owner.">
        {(control) => <Checkbox {...control} />}
      </FormField>,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Send a copy' });
    expect(checkbox).toHaveAccessibleDescription('To the owner.');
    await user.click(screen.getByText('Send a copy'));
    expect(checkbox).toBeChecked();
  });

  it('labels a group (radio group) through aria-labelledby', () => {
    render(
      <FormField label="Theme">
        {(control) => (
          <RadioGroup {...control} defaultValue="light">
            <RadioOption value="light" label="Light" />
            <RadioOption value="dark" label="Dark" />
          </RadioGroup>
        )}
      </FormField>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
  });
});

describe('Checkbox', () => {
  function Controlled({
    onChange,
  }: {
    readonly onChange?: (value: boolean | 'indeterminate') => void;
  }) {
    const [checked, setChecked] = useState<boolean | 'indeterminate'>(false);
    return (
      <Checkbox
        aria-label="Select row"
        checked={checked}
        onCheckedChange={(value) => {
          setChecked(value);
          onChange?.(value);
        }}
      />
    );
  }

  it('has role checkbox, toggles with Space, and shows a check mark when checked (not colour alone)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Select row' });
    expect(checkbox.querySelector('svg')).toBeNull();

    await user.tab();
    await user.keyboard(' ');
    expect(checkbox).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(checkbox.querySelector('svg')).not.toBeNull();

    await user.keyboard(' ');
    expect(checkbox).not.toBeChecked();
  });

  it('shows the mixed state with a dash and aria-checked="mixed"', () => {
    render(<Checkbox aria-label="Select all" checked="indeterminate" />);
    const checkbox = screen.getByRole('checkbox', { name: 'Select all' });
    expect(checkbox).toHaveAttribute('aria-checked', 'mixed');
    expect(checkbox.querySelector('svg')).not.toBeNull();
  });

  it('is at least 24 by 24 px through the target token, and can be disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox aria-label="Off" disabled onCheckedChange={onChange} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Off' });
    expect(checkbox).toHaveClass('size-target');
    await user.click(checkbox);
    expect(onChange).not.toHaveBeenCalled();
    expect(checkbox).toBeDisabled();
  });
});

/**
 * Radix moves the focus one macrotask after the arrow key goes down and selects the radio when the
 * focus arrives while the key is still held. user-event releases the key at once, so hold it until
 * the focus has moved, as a real keyboard does.
 */
async function pressArrow(
  user: ReturnType<typeof userEvent.setup>,
  key: 'ArrowDown' | 'ArrowUp',
): Promise<void> {
  await user.keyboard(`{${key}>}`);
  await user.keyboard(`{/${key}}`);
}

describe('RadioGroup', () => {
  it('is a radiogroup of radios; the arrow keys move the selection and the focus together', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup aria-label="Density" defaultValue="compact" onValueChange={onValueChange}>
        <RadioOption value="compact" label="Compact" />
        <RadioOption value="comfortable" label="Comfortable" />
        <RadioOption value="roomy" label="Roomy" />
      </RadioGroup>,
    );
    const compact = screen.getByRole('radio', { name: 'Compact' });
    expect(compact).toBeChecked();

    await user.tab();
    expect(compact).toHaveFocus();
    await pressArrow(user, 'ArrowDown');
    const comfortable = screen.getByRole('radio', { name: 'Comfortable' });
    expect(comfortable).toHaveFocus();
    expect(comfortable).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith('comfortable');

    await pressArrow(user, 'ArrowUp');
    await pressArrow(user, 'ArrowUp');
    expect(screen.getByRole('radio', { name: 'Roomy' })).toBeChecked();
  });

  it('shows the selected radio with a dot, not only a colour, and puts the whole group in one tab stop', async () => {
    const user = userEvent.setup();
    render(
      <>
        <RadioGroup aria-label="Theme" defaultValue="dark">
          <RadioOption value="light" label="Light" />
          <RadioOption value="dark" label="Dark" />
        </RadioGroup>
        <Button>After</Button>
      </>,
    );
    const dark = screen.getByRole('radio', { name: 'Dark' });
    expect(dark.querySelector('[data-slot="radio-indicator"]')).not.toBeNull();
    expect(
      screen.getByRole('radio', { name: 'Light' }).querySelector('[data-slot="radio-indicator"]'),
    ).toBeNull();

    await user.tab();
    expect(dark).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('takes the label of each option from a prop, and its hint', () => {
    render(
      <RadioGroup aria-label="Mode" defaultValue="a">
        <RadioOption value="a" label="Automatic" hint="Follows the system." />
      </RadioGroup>,
    );
    expect(screen.getByRole('radio', { name: 'Automatic' })).toHaveAccessibleDescription(
      'Follows the system.',
    );
  });
});

describe('Switch', () => {
  it('has role switch, toggles with Space, and exposes its state (aria-checked) beside the thumb position', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Sidebar collapsed" onCheckedChange={onCheckedChange} />);
    const toggle = screen.getByRole('switch', { name: 'Sidebar collapsed' });
    expect(toggle).not.toBeChecked();

    await user.tab();
    await user.keyboard(' ');
    expect(toggle).toBeChecked();
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    expect(toggle.querySelector('[data-slot="switch-thumb"]')).toHaveAttribute(
      'data-state',
      'checked',
    );
  });

  it('has a target of at least 24 px in height and width, and a disabled state', () => {
    render(<Switch aria-label="Off" disabled />);
    const toggle = screen.getByRole('switch', { name: 'Off' });
    expect(toggle).toHaveClass('h-target', 'min-w-target');
    expect(toggle).toBeDisabled();
  });
});

describe('Select', () => {
  it('is a combobox with the placeholder as its value; Enter opens it, the arrows move, Enter chooses', async () => {
    installSelectPolyfills();
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select
        aria-label="Language"
        placeholder="Choose a language"
        options={OPTIONS}
        onValueChange={onValueChange}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Language' });
    expect(trigger).toHaveTextContent('Choose a language');
    expect(trigger).toHaveClass('h-control');

    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('en');
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent('English');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('marks the chosen option with a check mark (not colour alone) and skips a disabled option', async () => {
    installSelectPolyfills();
    const user = userEvent.setup();
    render(
      <Select aria-label="Language" placeholder="Choose" options={OPTIONS} defaultValue="nl" />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    const chosen = await screen.findByRole('option', { name: 'Nederlands' });
    expect(chosen).toHaveAttribute('aria-selected', 'true');
    expect(chosen.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('option', { name: 'Deutsch' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('closes with Escape and returns focus to the trigger', async () => {
    installSelectPolyfills();
    const user = userEvent.setup();
    render(<Select aria-label="Language" placeholder="Choose" options={OPTIONS} />);
    const trigger = screen.getByRole('combobox', { name: 'Language' });
    await user.click(trigger);
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('is described by a FormField like any control, and is invalid with its error', () => {
    render(
      <FormField label="Language" hint="Stored in this browser." error="Choose one.">
        {(control) => <Select {...control} placeholder="Choose" options={OPTIONS} />}
      </FormField>,
    );
    const trigger = screen.getByRole('combobox', { name: /Language/ });
    expect(trigger).toHaveAccessibleDescription('Stored in this browser. Choose one.');
    expect(trigger).toBeInvalid();
  });
});

// ---------------------------------------------------------------------------------------------
// Every visible string is a prop (contract C12): the sources of the form controls carry no text of
// their own. A source scan, because a component cannot be asked which strings it could render.
// ---------------------------------------------------------------------------------------------

const FORM_FILES = [
  'button',
  'icon-button',
  'input',
  'textarea',
  'select',
  'checkbox',
  'radio-group',
  'switch',
  'form-field',
  'input-group',
];

/** JSX text and text-bearing attributes that are literal. A coarse net; eslint's no-literal-ui-strings is the precise control. */
function literalTextIn(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const found: string[] = [];
  for (const match of code.matchAll(/>\s*([A-Za-z][^<>{}]*[A-Za-z.!?])\s*</g))
    found.push(match[1] ?? '');
  for (const match of code.matchAll(
    /\b(?:aria-label|title|placeholder|alt)\s*=\s*"([^"]*[A-Za-z][^"]*)"/g,
  )) {
    found.push(match[1] ?? '');
  }
  return found;
}

function assertNoLiteralText(files: Readonly<Record<string, string>>): void {
  const problems = Object.entries(files).flatMap(([file, source]) =>
    literalTextIn(source).map((text) => `${file}: literal text "${text}"`),
  );
  if (problems.length > 0) throw new Error(problems.join('; '));
}

describe('every visible string is a prop', () => {
  it('the sources of the form controls contain no literal text', () => {
    const directory = join(import.meta.dirname, '../../src/components/ui');
    expect(readdirSync(directory)).toEqual(
      expect.arrayContaining(FORM_FILES.map((name) => `${name}.tsx`)),
    );
    const files = Object.fromEntries(
      FORM_FILES.map((name) => [
        `${name}.tsx`,
        readFileSync(join(directory, `${name}.tsx`), 'utf8'),
      ]),
    );
    assertNoLiteralText(files);
  });

  it('negative: literal JSX text and a literal aria-label fail the scan', () => {
    expectGuardFails(
      assertNoLiteralText,
      { 'a.tsx': 'export const A = () => <button>Save changes</button>;' },
      {
        name: 'assertNoLiteralText',
        reason: 'literal text "Save changes"',
      },
    );
    expectGuardFails(
      assertNoLiteralText,
      { 'b.tsx': 'export const B = () => <input aria-label="Search" />;' },
      {
        name: 'assertNoLiteralText',
        reason: 'literal text "Search"',
      },
    );
  });
});
