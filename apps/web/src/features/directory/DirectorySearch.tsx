// The search box of the lists (FR-C-502): a visible label, the text applied on submit (so typing fires no
// request per key), a clear button and a hint. The text is limited to the server's 64 characters.
import { SearchIcon, XIcon } from 'lucide-react';
import { useId, useState, type SyntheticEvent } from 'react';
import { Button } from '../../components/ui/button';
import { IconButton } from '../../components/ui/icon-button';
import { Input } from '../../components/ui/input';
import { useTranslator } from '../../lib/locale';
import { SEARCH_MAX_CHARS, searchText } from './search';

export interface DirectorySearchProps {
  readonly label: string;
  readonly hint: string;
  /** The applied search text (from the URL). */
  readonly value: string | undefined;
  readonly onSubmit: (value: string | undefined) => void;
}

export function DirectorySearch({ label, hint, value, onSubmit }: DirectorySearchProps) {
  const { t } = useTranslator();
  const inputId = useId();
  const hintId = useId();
  // The draft is what is typed; the value is what is applied. A change of the applied value from outside
  // (the Back button, a cleared filter) replaces the draft.
  const [draft, setDraft] = useState(value ?? '');
  const [applied, setApplied] = useState(value);
  if (applied !== value) {
    setApplied(value);
    setDraft(value ?? '');
  }

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    onSubmit(searchText(draft));
  }

  return (
    <form role="search" onSubmit={submit} className="flex min-w-0 max-w-full flex-col gap-1">
      <label htmlFor={inputId} className="text-body-sm font-medium text-fg">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64 max-w-full min-w-0">
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
            className="w-full ps-9"
          />
        </div>
        {draft !== '' || value !== undefined ? (
          <IconButton
            label={t('common.table.searchClear')}
            onClick={() => {
              setDraft('');
              onSubmit(undefined);
            }}
          >
            <XIcon className="size-4" />
          </IconButton>
        ) : null}
        <Button type="submit">{t('common.table.search')}</Button>
      </div>
      <p id={hintId} className="text-caption text-fg-muted">
        {hint}
      </p>
    </form>
  );
}
