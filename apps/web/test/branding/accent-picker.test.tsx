// The accent picker (T-A-211; FR-A-132, FR-A-103; E-03, E-04; US-2.3): a hex field that normalises, eight
// named swatches, a native colour input, and for every theme the chosen and the effective colour with a
// sentence that does not rely on colour. Saving is never blocked: the picker has no say in it.
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import enCatalogue from '@m365portal/shared/i18n/locales/en.json';
import nlCatalogue from '@m365portal/shared/i18n/locales/nl.json';
import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AccentPicker } from '../../src/features/branding/AccentPicker';
import { loadBrandingTools } from '../../src/features/branding/tools';
import { renderInLanguage } from './helpers';

const en = enCatalogue as Record<string, string>;
const nl = nlCatalogue as Record<string, string>;

function Harness({
  initial,
  onValue,
  disabled,
}: {
  readonly initial: string;
  readonly onValue?: (value: string) => void;
  readonly disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <AccentPicker
      value={value}
      disabled={disabled ?? false}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

async function mount(initial: string, language: 'en' | 'nl' = 'en', onValue?: (v: string) => void) {
  await loadBrandingTools();
  const view = renderInLanguage(
    <Harness initial={initial} {...(onValue ? { onValue } : {})} />,
    language,
  );
  const labels = language === 'nl' ? nl : en;
  const field = await screen.findByRole<HTMLInputElement>('textbox', {
    name: labels['accent.hexLabel'],
  });
  return { ...view, field };
}

describe('the hex field', () => {
  it('accepts #abc and shows the normalised #aabbcc', async () => {
    const { field, user } = await mount('#0078d4');
    await user.clear(field);
    await user.type(field, '#abc');
    // While typing, the field keeps what was typed and says what will be saved.
    expect(field).toHaveValue('#abc');
    expect(screen.getByText('Saved as #aabbcc')).toBeInTheDocument();
    await user.tab();
    expect(field).toHaveValue('#aabbcc');
    expect(field).not.toHaveAttribute('aria-invalid');
  });

  it('upper case is stored in lower case', async () => {
    const onValue = vi.fn();
    const { field, user } = await mount('#0078d4', 'en', onValue);
    await user.clear(field);
    await user.type(field, '#00AAFF');
    await user.tab();
    expect(field).toHaveValue('#00aaff');
    expect(onValue).toHaveBeenLastCalledWith('#00aaff');
  });

  it('shows the translated accent_invalid message for input that is no colour, in both languages', async () => {
    const { field, user, unmount } = await mount('#0078d4');
    await user.clear(field);
    await user.type(field, 'blue');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en['problem.accent_invalid']!);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    unmount();

    const dutch = await mount('#0078d4', 'nl');
    await dutch.user.clear(dutch.field);
    await dutch.user.type(dutch.field, '#12');
    expect(await screen.findByRole('alert')).toHaveTextContent(nl['problem.accent_invalid']!);
  });

  it('does not nag before the person has typed', async () => {
    await mount('#0078d4');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaves what is not a colour alone on blur (it is not rewritten)', async () => {
    const { field, user } = await mount('#0078d4');
    await user.clear(field);
    await user.type(field, '#12');
    await user.tab();
    expect(field).toHaveValue('#12');
  });
});

describe('the swatches and the native input', () => {
  it('has eight swatches, each with an accessible name that holds its hex code', async () => {
    await mount('#0078d4');
    const group = await screen.findByRole('group', { name: en['accent.swatchesLabel'] });
    const swatches = within(group).getAllByRole('button');
    expect(swatches).toHaveLength(8);
    for (const swatch of swatches) {
      expect(swatch).toHaveAccessibleName(/^[A-Z][a-z]+, #[0-9a-f]{6}$/);
    }
    const names = swatches.map((swatch) => swatch.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(8);
  });

  it('marks the swatch that matches the value as pressed, and says so without colour', async () => {
    await mount('#0078d4');
    const group = await screen.findByRole('group', { name: en['accent.swatchesLabel'] });
    const pressed = within(group)
      .getAllByRole('button')
      .filter((swatch) => swatch.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toHaveAccessibleName(/^Blue, #0078d4$/);
  });

  it('a swatch click sets the value; the keyboard does the same with Enter and Space', async () => {
    const onValue = vi.fn();
    const { field, user } = await mount('#0078d4', 'en', onValue);
    const group = await screen.findByRole('group', { name: en['accent.swatchesLabel'] });
    const swatches = within(group).getAllByRole('button');
    const target = swatches[3]!;
    const hex = /#[0-9a-f]{6}/.exec(target.getAttribute('aria-label') ?? '')![0];
    await user.click(target);
    expect(field).toHaveValue(hex);

    const other = swatches[5]!;
    const otherHex = /#[0-9a-f]{6}/.exec(other.getAttribute('aria-label') ?? '')![0];
    other.focus();
    await user.keyboard('{Enter}');
    expect(field).toHaveValue(otherHex);

    const third = swatches[2]!;
    const thirdHex = /#[0-9a-f]{6}/.exec(third.getAttribute('aria-label') ?? '')![0];
    third.focus();
    await user.keyboard(' ');
    expect(field).toHaveValue(thirdHex);
    expect(onValue).toHaveBeenCalledTimes(3);
  });

  it('has a native colour input that follows the value and writes #rrggbb', async () => {
    const { field, user } = await mount('#0078d4');
    const native = screen.getByLabelText<HTMLInputElement>(en['accent.nativeLabel']!);
    expect(native.type).toBe('color');
    expect(native.value).toBe('#0078d4');
    await user.clear(field);
    await user.type(field, '#abc');
    expect(native.value).toBe('#aabbcc');
    // happy-dom lets the test set the value the way the browser's picker does.
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.input(native, { target: { value: '#112233' } });
    fireEvent.change(native, { target: { value: '#112233' } });
    await waitFor(() => {
      expect(field).toHaveValue('#112233');
    });
  });

  it('can be tabbed through: field, native input, then every swatch', async () => {
    const { user } = await mount('#0078d4');
    await screen.findByRole('group', { name: en['accent.swatchesLabel'] });
    await user.tab();
    const stops: (string | null)[] = [];
    for (let step = 0; step < 10; step += 1) {
      stops.push(
        document.activeElement?.getAttribute('aria-label') ??
          document.activeElement?.tagName ??
          null,
      );
      await user.tab();
    }
    expect(stops.filter((stop) => stop !== null && /#[0-9a-f]{6}/.test(stop))).toHaveLength(8);
  });
});

describe('the result in both themes', () => {
  it('for #ffff00 shows the chosen and the effective colour, light and dark, with words', async () => {
    await mount('#ffff00');
    const tokens = deriveAccentTokens('#ffff00');
    // The light theme has to move yellow (it has no contrast with white); the text says so.
    expect(tokens.light.adjusted).toBe(true);

    const light = await screen.findByRole('group', { name: en['accent.theme.light'] });
    const dark = screen.getByRole('group', { name: en['accent.theme.dark'] });
    expect(within(light).getByText('Chosen: #ffff00')).toBeInTheDocument();
    expect(within(light).getByText(`Used: ${tokens.light.accent}`)).toBeInTheDocument();
    expect(within(light).getByText(en['accent.explainAdjusted']!)).toBeInTheDocument();
    expect(within(dark).getByText('Chosen: #ffff00')).toBeInTheDocument();
    expect(within(dark).getByText(`Used: ${tokens.dark.accent}`)).toBeInTheDocument();
    // In the dark theme yellow is fine as it is: the sentence says that, in words.
    expect(tokens.dark.adjusted).toBe(false);
    expect(within(dark).getByText(en['accent.explainSame']!)).toBeInTheDocument();
  });

  it('draws both colours as chips, through the CSSOM and never a style attribute', async () => {
    await mount('#ffff00');
    const tokens = deriveAccentTokens('#ffff00');
    const light = await screen.findByRole('group', { name: en['accent.theme.light'] });
    const chips = [...light.querySelectorAll<HTMLElement>('[data-slot="colour-chip"]')];
    expect(chips.map((chip) => chip.dataset.colour)).toEqual(['#ffff00', tokens.light.accent]);
    for (const chip of chips) {
      expect(chip.style.getPropertyValue('background-color')).not.toBe('');
      expect(chip).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('says the colour is used as chosen when nothing had to move', async () => {
    await mount('#0078d4');
    const tokens = deriveAccentTokens('#0078d4');
    const light = await screen.findByRole('group', { name: en['accent.theme.light'] });
    expect(tokens.light.adjusted).toBe(false);
    expect(within(light).getByText(en['accent.explainSame']!)).toBeInTheDocument();
    expect(within(light).queryByText(en['accent.explainAdjusted']!)).not.toBeInTheDocument();
  });

  it('shows no result for a value that is not a colour, and still has no opinion about saving', async () => {
    const { field, user } = await mount('#0078d4');
    await user.clear(field);
    await user.type(field, 'x');
    await waitFor(() => {
      expect(
        screen.queryByRole('group', { name: en['accent.theme.light'] }),
      ).not.toBeInTheDocument();
    });
    // The picker renders no button that could stand for "save": it only offers colours.
    expect(screen.queryByRole('button', { name: /save|opslaan/i })).not.toBeInTheDocument();
  });

  it('never disables anything because the colour had to be adjusted', async () => {
    await mount('#ffff00');
    await screen.findByRole('group', { name: en['accent.theme.light'] });
    for (const control of [...screen.getAllByRole('button'), ...screen.getAllByRole('textbox')]) {
      expect(control).toBeEnabled();
    }
  });

  it('is written in Dutch in Dutch', async () => {
    await mount('#ffff00', 'nl');
    expect(
      await screen.findByRole('group', { name: nl['accent.theme.light'] }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Gekozen: #ffff00')).toHaveLength(2);
  });
});

describe('disabled', () => {
  it('disables the field, the native input and the swatches together', async () => {
    await loadBrandingTools();
    renderInLanguage(<Harness initial="#0078d4" disabled />);
    expect(await screen.findByRole('textbox', { name: en['accent.hexLabel'] })).toBeDisabled();
    expect(screen.getByLabelText(en['accent.nativeLabel']!)).toBeDisabled();
    const group = screen.getByRole('group', { name: en['accent.swatchesLabel'] });
    for (const swatch of within(group).getAllByRole('button')) expect(swatch).toBeDisabled();
  });
});
