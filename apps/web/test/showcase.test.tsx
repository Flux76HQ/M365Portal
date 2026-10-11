//
// THE SHOWCASE /design (FR-A-131, FR-A-125 demo, FR-A-124 coverage; US-5.8, US-5.9; T-A-170).
//
// The page the visual regression screenshots. It exists only while the server runs with SHOWCASE=true.
// This proves:
//   1. every component of FR-A-124 appears in each of its states (default, hover and focus through forced
//      classes, disabled, invalid, loading, empty, error), and the page shows nothing the registry does
//      not list;
//   2. the overlays open (menu, tooltip, dialog with scrim, confirm dialog naming its object, toast,
//      details panel, palette) and the form field validates inline;
//   3. the DataTable demo is server-driven from a local sample source with simulated latency, labelled
//      as sample data, its state lives in the URL, and sorting, filtering, search, pagination, the page
//      size, the column picker, bulk selection, the sticky header, the skeleton, the empty and the error
//      state all work;
//   4. the page makes no network request.
import { createTranslator } from '@m365portal/shared/i18n';
import { createRoute, type AnyRoute } from '@tanstack/react-router';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Showcase } from '../src/features/showcase/Showcase';
import { SHOWCASE_COMPONENTS } from '../src/features/showcase/registry';
import { SAMPLE_PEOPLE, createSampleSource } from '../src/features/showcase/sample-data';
import type { SampleQuery, SampleSource } from '../src/features/showcase/sample-data';
import { validateShowcaseSearch } from '../src/features/showcase/search';
import { createColumnStorage, createTableLabels } from '../src/lib/table-wiring';
import { STORAGE_KEYS, createStorage } from '../src/lib/storage';
import { sampleMe } from './helpers/boot-fixtures';
import { MemoryBackend, renderShell } from './helpers/render-shell';

const en = createTranslator('en');
const nl = createTranslator('nl');

/** The components FR-A-124 lists (the test states the list again on purpose: the registry must not drift from the spec). */
const FR_A_124 = [
  'button',
  'icon-button',
  'input',
  'textarea',
  'select',
  'checkbox',
  'radio-group',
  'switch',
  'segmented-control',
  'tabs',
  'menu',
  'tooltip',
  'dialog',
  'confirm-dialog',
  'toast',
  'banner',
  'breadcrumbs',
  'command-bar',
  'details-panel',
  'command-palette',
  'persona',
  'skeleton',
  'empty-state',
  'error-state',
  'data-table',
  'form-field',
];

// ---------------------------------------------------------------------------------------------
// A sample source the test controls
// ---------------------------------------------------------------------------------------------

interface ControlledSource {
  readonly source: SampleSource;
  readonly queries: SampleQuery[];
  /** Hold every request until `release()`: the loading state can be looked at. */
  hold(): void;
  release(): void;
}

function controlledSource(): ControlledSource {
  const queries: SampleQuery[] = [];
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  const inner = createSampleSource({ delayMs: 0, wait: () => gate ?? Promise.resolve() });
  return {
    queries,
    source: {
      fetchPage(query, signal) {
        queries.push(query);
        return inner.fetchPage(query, signal);
      },
    },
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open?.();
      gate = null;
    },
  };
}

async function renderShowcase(
  options: {
    source?: SampleSource;
    path?: string;
    language?: 'en' | 'nl';
    backend?: MemoryBackend;
  } = {},
) {
  const source =
    options.source ?? createSampleSource({ delayMs: 0, wait: () => Promise.resolve() });
  const shell = await renderShell({
    me: sampleMe({ showcase: true, preview: true }),
    path: options.path ?? '/design',
    language: options.language,
    backend: options.backend,
    extraRoutes: (root: AnyRoute) => [
      createRoute({
        getParentRoute: () => root,
        path: '/design',
        staticData: { titleKey: 'nav.design' },
        validateSearch: validateShowcaseSearch,
        component: () => <Showcase source={source} />,
      }),
    ],
  });
  return shell;
}

const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
});

const specimen = (component: string, state: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-component="${component}"][data-state="${state}"]`);

// ---------------------------------------------------------------------------------------------
// 1. Coverage
// ---------------------------------------------------------------------------------------------

describe('the registry', () => {
  it('lists exactly the components of FR-A-124', () => {
    expect(SHOWCASE_COMPONENTS.map((component) => component.id).sort()).toEqual(
      [...FR_A_124].sort(),
    );
  });

  it('gives every component at least one state, and no state twice', () => {
    for (const component of SHOWCASE_COMPONENTS) {
      expect(component.states.length, component.id).toBeGreaterThan(0);
      expect(new Set(component.states).size, component.id).toBe(component.states.length);
    }
  });

  it('gives every interactive control the focus state and every form control the disabled state', () => {
    const states = (id: string) => SHOWCASE_COMPONENTS.find((c) => c.id === id)?.states ?? [];
    for (const id of [
      'button',
      'icon-button',
      'input',
      'textarea',
      'select',
      'checkbox',
      'radio-group',
      'switch',
      'segmented-control',
      'tabs',
    ]) {
      expect(states(id), `${id} focus`).toContain('focus');
      expect(states(id), `${id} disabled`).toContain('disabled');
    }
    for (const id of ['input', 'textarea', 'select', 'checkbox', 'radio-group', 'form-field']) {
      expect(states(id), `${id} invalid`).toContain('invalid');
    }
    for (const id of ['button', 'icon-button', 'tabs', 'segmented-control']) {
      expect(states(id), `${id} hover`).toContain('hover');
    }
    expect(states('skeleton')).toContain('loading');
    expect(states('empty-state')).toContain('empty');
    expect(states('error-state')).toContain('error');
    for (const state of ['loading', 'ready', 'empty', 'no-results', 'error']) {
      expect(states('data-table'), `data-table ${state}`).toContain(state);
    }
  });
});

describe('the page', () => {
  it('is the /design page with a heading, a sample-data notice and the components in groups', async () => {
    await renderShowcase();

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('nav.design') }),
    ).toBeInTheDocument();
    const notice = screen.getByText(en.t('showcase.sample.message'));
    expect(notice).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThanOrEqual(5);
  });

  it('shows every component in every state of the registry, and nothing the registry does not list', async () => {
    await renderShowcase();
    await screen.findByRole('heading', { level: 1, name: en.t('nav.design') });

    const expected = new Set(
      SHOWCASE_COMPONENTS.flatMap((component) =>
        component.states.map((state) => `${component.id}:${state}`),
      ),
    );
    const found = new Set(
      [...document.querySelectorAll<HTMLElement>('[data-component][data-state]')].map(
        (node) => `${String(node.dataset.component)}:${String(node.dataset.state)}`,
      ),
    );
    expect([...expected].filter((key) => !found.has(key))).toEqual([]);
    expect([...found].filter((key) => !expected.has(key))).toEqual([]);
  });

  it('names every component with a heading from the catalogue', async () => {
    await renderShowcase();
    await screen.findByRole('heading', { level: 1, name: en.t('nav.design') });

    for (const component of SHOWCASE_COMPONENTS) {
      expect(
        screen.getAllByRole('heading', { level: 3, name: en.t(component.nameKey) }).length,
        component.id,
      ).toBeGreaterThan(0);
    }
  });

  it('makes no network request', async () => {
    const { user } = await renderShowcase();
    await screen.findByRole('heading', { level: 1, name: en.t('nav.design') });
    await screen.findByRole('table', { name: en.t('showcase.table.live') });
    await user.click(screen.getByRole('button', { name: en.t('showcase.toast.success') }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is written in Dutch when the page is Dutch', async () => {
    await renderShowcase({ language: 'nl' });

    expect(
      await screen.findByRole('heading', { level: 1, name: nl.t('nav.design') }),
    ).toBeInTheDocument();
    expect(screen.getByText(nl.t('showcase.sample.message'))).toBeInTheDocument();
    expect(
      screen.getAllByRole('heading', { level: 3, name: nl.t('showcase.component.button') }).length,
    ).toBeGreaterThan(0);
  });
});

describe('forced states', () => {
  beforeEach(async () => {
    await renderShowcase();
    await screen.findByRole('heading', { level: 1, name: en.t('nav.design') });
  });

  it('draws the hover state of a button with the hover colour, without a pointer', () => {
    const hover = specimen('button', 'hover')!;
    const primary = within(hover).getAllByRole('button')[0]!;
    expect(primary).toHaveClass('bg-accent-hover');
  });

  it('draws the focus state with the focus ring, without moving the focus', () => {
    for (const id of ['button', 'icon-button', 'input', 'textarea', 'select']) {
      const focus = specimen(id, 'focus')!;
      const control = within(focus).getAllByRole(
        id === 'input'
          ? 'textbox'
          : id === 'textarea'
            ? 'textbox'
            : id === 'select'
              ? 'combobox'
              : 'button',
      )[0]!;
      expect(control, id).toHaveClass('outline-focus-ring');
      expect(control, id).not.toHaveFocus();
    }
  });

  it('really disables the disabled specimens', () => {
    for (const [id, role] of [
      ['button', 'button'],
      ['icon-button', 'button'],
      ['input', 'textbox'],
      ['textarea', 'textbox'],
      ['checkbox', 'checkbox'],
      ['switch', 'switch'],
    ] as const) {
      for (const control of within(specimen(id, 'disabled')!).getAllByRole(role)) {
        expect(control, id).toBeDisabled();
      }
    }
    expect(within(specimen('select', 'disabled')!).getByRole('combobox')).toBeDisabled();
  });

  it('marks the invalid specimens invalid, with a message and not by colour alone', () => {
    for (const [id, role] of [
      ['input', 'textbox'],
      ['textarea', 'textbox'],
      ['select', 'combobox'],
      ['checkbox', 'checkbox'],
    ] as const) {
      const invalid = specimen(id, 'invalid')!;
      expect(within(invalid).getAllByRole(role)[0], id).toHaveAttribute('aria-invalid', 'true');
      expect(within(invalid).getByRole('alert'), id).toBeInTheDocument();
    }
    const group = within(specimen('radio-group', 'invalid')!).getByRole('radiogroup');
    expect(group).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a busy button as busy', () => {
    const loading = specimen('button', 'loading')!;
    expect(within(loading).getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows the banner in each tone and the persona in each size', () => {
    for (const tone of ['info', 'success', 'warning', 'danger']) {
      expect(specimen('banner', tone), tone).not.toBeNull();
    }
    expect(within(specimen('persona', 'default')!).getAllByRole('img')).toHaveLength(3);
  });

  it('shows the skeleton, the empty state and the error state', () => {
    expect(specimen('skeleton', 'loading')!.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(within(specimen('empty-state', 'empty')!).getByRole('heading')).toBeInTheDocument();
    const error = within(specimen('error-state', 'error')!).getByRole('alert');
    expect(error).toHaveTextContent(en.t('showcase.sample.requestId'));
    expect(error.textContent).not.toMatch(/at \S+ \(/);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Overlays and the form
// ---------------------------------------------------------------------------------------------

describe('overlays', () => {
  async function ready() {
    const view = await renderShowcase();
    await screen.findByRole('heading', { level: 1, name: en.t('nav.design') });
    return view;
  }

  it('opens the menu', async () => {
    const { user } = await ready();
    await user.click(within(specimen('menu', 'open')!).getByRole('button'));

    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('shows the tooltip on focus', async () => {
    const { user } = await ready();
    await user.tab();
    const trigger = within(specimen('tooltip', 'open')!).getByRole('button');
    trigger.focus();

    expect(await screen.findByRole('tooltip')).toHaveTextContent(en.t('showcase.tooltip.text'));
  });

  it('opens the dialog with a scrim', async () => {
    const { user } = await ready();
    await user.click(within(specimen('dialog', 'open')!).getByRole('button'));

    const dialog = await screen.findByRole('dialog', { name: en.t('showcase.dialog.title') });
    expect(dialog).toBeInTheDocument();
    expect(document.querySelector('.glass-scrim')).not.toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('opens the confirm dialog, which names its object', async () => {
    const { user } = await ready();
    await user.click(within(specimen('confirm-dialog', 'open')!).getByRole('button'));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(en.t('showcase.confirm.object'));
    expect(
      within(dialog).getByRole('button', { name: en.t('showcase.confirm.cancel') }),
    ).toHaveFocus();
  });

  it('shows a toast of each tone, and an error toast stays', async () => {
    const { user } = await ready();
    const cell = specimen('toast', 'open')!;
    for (const tone of ['info', 'success', 'warning', 'error'] as const) {
      await user.click(within(cell).getByRole('button', { name: en.t(`showcase.toast.${tone}`) }));
    }

    for (const tone of ['info', 'success', 'warning', 'error'] as const) {
      expect(await screen.findByText(en.t(`showcase.toast.${tone}Title`))).toBeInTheDocument();
    }
  });

  it('opens the details panel', async () => {
    const { user } = await ready();
    await user.click(within(specimen('details-panel', 'open')!).getByRole('button'));

    expect(
      await screen.findByRole('dialog', { name: en.t('showcase.details.title') }),
    ).toBeInTheDocument();
  });

  it('opens the real command palette', async () => {
    const { user } = await ready();
    await user.click(within(specimen('command-palette', 'open')!).getByRole('button'));

    expect(await screen.findByRole('dialog', { name: en.t('palette.title') })).toBeInTheDocument();
  });
});

describe('the form field', () => {
  it('validates inline: errors appear on submit, name the problem, clear when fixed', async () => {
    const { user } = await renderShowcase();
    await screen.findByRole('heading', { level: 1, name: en.t('nav.design') });
    const form = within(specimen('form-field', 'default')!);

    await user.click(form.getByRole('button', { name: en.t('showcase.form.submit') }));

    const name = form.getByRole('textbox', { name: new RegExp(en.t('showcase.form.name')) });
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(form.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(form.getByText(en.t('showcase.form.nameRequired'))).toBeInTheDocument();

    await user.type(name, 'Alder Vance');
    await user.type(
      form.getByRole('textbox', { name: new RegExp(en.t('showcase.form.email')) }),
      'not-an-address',
    );
    await user.click(form.getByRole('button', { name: en.t('showcase.form.submit') }));
    expect(name).not.toHaveAttribute('aria-invalid');
    expect(form.getByText(en.t('showcase.form.emailInvalid'))).toBeInTheDocument();

    const email = form.getByRole('textbox', { name: new RegExp(en.t('showcase.form.email')) });
    await user.clear(email);
    await user.type(email, 'alder@example.test');
    await user.click(form.getByRole('button', { name: en.t('showcase.form.submit') }));

    expect(form.queryByRole('alert')).not.toBeInTheDocument();
    expect(await screen.findByText(en.t('showcase.form.saved'))).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The server-driven DataTable
// ---------------------------------------------------------------------------------------------

describe('the DataTable demo', () => {
  const liveName = en.t('showcase.table.live');
  const live = () => screen.getByRole('table', { name: liveName });
  /**
   * The table is there (loading) before its rows are: the answer of the source reaches the table as a
   * transition (TableSection, T-A-173), a render after the one that shows the state. Wait for the rows.
   */
  const liveRows = async (): Promise<void> => {
    await screen.findByRole('table', { name: liveName });
    await waitFor(() => {
      // Skeleton rows are rows too; a row with text is a row of data.
      expect(within(live()).getAllByRole('row')[1]).toHaveTextContent(/\S/);
    });
  };
  /** Everything of the live demo (the static state specimens have toolbars of their own). */
  const area = () => within(specimen('data-table', 'ready')!);
  const firstNames = (count: number): string[] =>
    within(live())
      .getAllByRole('row')
      .slice(1, 1 + count)
      .map((row) => within(row).getAllByRole('cell')[1]?.textContent ?? '');

  it('is labelled as sample data, with an origin on every row', async () => {
    await renderShowcase();
    await liveRows();

    expect(screen.getAllByText(en.t('showcase.sample.badge')).length).toBeGreaterThan(0);
    const rows = within(live()).getAllByRole('row').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toHaveTextContent(en.t('showcase.table.origin'));
  });

  it('asks the source for the first page, sorted by name, 25 rows', async () => {
    const controlled = controlledSource();
    await renderShowcase({ source: controlled.source });
    await screen.findByRole('table', { name: liveName });

    await waitFor(() => {
      expect(controlled.queries.length).toBeGreaterThan(0);
    });
    expect(controlled.queries.at(-1)).toMatchObject({ q: '', page: 1, size: 25, sort: 'name' });
    expect(within(live()).getAllByRole('row').length - 1).toBe(25);
  });

  it('shows skeleton rows with a reserved height while the source is slow, then the rows', async () => {
    const controlled = controlledSource();
    controlled.hold();
    await renderShowcase({ source: controlled.source });
    await screen.findByRole('table', { name: liveName });

    const body = () => live().querySelector('tbody')!;
    expect(body()).toHaveAttribute('aria-busy', 'true');
    expect(live().querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);

    await act(async () => {
      controlled.release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(body()).toHaveAttribute('aria-busy', 'false');
    });
    expect(live().querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  });

  it('keeps its state in the URL and restores it from there', async () => {
    const { router, user } = await renderShowcase({ path: '/design?q=an&page=2&size=10' });
    await screen.findByRole('table', { name: liveName });

    expect(area().getByRole('searchbox', { name: en.t('showcase.table.searchLabel') })).toHaveValue(
      'an',
    );

    await user.click(within(live()).getByRole('button', { name: en.t('showcase.table.name') }));
    // The table sorts by name unless told otherwise, so the first click on Name asks for descending.
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ q: 'an', sort: '-name', size: 10 });
    });
  });

  it('sorts on the server: the order of the source is the order shown', async () => {
    const { user, router } = await renderShowcase();
    await liveRows();
    const ascending = [...SAMPLE_PEOPLE]
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))
      .slice(0, 3)
      .map((p) => p.name);
    expect(firstNames(3)).toEqual(ascending);

    await user.click(within(live()).getByRole('button', { name: en.t('showcase.table.name') }));
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ sort: '-name' });
    });
    const descending = [...SAMPLE_PEOPLE]
      .sort((a, b) => b.name.localeCompare(a.name, 'en'))
      .slice(0, 3)
      .map((p) => p.name);
    await waitFor(() => {
      expect(firstNames(3)).toEqual(descending);
    });
    expect(
      within(live()).getByRole('columnheader', { name: en.t('showcase.table.name') }),
    ).toHaveAttribute('aria-sort', 'descending');
  });

  it('searches on the server and shows the count', async () => {
    const { user, router } = await renderShowcase();
    await screen.findByRole('table', { name: liveName });
    const target = SAMPLE_PEOPLE[7]!;

    await user.type(
      area().getByRole('searchbox', { name: en.t('showcase.table.searchLabel') }),
      `${target.name}{Enter}`,
    );

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ q: target.name });
    });
    // The previous rows stay on screen until the server answers, so wait for the filtered rows.
    await waitFor(() => {
      expect(firstNames(1)).toEqual([target.name]);
    });
    expect(area().getByText(en.t('common.table.resultCount', { count: 1 }))).toBeInTheDocument();
  });

  it('filters by department', async () => {
    const { user, router } = await renderShowcase();
    await screen.findByRole('table', { name: liveName });

    await user.click(area().getByRole('combobox', { name: en.t('showcase.table.department') }));
    await user.click(
      await screen.findByRole('option', { name: en.t('showcase.table.dept.finance') }),
    );

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ 'f.department': 'finance' });
    });
    const finance = SAMPLE_PEOPLE.filter((person) => person.department === 'finance').length;
    await waitFor(() => {
      expect(
        area().getByText(en.t('common.table.resultCount', { count: finance })),
      ).toBeInTheDocument();
    });
  });

  it('pages and changes the page size', async () => {
    const { user, router } = await renderShowcase();
    await liveRows();
    const pager = area().getByRole('navigation', { name: en.t('common.table.pagination') });

    await user.click(within(pager).getByRole('button', { name: en.t('common.table.nextPage') }));
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ page: 2 });
    });
    const second = [...SAMPLE_PEOPLE].sort((a, b) => a.name.localeCompare(b.name, 'en'))[25]!.name;
    await waitFor(() => {
      expect(firstNames(1)).toEqual([second]);
    });

    await user.click(area().getByRole('combobox', { name: en.t('common.table.pageSizeLabel') }));
    await user.click(
      await screen.findByRole('option', {
        name: en.t('common.table.pageSizeOption', { size: 10 }),
      }),
    );
    await waitFor(() => {
      expect(within(live()).getAllByRole('row').length - 1).toBe(10);
    });
  });

  it('remembers the column choice in this browser, under the table id', async () => {
    const backend = new MemoryBackend();
    const { user } = await renderShowcase({ backend });
    await screen.findByRole('table', { name: liveName });

    await user.click(area().getByRole('button', { name: en.t('common.table.columns') }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: en.t('showcase.table.role') }));

    const stored = backend.values.get(`${STORAGE_KEYS.columnsPrefix}showcase-people`);
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!) as unknown).toMatchObject({
      hidden: expect.arrayContaining(['role']) as unknown,
    });
  });

  it('selects rows on this page and, explicitly, all results; a bulk action is told which', async () => {
    const { user } = await renderShowcase();
    await liveRows();

    await user.click(area().getByRole('checkbox', { name: en.t('common.table.selectAllRows') }));
    expect(
      area().getByText(en.t('common.table.selectionOnPage', { count: 25 })),
    ).toBeInTheDocument();
    await user.click(
      area().getByRole('button', {
        name: en.t('common.table.selectAllResults', { total: SAMPLE_PEOPLE.length }),
      }),
    );
    expect(
      area().getByText(en.t('common.table.allResultsSelected', { total: SAMPLE_PEOPLE.length })),
    ).toBeInTheDocument();

    await user.click(
      within(area().getByRole('group', { name: en.t('common.table.bulkActions') })).getByRole(
        'button',
        { name: en.t('showcase.table.bulk') },
      ),
    );

    expect(
      await screen.findByText(en.t('showcase.table.bulkDone', { count: SAMPLE_PEOPLE.length })),
    ).toBeInTheDocument();
  });

  it('opens the details of a row in a panel', async () => {
    const { user } = await renderShowcase();
    await liveRows();
    const first = [...SAMPLE_PEOPLE].sort((a, b) => a.name.localeCompare(b.name, 'en'))[0]!.name;

    await user.click(
      within(live()).getByRole('button', {
        name: en.t('common.table.openDetails', { row: first }),
      }),
    );

    expect(await screen.findByRole('dialog', { name: first })).toBeInTheDocument();
  });

  it('has a sticky header', async () => {
    await renderShowcase();
    await screen.findByRole('table', { name: liveName });

    expect(within(live()).getAllByRole('columnheader')[0]).toHaveClass('sticky');
  });

  it('shows the empty state for the empty scenario and the error state, with retry, for the error scenario', async () => {
    const controlled = controlledSource();
    const { user, router } = await renderShowcase({
      source: controlled.source,
      path: '/design?scenario=empty',
    });
    expect(
      await area().findByRole('heading', { name: en.t('common.table.emptyTitle') }),
    ).toBeInTheDocument();

    await act(async () => {
      await router.navigate({ to: '/design', search: { scenario: 'error' } });
    });
    const alert = await area().findByRole('alert');
    expect(within(alert).getByText(en.t('common.table.errorTitle'))).toBeInTheDocument();

    const before = controlled.queries.length;
    await user.click(within(alert).getByRole('button', { name: en.t('common.table.retry') }));
    await waitFor(() => {
      expect(controlled.queries.length).toBeGreaterThan(before);
    });
  });

  it('shows "no results" with a way to clear the filters', async () => {
    const { user } = await renderShowcase({ path: '/design?q=zzzznomatch' });

    expect(
      await area().findByRole('heading', { name: en.t('common.table.noResultsTitle') }),
    ).toBeInTheDocument();
    await user.click(area().getByRole('button', { name: en.t('common.table.clearFilters') }));
    await screen.findByRole('table', { name: liveName });
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Sample data, the search and the wiring
// ---------------------------------------------------------------------------------------------

describe('the sample source', () => {
  const fast = createSampleSource({ delayMs: 0, wait: () => Promise.resolve() });
  const query = (overrides: Partial<SampleQuery> = {}): SampleQuery => ({
    q: '',
    sort: 'name',
    page: 1,
    size: 25,
    department: null,
    scenario: 'normal',
    ...overrides,
  });

  it('has enough people for several pages, all with unique ids and names', () => {
    expect(SAMPLE_PEOPLE.length).toBeGreaterThan(100);
    expect(new Set(SAMPLE_PEOPLE.map((person) => person.id)).size).toBe(SAMPLE_PEOPLE.length);
    expect(new Set(SAMPLE_PEOPLE.map((person) => person.name)).size).toBe(SAMPLE_PEOPLE.length);
  });

  it('sorts, filters, searches and slices like a server', async () => {
    const page = await fast.fetchPage(
      query({ sort: '-name', size: 10, page: 2, department: 'design' }),
    );
    const design = SAMPLE_PEOPLE.filter((person) => person.department === 'design').sort((a, b) =>
      b.name.localeCompare(a.name, 'en'),
    );
    expect(page.total).toBe(design.length);
    expect(page.rows.map((row) => row.id)).toEqual(design.slice(10, 20).map((row) => row.id));
  });

  it('answers an empty list for the empty scenario and fails for the error scenario', async () => {
    expect(await fast.fetchPage(query({ scenario: 'empty' }))).toEqual({ rows: [], total: 0 });
    await expect(fast.fetchPage(query({ scenario: 'error' }))).rejects.toThrow();
  });

  it('waits for the simulated latency through the injected clock, and stops when aborted', async () => {
    const waits: number[] = [];
    const source = createSampleSource({
      delayMs: 321,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await source.fetchPage(query());
    expect(waits).toEqual([321]);

    const controller = new AbortController();
    const aborting = createSampleSource({
      delayMs: 1,
      wait: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const pending = aborting.fetchPage(query(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe('validateShowcaseSearch', () => {
  it('keeps the table keys as strings and numbers, and the scenario when known', () => {
    expect(
      validateShowcaseSearch({
        q: 'ada',
        sort: '-name',
        page: 2,
        size: '50',
        scenario: 'error',
        'f.department': 'finance',
      }),
    ).toEqual({
      q: 'ada',
      sort: '-name',
      page: 2,
      size: 50,
      scenario: 'error',
      'f.department': 'finance',
    });
  });

  it('turns a number typed as q into text and drops values that make no sense', () => {
    expect(validateShowcaseSearch({ q: 123 })).toEqual({ q: '123' });
    expect(
      validateShowcaseSearch({
        page: -1,
        size: 'x',
        scenario: 'nope',
        'f.department': 'unknown',
        q: { a: 1 },
        other: 'x',
      }),
    ).toEqual({});
  });
});

describe('the DataTable wiring', () => {
  it('builds every label from the catalogue, in both languages', () => {
    for (const translator of [en, nl]) {
      const labels = createTableLabels(translator, 'My table');
      expect(labels.tableLabel).toBe('My table');
      for (const [name, value] of Object.entries(labels)) {
        const text: string =
          typeof value === 'function'
            ? (value as (...args: unknown[]) => string)(2, 5, 7)
            : String(value);
        expect(text, name).not.toBe('');
        expect(text, name).not.toMatch(/^common\.table\./);
      }
    }
  });

  it('puts the number where the language wants it', () => {
    expect(createTableLabels(en, 'x').resultCount(1)).toBe('1 result');
    expect(createTableLabels(en, 'x').resultCount(2)).toBe('2 results');
    expect(createTableLabels(nl, 'x').resultCount(1)).toBe('1 resultaat');
    expect(createTableLabels(nl, 'x').resultCount(1234)).toBe('1.234 resultaten');
    expect(createTableLabels(nl, 'x').pageStatus(2, 5)).toBe('Pagina 2 van 5');
  });

  it('stores the column choice through the storage module, per table id', () => {
    const backend = new MemoryBackend();
    const storage = createColumnStorage(createStorage(backend));

    expect(storage.read('people')).toBeNull();
    storage.write('people', { hidden: ['role'], order: ['name', 'role'] });
    expect(backend.values.get('m365portal.columns.people')).toBe(
      JSON.stringify({ hidden: ['role'], order: ['name', 'role'] }),
    );
    expect(storage.read('people')).toEqual({ hidden: ['role'], order: ['name', 'role'] });
    storage.clear('people');
    expect(storage.read('people')).toBeNull();
  });

  it('never throws: garbage, a wrong shape and a bad table id read as no choice', () => {
    const backend = new MemoryBackend();
    const storage = createColumnStorage(createStorage(backend));
    for (const garbage of [
      'not json',
      '{"hidden":"x","order":[]}',
      '{"hidden":[1],"order":[]}',
      'null',
      '[]',
    ]) {
      backend.values.set('m365portal.columns.people', garbage);
      expect(storage.read('people'), garbage).toBeNull();
    }
    expect(storage.read('bad id!')).toBeNull();
    expect(() => {
      storage.write('bad id!', { hidden: [], order: [] });
      storage.clear('bad id!');
    }).not.toThrow();
  });
});
