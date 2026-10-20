//
// THE DASHBOARD (FR-A-130, FR-D-808, PD-19; US-5.5; T-A-169).
//
// Four counter cards (users, groups, distribution lists, mail contacts). A signed-in actor gets the numbers of
// `GET /api/v1/dashboard`; a card is a skeleton while they load, "could not be loaded" when they fail, "not
// available for your role" for a kind the actor may not read, "N+" when the count stopped at its bound.
// An actor without a user session (the setup actor; an anonymous visitor never reaches the page) gets the honest empty state ("no tenant connected yet") and no number.
import { createTranslator } from '@m365portal/shared/i18n';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CounterCard } from '../src/components/pages/CounterCard';
import { Dashboard } from '../src/components/pages/Dashboard';
import { LanguageProvider, createLanguageController } from '../src/lib/locale';
import { createStorage } from '../src/lib/storage';
import { sampleBranding, sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
import { createMockApi, json } from './helpers/mock-api';
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
    expect(
      within(card).getByText(en.t('dashboard.card.loading', { name: 'Users' })),
    ).toBeInTheDocument();
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

  it('says "not available for your role" for a denied kind, and shows no number', () => {
    withLanguage(<CounterCard name="Users" state="denied" />);

    const card = screen.getByRole('group', { name: 'Users' });
    expect(card).toHaveTextContent(en.t('dashboard.card.denied'));
    expect(card.textContent).not.toMatch(/\d/);
  });

  it('shows "N+" for a count that stopped at its bound', () => {
    withLanguage(<CounterCard name="Users" state="data" value={1000} capped />);

    expect(screen.getByRole('group', { name: 'Users' })).toHaveTextContent('1,000+');
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
    expect(
      within(region)
        .getAllByRole('group')
        .map((card) => card.querySelector('h2')?.textContent),
    ).toEqual([
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

    expect(
      screen.getByRole('heading', { level: 1, name: en.t('dashboard.title') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: en.t('dashboard.empty.title') }),
    ).toBeInTheDocument();
    expect(screen.getByText(en.t('dashboard.empty.description'))).toBeInTheDocument();
  });

  it('never shows a number while loading, when empty or on error', () => {
    for (const state of ['loading', 'empty', 'error'] as const) {
      const view = withLanguage(<Dashboard state={state} />);
      const region = screen.getByRole('region', { name: en.t('dashboard.cards') });
      expect(region.textContent, state).not.toMatch(/\d/);
      view.unmount();
    }
  });

  it('claims "no tenant connected" only in the empty state', () => {
    for (const state of ['loading', 'error'] as const) {
      const view = withLanguage(<Dashboard state={state} />);
      expect(screen.queryByText(en.t('dashboard.empty.title'))).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('shows each counter of the response in its own state', () => {
    withLanguage(
      <Dashboard
        state="data"
        counters={{
          users: { state: 'ok', count: 1234, capped: false },
          groups: { state: 'ok', count: 1000, capped: true },
          distributionLists: { state: 'denied' },
          contacts: { state: 'unavailable' },
        }}
      />,
    );

    const card = (name: string) => screen.getByRole('group', { name });
    expect(card(en.t('dashboard.card.users'))).toHaveTextContent('1,234');
    expect(card(en.t('dashboard.card.groups'))).toHaveTextContent('1,000+');
    expect(card(en.t('dashboard.card.distributionLists'))).toHaveTextContent(
      en.t('dashboard.card.denied'),
    );
    expect(card(en.t('dashboard.card.contacts'))).toHaveTextContent(en.t('dashboard.card.error'));
    expect(screen.queryByText(en.t('dashboard.empty.title'))).not.toBeInTheDocument();
  });

  it('is written in Dutch when the page is Dutch', () => {
    withLanguage(<Dashboard state="empty" />, 'nl');

    expect(
      screen.getByRole('heading', { level: 2, name: nl.t('dashboard.empty.title') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: nl.t('dashboard.card.distributionLists') }),
    ).toBeInTheDocument();
  });
});

describe('the Dashboard route', () => {
  const counters = {
    users: { state: 'ok', count: 42, capped: false },
    groups: { state: 'ok', count: 7, capped: false },
    distributionLists: { state: 'denied' },
    contacts: { state: 'ok', count: 1000, capped: true },
  };

  it('shows the counters of a signed-in actor, from GET /api/v1/dashboard', async () => {
    const mock = createMockApi({ 'GET /api/v1/dashboard': () => json(200, counters) });
    await renderApp({
      me: sampleSignedInMe(),
      branding: sampleBranding('Acme'),
      fetch: mock.fetch,
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('dashboard.title') }),
    ).toBeInTheDocument();
    // The numbers come from a chunk of their own and the request: the first read may take a moment.
    await waitFor(
      () => {
        // Re-read the region: the lazy chunk replaces the skeletons with a tree of its own.
        expect(
          screen
            .getByRole('region', { name: en.t('dashboard.cards') })
            .querySelector('[data-state="data"]'),
        ).not.toBeNull();
      },
      { timeout: 4000 },
    );
    expect(screen.getByRole('group', { name: en.t('dashboard.card.users') })).toHaveTextContent(
      '42',
    );
    expect(screen.getByRole('group', { name: en.t('dashboard.card.contacts') })).toHaveTextContent(
      '1,000+',
    );
    expect(
      screen.getByRole('group', { name: en.t('dashboard.card.distributionLists') }),
    ).toHaveTextContent(en.t('dashboard.card.denied'));
    expect(screen.queryByText(en.t('dashboard.empty.title'))).not.toBeInTheDocument();
    expect(document.title).toBe(`${en.t('nav.dashboard')} - Acme`);
    expect(mock.callsTo('GET /api/v1/dashboard')).toHaveLength(1);
  });

  it('says "could not be loaded" on every card when the request fails, and claims no tenant state', async () => {
    const mock = createMockApi({
      'GET /api/v1/dashboard': () => json(500, { code: 'internal_error' }),
    });
    await renderApp({ me: sampleSignedInMe(), fetch: mock.fetch });

    await screen.findByRole('region', { name: en.t('dashboard.cards') });
    await waitFor(
      () => {
        expect(
          screen
            .getByRole('region', { name: en.t('dashboard.cards') })
            .querySelectorAll('[data-state="error"]'),
        ).toHaveLength(4);
      },
      { timeout: 4000 },
    );
    expect(screen.queryByText(en.t('dashboard.empty.title'))).not.toBeInTheDocument();
  });

  it('shows the empty state to an actor with no user session (the setup actor), asks for nothing and shows no number', async () => {
    const mock = createMockApi();
    await renderApp({
      me: sampleMe({ kind: 'setup' }),
      branding: sampleBranding('Acme'),
      fetch: mock.fetch,
    });

    const region = await screen.findByRole('region', { name: en.t('dashboard.cards') });
    expect(within(region).getAllByRole('group')).toHaveLength(4);
    expect(region.textContent).not.toMatch(/\d/);
    expect(
      screen.getByRole('heading', { level: 2, name: en.t('dashboard.empty.title') }),
    ).toBeInTheDocument();
    expect(mock.calls).toEqual([]);
  });
});
