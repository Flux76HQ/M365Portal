//
// THE DASHBOARD (FR-A-130, PD-19; US-5.5; T-A-169).
//
// Four counter cards (users, groups, distribution lists, mail contacts). Phase A has no tenant and no
// dashboard endpoint, so a card is a skeleton while `me` is pending and then an honest empty state:
// "no tenant connected yet". A number is never invented, so no numeric text is ever shown in Phase A.
import { createTranslator } from '@m365portal/shared/i18n';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CounterCard } from '../src/components/pages/CounterCard';
import { Dashboard } from '../src/components/pages/Dashboard';
import { LanguageProvider, createLanguageController } from '../src/lib/locale';
import { createStorage } from '../src/lib/storage';
import { sampleBranding, sampleMe } from './helpers/boot-fixtures';
import { renderApp } from './helpers/render-shell';
import type { ReactNode } from 'react';

const en = createTranslator('en');
const nl = createTranslator('nl');

function withLanguage(node: ReactNode, language: 'en' | 'nl' = 'en') {
  const controller = createLanguageController({
    storage: createStorage(null),
    languages: [language],
    root: document.createElement('html'),
  });
  return render(<LanguageProvider controller={controller}>{node}</LanguageProvider>);
}

describe('CounterCard', () => {
  it('shows a skeleton and a polite loading text while loading', () => {
    withLanguage(<CounterCard name="Users" state="loading" />);

    const card = screen.getByRole('group', { name: 'Users' });
    expect(card).toHaveAttribute('aria-busy', 'true');
    expect(within(card).getByText(en.t('dashboard.card.loading', { name: 'Users' }))).toBeInTheDocument();
    expect(card.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it('says "not connected yet" when empty, and shows no number', () => {
    withLanguage(<CounterCard name="Users" state="empty" />);

    const card = screen.getByRole('group', { name: 'Users' });
    expect(card).toHaveTextContent(en.t('dashboard.card.empty'));
    expect(card).not.toHaveAttribute('aria-busy', 'true');
    expect(card.textContent).not.toMatch(/\d/);
  });

  it('says it could not be loaded on error, and shows no number', () => {
    withLanguage(<CounterCard name="Users" state="error" />);

    const card = screen.getByRole('group', { name: 'Users' });
    expect(card).toHaveTextContent(en.t('dashboard.card.error'));
    expect(card.textContent).not.toMatch(/\d/);
  });

  it('formats the number for the language when it has data', () => {
    withLanguage(<CounterCard name="Gebruikers" state="data" value={1234} />, 'nl');

    expect(screen.getByRole('group', { name: 'Gebruikers' })).toHaveTextContent('1.234');
  });

  it('refuses a data state without a value at the type level', () => {
    // @ts-expect-error the data state needs the number it shows
    withLanguage(<CounterCard name="Users" state="data" />);
  });
});

describe('Dashboard', () => {
  it('shows the four counters in the order users, groups, distribution lists, mail contacts', () => {
    withLanguage(<Dashboard state="empty" />);

    const region = screen.getByRole('region', { name: en.t('dashboard.cards') });
    expect(within(region).getAllByRole('group').map((card) => card.getAttribute('aria-label') ?? card.querySelector('h2')?.textContent)).toEqual([
      en.t('dashboard.card.users'),
      en.t('dashboard.card.groups'),
      en.t('dashboard.card.distributionLists'),
      en.t('dashboard.card.contacts'),
    ]);
  });

  it('shows skeletons while loading and no empty-state claim yet', () => {
    withLanguage(<Dashboard state="loading" />);

    const region = screen.getByRole('region', { name: en.t('dashboard.cards') });
    expect(region.querySelectorAll('[data-slot="skeleton"]').length).toBe(4);
    expect(screen.queryByText(en.t('dashboard.empty.title'))).not.toBeInTheDocument();
  });

  it('shows the honest empty state once loaded', () => {
    withLanguage(<Dashboard state="empty" />);

    expect(screen.getByRole('heading', { level: 1, name: en.t('dashboard.title') })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: en.t('dashboard.empty.title') })).toBeInTheDocument();
    expect(screen.getByText(en.t('dashboard.empty.description'))).toBeInTheDocument();
  });

  it('never shows a number in any state of Phase A', () => {
    for (const state of ['loading', 'empty', 'error'] as const) {
      const view = withLanguage(<Dashboard state={state} />);
      const region = screen.getByRole('region', { name: en.t('dashboard.cards') });
      expect(region.textContent, state).not.toMatch(/\d/);
      view.unmount();
    }
  });

  it('is written in Dutch when the page is Dutch', () => {
    withLanguage(<Dashboard state="empty" />, 'nl');

    expect(screen.getByRole('heading', { level: 2, name: nl.t('dashboard.empty.title') })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: nl.t('dashboard.card.distributionLists') })).toBeInTheDocument();
  });
});

describe('the Dashboard route', () => {
  it('is the page at "/", with the four counters and the empty state, and no number', async () => {
    await renderApp({ me: sampleMe({ preview: true }), branding: sampleBranding('Acme') });

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('dashboard.title') }),
    ).toBeInTheDocument();
    const region = screen.getByRole('region', { name: en.t('dashboard.cards') });
    expect(within(region).getAllByRole('group')).toHaveLength(4);
    expect(region.textContent).not.toMatch(/\d/);
    expect(screen.getByRole('heading', { level: 2, name: en.t('dashboard.empty.title') })).toBeInTheDocument();
    expect(document.title).toBe(`${en.t('nav.dashboard')} - Acme`);
  });
});
