// The live preview (T-A-213; FR-A-132, A-39; US-2.1, US-2.2): the sidebar, header and buttons of the
// shell in light and dark side by side, with the organisation name, the logo or the monogram and the
// accent being edited. Pure: it draws from its props and makes no request.
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { logoPlateFor } from '@m365portal/shared/branding/logo-plate';
import { monogramFor } from '@m365portal/shared/branding/monogram';
import enCatalogue from '@m365portal/shared/i18n/locales/en.json';
import nlCatalogue from '@m365portal/shared/i18n/locales/nl.json';
import { act, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LivePreview } from '../../src/features/branding/LivePreview';
import { loadBrandingTools } from '../../src/features/branding/tools';
import type { AssetRef, LogoVariant } from '../../src/features/branding/types';
import { renderInLanguage } from './helpers';

const en = enCatalogue as Record<string, string>;
const nl = nlCatalogue as Record<string, string>;

const NO_LOGOS: Record<LogoVariant, AssetRef | null> = { light: null, dark: null, compact: null };
const logo = (luminance: number | null, hash = 'd'.repeat(64)): AssetRef => ({
  hash,
  url: `/branding/${hash}.png`,
  width: 200,
  height: 60,
  luminance,
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Props {
  readonly orgName?: string;
  readonly accent?: string;
  readonly logos?: Record<LogoVariant, AssetRef | null>;
}

async function mount(props: Props = {}, language: 'en' | 'nl' = 'en') {
  await loadBrandingTools();
  return renderInLanguage(
    <LivePreview
      orgName={props.orgName ?? 'Acme'}
      accent={props.accent ?? '#0078d4'}
      logos={props.logos ?? NO_LOGOS}
    />,
    language,
  );
}

function pane(theme: 'light' | 'dark'): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-preview-theme="${theme}"]`);
  if (found === null) throw new Error(`no ${theme} pane`);
  return found;
}

describe('the panes', () => {
  it('shows light and dark side by side, each with a sidebar, a header and buttons', async () => {
    await mount();
    for (const theme of ['light', 'dark'] as const) {
      const current = pane(theme);
      expect(current.querySelector('[data-preview-part="sidebar"]')).not.toBeNull();
      expect(current.querySelector('[data-preview-part="header"]')).not.toBeNull();
      expect(current).toHaveAttribute('data-theme', theme);
    }
    expect(document.querySelectorAll('[data-preview-theme]')).toHaveLength(2);
  });

  it('draws primary and secondary buttons in rest, hover, active and focus in each pane', async () => {
    await mount();
    for (const theme of ['light', 'dark'] as const) {
      for (const variant of ['primary', 'secondary'] as const) {
        const states = [
          ...pane(theme).querySelectorAll<HTMLElement>(`[data-preview-button="${variant}"]`),
        ];
        expect(states.map((button) => button.dataset.state)).toEqual([
          'rest',
          'hover',
          'active',
          'focus',
        ]);
      }
    }
  });

  it('names every state in words next to its button, so a state is never colour alone', async () => {
    await mount();
    const current = pane('light');
    for (const key of ['rest', 'hover', 'active', 'focus'] as const) {
      expect(
        within(current).getAllByText(en[`preview.state.${key}`]!).length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('draws the preview buttons so that they cannot be used', async () => {
    await mount();
    const buttons = document.querySelectorAll<HTMLElement>('[data-preview-button]');
    expect(buttons.length).toBe(16);
    for (const button of buttons) expect(button).toHaveAttribute('tabindex', '-1');
    expect(pane('light').querySelector('[data-preview-window]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });
});

describe('colours through the CSSOM', () => {
  it('sets the accent and surface variables of each pane with style.setProperty', async () => {
    await mount({ accent: '#ffff00' });
    const tokens = deriveAccentTokens('#ffff00');
    expect(pane('light').style.getPropertyValue('--accent')).toBe(tokens.light.accent);
    expect(pane('dark').style.getPropertyValue('--accent')).toBe(tokens.dark.accent);
    expect(pane('light').style.getPropertyValue('--accent-subtle')).toBe(tokens.light.accentSubtle);
    expect(pane('dark').style.getPropertyValue('--on-accent')).toBe(tokens.dark.onAccent);
    // The two panes really are different themes: the page surface differs.
    const lightPage = pane('light').style.getPropertyValue('--surface-page');
    const darkPage = pane('dark').style.getPropertyValue('--surface-page');
    expect(lightPage).not.toBe('');
    expect(darkPage).not.toBe('');
    expect(lightPage).not.toBe(darkPage);
    expect(pane('dark').style.getPropertyValue('color-scheme')).toBe('dark');
  });

  it('never writes a style attribute string, at mount or on update', async () => {
    // happy-dom mirrors every CSSOM write into the attribute by calling setAttribute('style') from inside
    // setProperty and removeProperty; a browser does not. Those mirrored calls are not a violation, a
    // setAttribute('style', ...) from anywhere else is.
    let insideCssom = 0;
    const violations: unknown[] = [];
    const prototype = CSSStyleDeclaration.prototype;
    for (const method of ['setProperty', 'removeProperty'] as const) {
      const original = prototype[method] as (...args: unknown[]) => unknown;
      vi.spyOn(prototype, method).mockImplementation(function (
        this: CSSStyleDeclaration,
        ...args: unknown[]
      ) {
        insideCssom += 1;
        try {
          return original.apply(this, args);
        } finally {
          insideCssom -= 1;
        }
      });
    }
    const originalSetAttribute = Element.prototype.setAttribute;
    vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (
      this: Element,
      name: string,
      value: string,
    ) {
      if (name.toLowerCase() === 'style' && insideCssom === 0) violations.push([name, value]);
      originalSetAttribute.call(this, name, value);
    });
    const setProperty = vi.mocked(prototype.setProperty);

    function Harness() {
      const [accent, setAccent] = useState('#0078d4');
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setAccent('#cc3300');
            }}
          >
            change
          </button>
          <LivePreview orgName="Acme" accent={accent} logos={{ ...NO_LOGOS, light: logo(0.2) }} />
        </>
      );
    }
    await loadBrandingTools();
    const { user } = renderInLanguage(<Harness />);
    await user.click(screen.getByRole('button', { name: 'change' }));

    expect(violations).toEqual([]);
    expect(setProperty.mock.calls.some(([name]) => name === '--accent')).toBe(true);
    expect(pane('light').style.getPropertyValue('--accent')).toBe(
      deriveAccentTokens('#cc3300').light.accent,
    );
  });

  it('negative control: the spy does see a style attribute written directly', () => {
    const written: string[] = [];
    const originalSetAttribute = Element.prototype.setAttribute;
    vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (
      this: Element,
      name: string,
      value: string,
    ) {
      if (name.toLowerCase() === 'style') written.push(value);
      originalSetAttribute.call(this, name, value);
    });
    document.createElement('div').setAttribute('style', 'color: red');
    expect(written).toEqual(['color: red']);
  });
});

describe('it follows the form at once, with no request', () => {
  it('updates the name and the accent on every change', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    function Harness() {
      const [name, setName] = useState('Acme');
      const [accent, setAccent] = useState('#0078d4');
      return (
        <>
          <input
            aria-label="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <input
            aria-label="accent"
            value={accent}
            onChange={(event) => {
              setAccent(event.target.value);
            }}
          />
          <LivePreview orgName={name} accent={accent} logos={NO_LOGOS} />
        </>
      );
    }
    await loadBrandingTools();
    const { user } = renderInLanguage(<Harness />);
    expect(within(pane('light')).getAllByText('Acme').length).toBeGreaterThan(0);

    await user.clear(screen.getByLabelText('name'));
    await user.type(screen.getByLabelText('name'), 'Globex');
    expect(within(pane('light')).getAllByText('Globex').length).toBeGreaterThan(0);
    expect(within(pane('dark')).queryByText('Acme')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('accent'));
    await user.type(screen.getByLabelText('accent'), '#00aa55');
    expect(pane('light').style.getPropertyValue('--accent')).toBe(
      deriveAccentTokens('#00aa55').light.accent,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the last valid accent while the text is not a colour', async () => {
    function Harness() {
      const [accent, setAccent] = useState('#0078d4');
      return (
        <>
          <input
            aria-label="accent"
            value={accent}
            onChange={(event) => {
              setAccent(event.target.value);
            }}
          />
          <LivePreview orgName="Acme" accent={accent} logos={NO_LOGOS} />
        </>
      );
    }
    await loadBrandingTools();
    const { user } = renderInLanguage(<Harness />);
    await user.clear(screen.getByLabelText('accent'));
    // '#00a' is a colour (#rgb); '#00aa' and '#00aa5' are not, so the preview keeps '#00a'.
    await user.type(screen.getByLabelText('accent'), '#00aa5');
    expect(pane('light').style.getPropertyValue('--accent')).toBe(
      deriveAccentTokens('#00a').light.accent,
    );
    await user.type(screen.getByLabelText('accent'), '5');
    expect(pane('light').style.getPropertyValue('--accent')).toBe(
      deriveAccentTokens('#00aa55').light.accent,
    );
  });
});

describe('the mark', () => {
  it('shows the monogram tile of the name when there is no logo', async () => {
    await mount({ orgName: 'Rocket Labs' });
    const expected = monogramFor('Rocket Labs');
    for (const theme of ['light', 'dark'] as const) {
      const tile = pane(theme).querySelector('[data-slot="monogram-tile"]');
      expect(tile).not.toBeNull();
      expect(tile!.querySelectorAll('path')).toHaveLength(expected.glyphs.length);
      expect(pane(theme).querySelector('[data-slot="logo"]')).toBeNull();
    }
  });

  it('shows the logo instead, as an <img> of the asset url, and never the monogram', async () => {
    const light = logo(0.6, 'e'.repeat(64));
    await mount({ logos: { light, dark: null, compact: null } });
    const image = pane('light').querySelector<HTMLImageElement>('[data-slot="logo"] img');
    expect(image).not.toBeNull();
    expect(image!.getAttribute('src')).toBe(light.url);
    expect(pane('light').querySelector('[data-slot="monogram-tile"]')).toBeNull();
    // One logo serves both themes (A-39): the dark pane uses the light logo when there is no dark one.
    expect(
      pane('dark').querySelector<HTMLImageElement>('[data-slot="logo"] img')?.getAttribute('src'),
    ).toBe(light.url);
  });

  it('puts a logo on a plate when logoPlateFor says so, per theme, and never recolours it', async () => {
    const black = logo(0.01, 'f'.repeat(64));
    await mount({ logos: { light: black, dark: null, compact: null } });
    // Same logo, two themes: the rule decides per theme.
    expect(logoPlateFor(0.01, 'dark')).toBe('light');
    expect(logoPlateFor(0.01, 'light')).toBe('none');
    expect(pane('dark').querySelector('[data-slot="logo"]')).toHaveAttribute('data-plate', 'light');
    expect(pane('light').querySelector('[data-slot="logo"]')).toHaveAttribute('data-plate', 'none');
    const plated = pane('dark').querySelector<HTMLElement>('[data-slot="logo"]')!;
    expect(plated.style.getPropertyValue('background-color')).not.toBe('');
    for (const image of document.querySelectorAll<HTMLImageElement>('[data-slot="logo"] img')) {
      expect(image.className).not.toMatch(
        /invert|filter|grayscale|brightness|hue-rotate|mix-blend/,
      );
      expect(image.getAttribute('style')).toBeNull();
    }
  });

  it('gives a logo of unknown luminance no plate', async () => {
    await mount({ logos: { light: logo(null), dark: logo(null, '1'.repeat(64)), compact: null } });
    for (const theme of ['light', 'dark'] as const) {
      expect(pane(theme).querySelector('[data-slot="logo"]')).toHaveAttribute('data-plate', 'none');
    }
  });

  it('uses the compact logo in the header when there is one', async () => {
    const compact = logo(0.5, '2'.repeat(64));
    await mount({ logos: { light: logo(0.5), dark: null, compact } });
    const header = pane('light').querySelector('[data-preview-part="header"]')!;
    expect(header.querySelector('img')?.getAttribute('src')).toBe(compact.url);
  });
});

describe('the organisation name', () => {
  it('is text in an isolating, truncating element with the full name for assistive technology', async () => {
    const long = 'Wolfeschlegelsteinhausenbergerdorff Consulting Group Intl';
    await mount({ orgName: long });
    const names = pane('light').querySelectorAll<HTMLElement>('[data-slot="org-name"]');
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name.tagName).toBe('BDI');
      expect(name.textContent).toBe(long);
      expect(name).toHaveAttribute('title', long);
      expect(name.className).toContain('truncate');
    }
    expect(
      screen.getByRole('group', { name: `Preview, ${en['preview.theme.light']!}: ${long}` }),
    ).toBeInTheDocument();
  });

  it('is never markup: a name with angle brackets stays text', async () => {
    await mount({ orgName: '<img src=x onerror=alert(1)>' });
    expect(pane('light').querySelector('img[src="x"]')).toBeNull();
    expect(
      within(pane('light')).getAllByText('<img src=x onerror=alert(1)>').length,
    ).toBeGreaterThan(0);
  });

  it('falls back to the default name for a name the rules refuse, without throwing', async () => {
    await mount({ orgName: '   ' });
    expect(within(pane('light')).getAllByText('M365Portal').length).toBeGreaterThan(0);
  });
});

describe('words', () => {
  it('speaks Dutch in Dutch and gives screen readers a summary of each pane', async () => {
    await mount({ orgName: 'Acme' }, 'nl');
    expect(screen.getByRole('heading', { name: nl['preview.title']! })).toBeInTheDocument();
    expect(screen.getAllByText(nl['preview.state.hover']!).length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        /Licht thema: de zijbalk, de koptekst en knoppen voor de organisatie Acme, met de accentkleur #[0-9a-f]{6}\./,
      ),
    ).toBeInTheDocument();
  });

  it('renders its frame before the shared code has loaded and fills in afterwards', async () => {
    // A fresh module registry would be needed to see the very first load; what is promised is that
    // a mounted preview ends up complete once the tools are there.
    await mount();
    await waitFor(() => {
      expect(document.querySelectorAll('[data-preview-theme]')).toHaveLength(2);
    });
    await act(async () => {
      await loadBrandingTools();
    });
  });
});

describe('it reuses the shell components', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', 'src', 'features', 'branding', 'LivePreview.tsx'),
    'utf8',
  );
  it('takes its logo choice from the shell mark and its buttons from the design system', () => {
    expect(source).toMatch(/from '\.\.\/\.\.\/components\/shell\/OrgMark'/);
    expect(source).toMatch(/OrgMarkView/);
    expect(source).toMatch(/from '\.\.\/\.\.\/components\/ui\/button'/);
  });
});
