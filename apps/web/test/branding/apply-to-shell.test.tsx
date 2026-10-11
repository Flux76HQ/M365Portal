// Saved branding applied to the running shell (T-A-215; FR-A-132, FR-A-095 client part; US-2.1): after a
// save, reset or import the sidebar mark, `document.title` and the effective accent variables on `:root`
// follow at once, written through the CSSOM and equal to what the server renders for the same branding.
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { OrgMarkView } from '../../src/components/shell/OrgMark';
import { createTranslator } from '@m365portal/shared/i18n';
import { ACCENT_VARIABLES, renderTokenCss } from '@m365portal/shared/tokens';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBrandingToDocument } from '../../src/features/branding/apply-to-shell';
import { loadBrandingTools } from '../../src/features/branding/tools';
import { getThemeController } from '../../src/lib/theme';
import {
  escapeForScript,
  installBootBlock,
  sampleBranding,
  sampleMe,
} from '../helpers/boot-fixtures';
import {
  HASH_A,
  assetRef,
  brandingWith,
  renderAppearance,
  watchStyleStrings,
} from './form-helpers';

const en = createTranslator('en');
const root = document.documentElement;

const rootVariable = (name: string): string => root.style.getPropertyValue(name);

/** The `--accent`-family values the server writes into the `:root` or the dark block of its <style>. */
function serverValues(accent: string, theme: 'light' | 'dark'): Record<string, string> {
  const css = renderTokenCss({ accent: deriveAccentTokens(accent) });
  const selector = theme === 'light' ? ':root {' : ':root[data-theme="dark"] {';
  const start = css.indexOf(selector);
  const block = css.slice(start, css.indexOf('}', start));
  const values: Record<string, string> = {};
  for (const variable of Object.values(ACCENT_VARIABLES)) {
    const match = new RegExp(`${variable}: (#[0-9a-f]{6});`).exec(block);
    if (match?.[1] === undefined) throw new Error(`${variable} not in the ${theme} block`);
    values[variable] = match[1];
  }
  return values;
}

function expectRootAccent(accent: string, theme: 'light' | 'dark'): void {
  for (const [variable, value] of Object.entries(serverValues(accent, theme))) {
    expect(rootVariable(variable)).toBe(value);
  }
}

function clearRoot(): void {
  for (const variable of Object.values(ACCENT_VARIABLES)) root.style.removeProperty(variable);
  document.getElementById('m365-boot')?.remove();
  document.head.querySelectorAll('[data-test-head]').forEach((element) => {
    element.remove();
  });
}

beforeEach(async () => {
  await loadBrandingTools();
  clearRoot();
  getThemeController().setChoice('light');
});
afterEach(() => {
  clearRoot();
  getThemeController().setChoice('system');
  vi.restoreAllMocks();
});

describe('after a save', () => {
  it('updates the sidebar mark, the document title and the accent variables at once', async () => {
    const watch = watchStyleStrings(vi);
    const view = await renderAppearance();
    const name = await screen.findByRole('textbox', { name: /Organisation name/ });
    const sidebar = await screen.findByRole('complementary');
    expect(within(sidebar).getByText('Acme')).toBeInTheDocument();

    await view.user.clear(name);
    await view.user.type(name, 'Contoso');
    const accent = screen.getByRole('textbox', { name: en.t('accent.hexLabel') });
    await view.user.clear(accent);
    await view.user.type(accent, '#cc3300');
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));
    await screen.findByText(en.t('appearance.saved'));

    await waitFor(() => {
      expect(within(sidebar).getByText('Contoso')).toBeInTheDocument();
    });
    expect(document.title).toBe(`${en.t('nav.appearance')} - Contoso`);
    await waitFor(() => {
      expectRootAccent('#cc3300', 'light');
    });
    // Never a style string (plan 8.1): the CSSOM did it.
    expect(watch.violations).toEqual([]);
    expect(watch.cssomProperties).toContain('--accent');
  });

  it('writes the values of the theme that is showing, and the other ones when the theme changes', async () => {
    const view = await renderAppearance();
    act(() => {
      view.queryClient.setQueryData(['branding'], brandingWith({ revision: 2, accent: '#cc3300' }));
    });
    await waitFor(() => {
      expectRootAccent('#cc3300', 'light');
    });
    act(() => {
      getThemeController().setChoice('dark');
    });
    await waitFor(() => {
      expectRootAccent('#cc3300', 'dark');
    });
  });
});

describe('after a reset', () => {
  it('returns the mark, the title and the accent to the defaults', async () => {
    const view = await renderAppearance({
      branding: brandingWith({ revision: 3, orgName: 'Contoso', accent: '#cc3300' }),
    });
    const sidebar = await screen.findByRole('complementary');
    await view.user.click(
      await screen.findByRole('button', { name: en.t('appearance.reset.button') }),
    );
    await view.user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: en.t('appearance.reset.confirm'),
      }),
    );
    await screen.findByText(en.t('appearance.reset.done'));
    await waitFor(() => {
      expect(within(sidebar).getByText('M365Portal')).toBeInTheDocument();
    });
    expect(document.title).toBe(`${en.t('nav.appearance')} - M365Portal`);
    await waitFor(() => {
      expectRootAccent(sampleBranding().accent, 'light');
    });
  });
});

describe('after an import', () => {
  it('takes the imported name and accent over', async () => {
    const view = await renderAppearance();
    view.server.importAnswer = (dryRun) => ({
      dryRun,
      applied: !dryRun,
      orgName: 'Imported Org',
      accent: '#336699',
      images: { logoLight: null, logoDark: null, compact: null },
      branding: dryRun ? null : brandingWith({ orgName: 'Imported Org', accent: '#336699' }),
    });
    const input = document.querySelector<HTMLInputElement>('input[data-slot="import-file"]')!;
    const file = new File(['{}'], 'appearance.json', { type: 'application/json' });
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await view.user.click(
      await screen.findByRole('button', { name: en.t('appearance.import.apply') }),
    );
    const sidebar = await screen.findByRole('complementary');
    await waitFor(() => {
      expect(within(sidebar).getByText('Imported Org')).toBeInTheDocument();
    });
    await waitFor(() => {
      expectRootAccent('#336699', 'light');
    });
  });
});

describe('what the server already drew', () => {
  it('writes nothing for the branding that came with the page, and does not load the token code for it', async () => {
    const branding = brandingWith({ accent: '#cc3300' });
    installBootBlock(
      document,
      escapeForScript(
        JSON.stringify({ me: sampleMe({ permissions: ['settings:branding'] }), branding }),
      ),
    );
    const view = await renderAppearance({ branding });
    await screen.findByRole('complementary');
    expect(rootVariable('--accent')).toBe('');

    act(() => {
      view.queryClient.setQueryData(['branding'], brandingWith({ revision: 2, accent: '#336699' }));
    });
    await waitFor(() => {
      expectRootAccent('#336699', 'light');
    });
  });
});

describe('the document', () => {
  function head(): void {
    for (const html of [
      '<meta name="theme-color" content="#000000">',
      '<link rel="icon" type="image/png" sizes="32x32" href="/branding/old32.png">',
      '<link rel="apple-touch-icon" sizes="180x180" href="/branding/old180.png">',
    ]) {
      const holder = document.createElement('div');
      holder.innerHTML = html;
      const element = holder.firstElementChild!;
      element.setAttribute('data-test-head', '');
      document.head.append(element);
    }
  }

  it('gets the new theme colour and icon links', () => {
    head();
    const branding = brandingWith({ revision: 2, accent: '#cc3300' });
    applyBrandingToDocument(document, branding, 'light', ACCENT_VARIABLES);
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      branding.tokens.light.accent,
    );
    expect(document.querySelector('link[rel="icon"]')).toHaveAttribute(
      'href',
      branding.icons.favicon32.url,
    );
    expect(document.querySelector('link[rel="apple-touch-icon"]')).toHaveAttribute(
      'href',
      branding.icons.appleTouch180.url,
    );
  });

  it('does not fail on a page without those elements (degraded shell)', () => {
    expect(() => {
      applyBrandingToDocument(document, brandingWith(), 'dark', ACCENT_VARIABLES);
    }).not.toThrow();
  });
});

describe('OrgMarkView, the mark the shell and the preview share', () => {
  const logos = { light: assetRef(HASH_A), dark: assetRef('b'.repeat(64)), compact: null };
  const draft = { orgName: 'Draft Org', logos, monogram: brandingWith().monogram };

  it('draws for the theme it is given, whatever theme the page is in', () => {
    getThemeController().setChoice('light');
    const { container } = render(<OrgMarkView branding={draft} theme="dark" variant="full" />);
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      `/branding/${'b'.repeat(64)}.png`,
    );
    expect(screen.getByText('Draft Org')).toHaveAttribute('title', 'Draft Org');
  });

  it('draws the monogram tile without logos and the product name without branding', () => {
    const { container, rerender } = render(
      <OrgMarkView
        branding={{ ...draft, logos: { light: null, dark: null, compact: null } }}
        theme="light"
        variant="compact"
        showName
      />,
    );
    expect(container.querySelector('[data-slot="monogram-tile"]')).not.toBeNull();
    rerender(<OrgMarkView branding={undefined} theme="light" variant="full" />);
    expect(container.querySelector('[data-slot="monogram-tile"]')).toBeNull();
    expect(screen.getByText('M365Portal')).toBeInTheDocument();
  });
});
