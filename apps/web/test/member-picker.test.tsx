// MemberPicker and MemberResults (T-D-150; FR-D-203, FR-D-352, FR-D-901 to FR-D-903). The picker searches with a
// debounce, selects several people with the keyboard or the pointer, says what is selected and what is a member
// already; the result view tells, per member, what happened and why a member failed (US-D3).
import { createTranslator } from '@m365portal/shared/i18n';
import {
  summariseMemberResults,
  type MemberWriteItem,
} from '@m365portal/shared/schemas/member-writes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MemberPicker, type PickerCandidate } from '../src/features/directory/MemberPicker';
import { MemberResults } from '../src/features/directory/MemberResults';
import { ApiError } from '../src/lib/api';
import { LanguageProvider, createLanguageController } from '../src/lib/locale';
import { createStorage } from '../src/lib/storage';
import { guid } from './support/directory-handlers';

const en = createTranslator('en');
const nl = createTranslator('nl');
const t = en.t;

function candidate(n: number, overrides: Partial<PickerCandidate> = {}): PickerCandidate {
  return {
    id: guid(n),
    kind: 'user',
    displayName: `Person ${String(n)}`,
    mail: `person${String(n)}@example.test`,
    alreadyMember: false,
    ...overrides,
  };
}

type Search = (query: string, signal: AbortSignal) => Promise<readonly PickerCandidate[]>;

function Harness({
  search,
  debounceMs = 40,
  max,
  language = 'en',
  variant,
}: {
  readonly search: Search;
  readonly debounceMs?: number;
  readonly max?: number;
  readonly language?: 'en' | 'nl';
  readonly variant?: 'usersAndContacts' | 'users';
}) {
  const [selected, setSelected] = useState<readonly PickerCandidate[]>([]);
  const controller = createLanguageController({
    storage: createStorage(null),
    languages: [language],
    root: document.createElement('html'),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <LanguageProvider controller={controller}>
        <MemberPicker
          scope={['test']}
          search={search}
          selected={selected}
          onChange={setSelected}
          debounceMs={debounceMs}
          {...(max === undefined ? {} : { max })}
          {...(variant === undefined ? {} : { variant })}
        />
      </LanguageProvider>
    </QueryClientProvider>
  );
}

const box = () =>
  screen.getByRole('searchbox', { name: t('distributionLists.picker.search.label') });

describe('the search', () => {
  it('waits for the typing to stop and searches once with the trimmed text', async () => {
    const search = vi.fn<Search>(() => Promise.resolve([candidate(1)]));
    render(<Harness search={search} debounceMs={150} />);
    const user = userEvent.setup();
    await user.type(box(), '  ada ');
    expect(search).not.toHaveBeenCalled();
    await screen.findByRole('checkbox', { name: /Person 1/ });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toBe('ada');
  });

  it('does not search for blank text, and clears the results when the text is deleted', async () => {
    const search = vi.fn<Search>(() => Promise.resolve([candidate(1)]));
    render(<Harness search={search} />);
    const user = userEvent.setup();
    await user.type(box(), '   ');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(search).not.toHaveBeenCalled();
    await user.type(box(), 'a');
    await screen.findByRole('checkbox', { name: /Person 1/ });
    await user.clear(box());
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Person 1/ })).toBeNull();
    });
  });

  it('shows name, address and kind of each result and says how many there are', async () => {
    const search: Search = () =>
      Promise.resolve([candidate(1), candidate(2, { kind: 'contact', displayName: 'Cleo' })]);
    render(<Harness search={search} />);
    await userEvent.setup().type(box(), 'p');
    const list = await screen.findByRole('list', {
      name: t('distributionLists.picker.resultsLabel'),
    });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Person 1');
    expect(rows[0]).toHaveTextContent('person1@example.test');
    expect(rows[0]).toHaveTextContent(t('distributionLists.member.kindUser'));
    expect(rows[1]).toHaveTextContent(t('distributionLists.member.kindContact'));
    expect(
      screen.getByText(t('distributionLists.picker.results', { count: 2 })),
    ).toBeInTheDocument();
  });

  it('says so when nothing is found', async () => {
    render(<Harness search={() => Promise.resolve([])} />);
    await userEvent.setup().type(box(), 'zzz');
    expect(await screen.findByText(t('distributionLists.picker.noResults'))).toBeInTheDocument();
  });

  it('shows a translated error with a way to try again, never the text of the server', async () => {
    let fail = true;
    const search: Search = () =>
      fail
        ? Promise.reject(
            new ApiError({
              code: 'exchange_unavailable',
              status: 503,
              requestId: 'req-0000-test',
              errors: [],
              expectedOrigin: null,
              retryAfterSeconds: null,
            }),
          )
        : Promise.resolve([candidate(1)]);
    render(<Harness search={search} />);
    const user = userEvent.setup();
    await user.type(box(), 'a');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t('distributionLists.picker.error'));
    fail = false;
    await user.click(screen.getByRole('button', { name: t('distributionLists.picker.retry') }));
    expect(await screen.findByRole('checkbox', { name: /Person 1/ })).toBeInTheDocument();
  });

  it('offers the users wording where only users can be added', () => {
    render(<Harness search={() => Promise.resolve([])} variant="users" />);
    expect(
      screen.getByRole('searchbox', { name: t('distributionLists.picker.search.labelUsers') }),
    ).toBeInTheDocument();
  });

  it('speaks Dutch', async () => {
    render(<Harness search={() => Promise.resolve([candidate(1)])} language="nl" />);
    await userEvent
      .setup()
      .type(
        screen.getByRole('searchbox', { name: nl.t('distributionLists.picker.search.label') }),
        'p',
      );
    expect(
      await screen.findByText(nl.t('distributionLists.picker.results', { count: 1 })),
    ).toBeInTheDocument();
  });
});

describe('the selection', () => {
  it('selects several, lists them, counts them and lets one go again', async () => {
    const search: Search = () => Promise.resolve([candidate(1), candidate(2), candidate(3)]);
    render(<Harness search={search} />);
    const user = userEvent.setup();
    await user.type(box(), 'p');
    await user.click(await screen.findByRole('checkbox', { name: /Person 1/ }));
    await user.click(screen.getByRole('checkbox', { name: /Person 3/ }));
    expect(screen.getByRole('checkbox', { name: /Person 1/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Person 2/ })).not.toBeChecked();
    const chosen = screen.getByRole('list', { name: t('distributionLists.picker.selectedLabel') });
    expect(
      within(chosen)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining('Person 1'), expect.stringContaining('Person 3')]);
    expect(
      screen.getByText(t('distributionLists.picker.selected', { count: 2 })),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: t('distributionLists.picker.remove', { name: 'Person 1' }),
      }),
    );
    expect(screen.getByRole('checkbox', { name: /Person 1/ })).not.toBeChecked();
    expect(
      screen.getByText(t('distributionLists.picker.selected', { count: 1 })),
    ).toBeInTheDocument();
  });

  it('keeps the selection when the search changes', async () => {
    const search: Search = (query) =>
      Promise.resolve(query === 'a' ? [candidate(1)] : [candidate(2)]);
    render(<Harness search={search} />);
    const user = userEvent.setup();
    await user.type(box(), 'a');
    await user.click(await screen.findByRole('checkbox', { name: /Person 1/ }));
    await user.clear(box());
    await user.type(box(), 'b');
    await screen.findByRole('checkbox', { name: /Person 2/ });
    const chosen = screen.getByRole('list', { name: t('distributionLists.picker.selectedLabel') });
    expect(within(chosen).getByText('Person 1')).toBeInTheDocument();
  });

  it('does not let a member be selected again, and says why', async () => {
    const search: Search = () =>
      Promise.resolve([candidate(1, { alreadyMember: true }), candidate(2)]);
    render(<Harness search={search} />);
    await userEvent.setup().type(box(), 'p');
    const taken = await screen.findByRole('checkbox', { name: /Person 1/ });
    expect(taken).toBeDisabled();
    expect(screen.getByText(t('distributionLists.picker.alreadyMember'))).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Person 2/ })).toBeEnabled();
  });

  it('stops at the most it was given and says so', async () => {
    const search: Search = () => Promise.resolve([candidate(1), candidate(2), candidate(3)]);
    render(<Harness search={search} max={2} />);
    const user = userEvent.setup();
    await user.type(box(), 'p');
    await user.click(await screen.findByRole('checkbox', { name: /Person 1/ }));
    await user.click(screen.getByRole('checkbox', { name: /Person 2/ }));
    expect(screen.getByRole('checkbox', { name: /Person 3/ })).toBeDisabled();
    expect(screen.getByText(t('distributionLists.picker.limit', { max: 2 }))).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Person 1/ }));
    expect(screen.getByRole('checkbox', { name: /Person 3/ })).toBeEnabled();
  });
});

describe('the keyboard', () => {
  it('searches at once on Enter, moves into the results with the arrow down and selects with the space bar', async () => {
    const search = vi.fn<Search>(() => Promise.resolve([candidate(1), candidate(2)]));
    render(<Harness search={search} debounceMs={5000} />);
    const user = userEvent.setup();
    await user.type(box(), 'pe{Enter}');
    const first = await screen.findByRole('checkbox', { name: /Person 1/ });
    expect(search).toHaveBeenCalledTimes(1);
    await user.keyboard('{ArrowDown}');
    expect(first).toHaveFocus();
    await user.keyboard(' ');
    expect(first).toBeChecked();
    await user.tab();
    expect(screen.getByRole('checkbox', { name: /Person 2/ })).toHaveFocus();
  });

  it('reads the selection out as a status', async () => {
    render(<Harness search={() => Promise.resolve([candidate(1)])} />);
    const user = userEvent.setup();
    await user.type(box(), 'p');
    await user.click(await screen.findByRole('checkbox', { name: /Person 1/ }));
    const text = screen.getByText(t('distributionLists.picker.selected', { count: 1 }));
    expect(text.closest('[role="status"]')).not.toBeNull();
  });
});

describe('MemberResults', () => {
  const names = new Map([
    [guid(1), 'Ada'],
    [guid(2), 'Bo'],
    [guid(3), 'Cy'],
  ]);
  const results: MemberWriteItem[] = [
    { id: guid(1), result: 'added' },
    { id: guid(2), result: 'failed', reason: 'mail_disabled' },
    { id: guid(3), result: 'already' },
    { id: guid(4), result: 'failed', reason: 'throttled' },
  ];

  it('counts each result, names every member and gives a failed member its reason', () => {
    render(<MemberResultsHarness results={results} names={names} />);
    expect(
      screen.getByRole('heading', { name: t('distributionLists.results.heading') }),
    ).toBeInTheDocument();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(
      t('distributionLists.results.count', {
        result: t('distributionLists.result.added'),
        count: 1,
      }),
    );
    expect(status).toHaveTextContent(
      t('distributionLists.results.count', {
        result: t('distributionLists.result.failed'),
        count: 2,
      }),
    );
    expect(status).not.toHaveTextContent(t('distributionLists.result.removed'));
    expect(screen.getByText(t('distributionLists.results.partial'))).toBeInTheDocument();

    const table = screen.getByRole('table', { name: t('distributionLists.results.caption') });
    const rows = within(table).getAllByRole('row').slice(1);
    // Failures first, so they are not buried under 190 successes.
    expect(rows[0]).toHaveTextContent('Bo');
    expect(rows[0]).toHaveTextContent(t('distributionLists.result.failed'));
    expect(rows[0]).toHaveTextContent(t('distributionLists.reason.mail_disabled'));
    expect(rows[1]).toHaveTextContent(t('distributionLists.reason.throttled'));
    expect(rows[1]).toHaveTextContent(t('distributionLists.members.unnamed'));
    expect(
      within(table).getByRole('columnheader', {
        name: t('distributionLists.results.column.reason'),
      }),
    ).toBeInTheDocument();
  });

  it('says when everything worked, and when nothing did', () => {
    const { rerender } = render(
      <MemberResultsHarness results={[{ id: guid(1), result: 'removed' }]} names={names} />,
    );
    expect(screen.getByText(t('distributionLists.results.allDone'))).toBeInTheDocument();
    rerender(
      <MemberResultsHarness
        results={[{ id: guid(1), result: 'failed', reason: 'rejected' }]}
        names={names}
      />,
    );
    expect(screen.getByText(t('distributionLists.results.allFailed'))).toBeInTheDocument();
  });

  it('notes that Exchange may not show the change yet, and can be asked again', async () => {
    const onRefresh = vi.fn();
    render(
      <MemberResultsHarness
        results={[{ id: guid(1), result: 'added' }]}
        names={names}
        readBackPending
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByText(t('distributionLists.readBack.pending'))).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: t('distributionLists.results.refresh') }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('can be dismissed', async () => {
    const onDismiss = vi.fn();
    render(
      <MemberResultsHarness
        results={[{ id: guid(1), result: 'added' }]}
        names={names}
        onDismiss={onDismiss}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: t('distributionLists.results.dismiss') }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

function MemberResultsHarness(props: {
  readonly results: readonly MemberWriteItem[];
  readonly names: ReadonlyMap<string, string>;
  readonly readBackPending?: boolean;
  readonly onRefresh?: () => void;
  readonly onDismiss?: () => void;
}) {
  const controller = createLanguageController({
    storage: createStorage(null),
    languages: ['en'],
    root: document.createElement('html'),
  });
  return (
    <LanguageProvider controller={controller}>
      <MemberResults
        results={props.results}
        summary={summariseMemberResults(props.results)}
        names={props.names}
        {...(props.readBackPending === undefined ? {} : { readBackPending: props.readBackPending })}
        {...(props.onRefresh === undefined ? {} : { onRefresh: props.onRefresh })}
        {...(props.onDismiss === undefined ? {} : { onDismiss: props.onDismiss })}
      />
    </LanguageProvider>
  );
}
