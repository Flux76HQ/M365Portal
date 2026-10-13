// The picker of the people to add to a distribution list or a group (FR-D-203, FR-D-352, FR-D-901): a search box
// whose text is applied after a short pause (or at once on Enter), the results as a list of checkboxes, and the
// selection as a list of its own. It is controlled: the page keeps the selection, because the button that
// adds it is outside the picker. Everything is native or a Radix checkbox, so the keyboard works without a
// custom widget: Tab moves through the results, the space bar selects, and the arrow down from the search box
// goes to the first result that can be selected.
//
// The search function is the caller's (the candidates route of a list, the users route for a group); the
// picker only asks it for the text and shows what it returns. Text from the tenant is data: it is rendered as
// text, never as markup.
import { SearchIcon, XIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { IconButton } from '../../components/ui/icon-button';
import { Input } from '../../components/ui/input';
import { useTranslator } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import {
  PICKER_PAGE_SIZE,
  candidateName,
  type PickerCandidate,
  type PickerSearch,
} from './candidates';
import { SEARCH_MAX_CHARS, searchText } from './search';

export type { PickerCandidate, PickerSearch };

/** The pause after the last key before the search runs. */
export const PICKER_DEBOUNCE_MS = 300;

export interface MemberPickerProps {
  /** Part of the cache key of the search: the list or the group the people are added to. */
  readonly scope: readonly unknown[];
  readonly search: PickerSearch;
  readonly selected: readonly PickerCandidate[];
  readonly onChange: (next: readonly PickerCandidate[]) => void;
  /** The most that may be selected. */
  readonly max?: number;
  readonly debounceMs?: number;
  /** `users`: only users can be added (a group), so the wording says users. */
  readonly variant?: 'usersAndContacts' | 'users';
}

export function MemberPicker({
  scope,
  search,
  selected,
  onChange,
  max,
  debounceMs = PICKER_DEBOUNCE_MS,
  variant = 'usersAndContacts',
}: MemberPickerProps) {
  const translator = useTranslator();
  const { t } = translator;
  const inputId = useId();
  const hintId = useId();
  const resultsRef = useRef<HTMLUListElement>(null);
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState<string | undefined>(undefined);

  // The text is applied after the last key, not on every key (one request per pause).
  useEffect(() => {
    const next = searchText(draft);
    if (next === applied) return undefined;
    const timer = setTimeout(() => {
      setApplied(next);
    }, debounceMs);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, applied, debounceMs]);

  const query = useQuery({
    queryKey: ['memberPicker', ...scope, applied ?? null],
    queryFn: ({ signal }) => search(applied ?? '', signal),
    enabled: applied !== undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  const atMax = max !== undefined && selected.length >= max;
  const items = applied === undefined ? [] : (query.data ?? []);
  const unnamed = t('distributionLists.members.unnamed');

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    setApplied(searchText(draft));
  }

  function toggle(candidate: PickerCandidate, checked: boolean) {
    if (checked) {
      if (!selectedIds.has(candidate.id)) onChange([...selected, candidate]);
    } else {
      onChange(selected.filter((entry) => entry.id !== candidate.id));
    }
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'ArrowDown') return;
    const first = resultsRef.current?.querySelector<HTMLElement>(
      'button[role="checkbox"]:not([disabled])',
    );
    if (first !== null && first !== undefined) {
      event.preventDefault();
      first.focus();
    }
  }

  let status: string;
  if (applied === undefined || query.isFetching) status = '';
  else if (query.isError) status = '';
  else if (items.length === 0) status = t('distributionLists.picker.noResults');
  else status = t('distributionLists.picker.results', { count: items.length });

  return (
    <div className="flex flex-col gap-3">
      <form role="search" onSubmit={submit} className="flex min-w-0 max-w-full flex-col gap-1">
        <label htmlFor={inputId} className="text-body-sm font-medium text-fg">
          {variant === 'users'
            ? t('distributionLists.picker.search.labelUsers')
            : t('distributionLists.picker.search.label')}
        </label>
        <div className="relative min-w-0 max-w-full">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
          />
          <Input
            id={inputId}
            type="search"
            value={draft}
            maxLength={SEARCH_MAX_CHARS}
            aria-describedby={hintId}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={keyDown}
            className="w-full ps-9"
          />
        </div>
        <p id={hintId} className="text-caption text-fg-muted">
          {variant === 'users'
            ? t('distributionLists.picker.search.hintUsers')
            : t('distributionLists.picker.search.hint')}
        </p>
      </form>

      <p role="status" aria-live="polite" className="text-body-sm text-fg-secondary">
        {status}
      </p>

      {query.isError && applied !== undefined ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-body-sm text-danger">
          <p>{t('distributionLists.picker.error')}</p>
          <p className="text-fg-secondary">{messageForError(translator, query.error)}</p>
          <Button
            size="sm"
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('distributionLists.picker.retry')}
          </Button>
        </div>
      ) : null}

      {items.length > 0 ? (
        <>
          <ul
            ref={resultsRef}
            aria-label={t('distributionLists.picker.resultsLabel')}
            className="flex flex-col rounded-md border border-line-subtle"
          >
            {items.map((candidate) => (
              <ResultRow
                key={candidate.id}
                candidate={candidate}
                unnamed={unnamed}
                checked={selectedIds.has(candidate.id)}
                disabled={
                  candidate.alreadyMember === true || (atMax && !selectedIds.has(candidate.id))
                }
                onToggle={toggle}
              />
            ))}
          </ul>
          {items.length >= PICKER_PAGE_SIZE ? (
            <p className="text-body-sm text-fg-secondary">{t('distributionLists.picker.more')}</p>
          ) : null}
        </>
      ) : null}

      <p role="status" aria-live="polite" className="text-body-sm font-medium text-fg">
        {t('distributionLists.picker.selected', { count: selected.length })}
      </p>
      {max !== undefined && atMax ? (
        <p className="text-body-sm text-fg-secondary">
          {t('distributionLists.picker.limit', { max })}
        </p>
      ) : null}

      {selected.length > 0 ? (
        <ul
          aria-label={t('distributionLists.picker.selectedLabel')}
          className="flex flex-wrap gap-2"
        >
          {selected.map((candidate) => {
            const name = candidateName(candidate, unnamed);
            return (
              <li
                key={candidate.id}
                className="inline-flex items-center gap-1 rounded-md border border-line-subtle bg-surface-raised ps-3 text-body-sm text-fg"
              >
                <span className="break-all">{name}</span>
                <IconButton
                  size="sm"
                  label={t('distributionLists.picker.remove', { name })}
                  onClick={() => {
                    toggle(candidate, false);
                  }}
                >
                  <XIcon className="size-4" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

interface ResultRowProps {
  readonly candidate: PickerCandidate;
  readonly unnamed: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: (candidate: PickerCandidate, checked: boolean) => void;
}

function ResultRow({ candidate, unnamed, checked, disabled, onToggle }: ResultRowProps) {
  const { t } = useTranslator();
  const base = useId();
  const nameId = `${base}-name`;
  const detailId = `${base}-detail`;
  const name = candidateName(candidate, unnamed);
  return (
    <li className="flex items-start gap-2 border-b border-line-subtle px-2 py-1 last:border-b-0">
      <Checkbox
        id={`${base}-box`}
        checked={checked}
        disabled={disabled}
        aria-labelledby={nameId}
        aria-describedby={detailId}
        onCheckedChange={(value) => {
          onToggle(candidate, value === true);
        }}
      />
      <label htmlFor={`${base}-box`} className="flex min-w-0 flex-1 flex-col py-0.5 text-body">
        <span id={nameId} className="break-words font-medium text-fg">
          {name}
        </span>
        <span
          id={detailId}
          className="text-body-sm flex flex-wrap gap-x-3 break-words text-fg-secondary"
        >
          {candidate.mail === null ? null : <span>{candidate.mail}</span>}
          <span>
            {t(
              candidate.kind === 'contact'
                ? 'distributionLists.member.kindContact'
                : 'distributionLists.member.kindUser',
            )}
          </span>
          {candidate.alreadyMember === true ? (
            <span className="font-medium">{t('distributionLists.picker.alreadyMember')}</span>
          ) : null}
        </span>
      </label>
    </li>
  );
}
