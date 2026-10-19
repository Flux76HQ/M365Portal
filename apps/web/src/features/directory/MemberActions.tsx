// Add and remove members (FR-D-203, FR-D-352, FR-D-903, US-D1, US-D3): the two buttons above a members table, the
// dialog that picks who to add, the confirmation that lists who is removed, and the result of the last change
// per member. The same for distribution lists and for groups; what differs (the routes, who can be searched)
// is handed in. The page decides whether to render it at all: it is shown only to an actor who may write and
// for an object that can be changed, and the server decides again (a refusal is shown, translated).
//
// A write is never repeated on its own. When the server asks for a fresh sign-in (`step_up_required`) the
// session dialog opens and the person starts again; the add dialog stays open with its selection.
import type { MemberWriteItem, MemberWriteSummary } from '@m365portal/shared/schemas/member-writes';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/button';
import { ErrorState } from '../../components/ui/error-state';
import { ApiError } from '../../lib/api';
import { useTranslator } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import { useMe } from '../../lib/router-context';
import { candidateName, type PickerCandidate, type PickerSearch } from './candidates';
import { MemberResults } from './MemberResults';
import type { MemberSelection } from './useMemberSelection';

/** What a write answers, for a list (with `readBackPending`) or a group (without). */
export interface MemberWriteOutcome {
  readonly results: readonly MemberWriteItem[];
  readonly summary: MemberWriteSummary;
  readonly readBackPending?: boolean;
}

export interface MemberActionsProps {
  /** The name of the list or group, shown in the dialogs. */
  readonly targetName: string;
  /** Part of the cache key of the picker's search. */
  readonly scope: readonly unknown[];
  readonly search: PickerSearch;
  readonly variant: 'usersAndContacts' | 'users';
  readonly add: (ids: string[]) => Promise<MemberWriteOutcome>;
  readonly remove: (ids: string[]) => Promise<MemberWriteOutcome>;
  /** `LIMITS.<x>.bulkMax`: the most in one request. */
  readonly max: number;
  /** `LIMITS.<x>.stepUpAbove`: above this many the server asks for a fresh sign-in. */
  readonly stepUpAbove: number;
  readonly selection: MemberSelection;
  /** The members were changed: read them again. */
  readonly onChanged: () => void;
  /** Another button for the same row (the export of a list). */
  readonly extra?: ReactNode;
}

type Outcome =
  | {
      readonly kind: 'results';
      readonly outcome: MemberWriteOutcome;
      readonly names: ReadonlyMap<string, string>;
    }
  | { readonly kind: 'error'; readonly error: unknown };

// The dialogs are a chunk of their own: nothing of them is loaded until a button is pressed.
const MemberDialogs = lazy(() => import('./MemberDialogs'));

export function MemberActions({
  targetName,
  scope,
  search,
  variant,
  add,
  remove,
  max,
  stepUpAbove,
  selection,
  onChanged,
  extra,
}: MemberActionsProps) {
  const translator = useTranslator();
  const { t } = translator;
  const me = useMe();
  // The dialogs load when a button is first pressed; after that they stay mounted, so they can animate out.
  const [wanted, setWanted] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState(false);
  const [picked, setPicked] = useState<readonly PickerCandidate[]>([]);
  const [addError, setAddError] = useState<unknown>(null);
  const [last, setLast] = useState<Outcome | null>(null);

  function closeAdd() {
    setAdding(false);
    setPicked([]);
    setAddError(null);
  }

  async function submitAdd() {
    setPending(true);
    setAddError(null);
    const names = new Map(
      picked.map((candidate) => [
        candidate.id,
        candidateName(candidate, t('distributionLists.members.unnamed')),
      ]),
    );
    try {
      const outcome = await add(picked.map((candidate) => candidate.id));
      setLast({ kind: 'results', outcome, names });
      closeAdd();
      onChanged();
    } catch (error) {
      setAddError(error);
    } finally {
      setPending(false);
    }
  }

  async function submitRemove() {
    setPending(true);
    const names = new Map(selection.names);
    try {
      const outcome = await remove([...selection.ids]);
      setLast({ kind: 'results', outcome, names });
      selection.clear();
      onChanged();
    } catch (error) {
      setLast({ kind: 'error', error });
    } finally {
      setPending(false);
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={() => {
            setWanted(true);
            setAdding(true);
          }}
        >
          {t('distributionLists.add.open')}
        </Button>
        <Button
          disabled={selection.count === 0}
          onClick={() => {
            setWanted(true);
            setRemoving(true);
          }}
        >
          {t('distributionLists.remove.open')}
        </Button>
        {extra}
        {selection.count > 0 ? (
          <span className="text-body-sm text-fg-secondary">
            {t('distributionLists.picker.selected', { count: selection.count })}
          </span>
        ) : null}
      </div>

      {last?.kind === 'results' ? (
        <MemberResults
          results={last.outcome.results}
          summary={last.outcome.summary}
          names={last.names}
          readBackPending={last.outcome.readBackPending === true}
          onRefresh={onChanged}
          onDismiss={() => {
            setLast(null);
          }}
        />
      ) : null}
      {last?.kind === 'error' ? (
        <ErrorState
          headingLevel={3}
          title={t('distributionLists.results.writeError')}
          description={messageForError(translator, last.error, { publicOrigin: me.publicOrigin })}
          {...(last.error instanceof ApiError && last.error.requestId !== null
            ? { requestIdLabel: t('common.table.requestId'), requestId: last.error.requestId }
            : {})}
          action={
            <Button
              onClick={() => {
                setLast(null);
              }}
            >
              {t('distributionLists.results.dismiss')}
            </Button>
          }
        />
      ) : null}

      {wanted ? (
        <Suspense fallback={null}>
          <MemberDialogs
            targetName={targetName}
            scope={scope}
            search={search}
            variant={variant}
            max={max}
            stepUpAbove={stepUpAbove}
            pending={pending}
            adding={adding}
            picked={picked}
            onPick={setPicked}
            addError={addError}
            onCloseAdd={closeAdd}
            onSubmitAdd={() => {
              void submitAdd();
            }}
            removing={removing}
            selection={selection}
            onCancelRemove={() => {
              if (!pending) setRemoving(false);
            }}
            onConfirmRemove={() => {
              void submitRemove();
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
