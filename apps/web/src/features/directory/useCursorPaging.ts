// Paging through a list with cursors (FR-C-502, EC-C3). The server hands out an opaque cursor with every
// page that has a next one and knows no page numbers and no total, so "Previous" needs a memory: the cursors
// of the pages already visited are kept here, in component state (not in the URL: a cursor lives ten
// minutes and belongs to one actor, so a shared link starts on the first page of the same filters).
//
// A change of the reset key (the filters, the search text, the order) starts again from the first page. A
// `cursor_invalid` answer (unknown, expired or foreign cursor) does the same and says so, so the person is
// told why the list jumped back.
import { useState } from 'react';
import { ApiError } from '../../lib/api';

export interface CursorPaging {
  /** The cursor of the page to ask for; `undefined` is the first page. */
  readonly cursor: string | undefined;
  /** 1 for the first page. */
  readonly page: number;
  readonly canPrevious: boolean;
  /** The list started again because its cursor was no longer valid; cleared by the next move. */
  readonly restarted: boolean;
  /** Go to the next page; `nextCursor` is what the current page's answer carried. */
  readonly next: (nextCursor: string) => void;
  readonly previous: () => void;
  /** Back to the first page. */
  readonly reset: () => void;
}

interface State {
  readonly key: string;
  /** The cursors of pages 2 and up that were visited, the last one being the current page. */
  readonly cursors: readonly string[];
  readonly restarted: boolean;
  /** The error already answered with a restart, so one error restarts once. */
  readonly handled: unknown;
}

export function isCursorInvalid(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'cursor_invalid';
}

export function useCursorPaging(resetKey: string, error: unknown = null): CursorPaging {
  const [state, setState] = useState<State>({
    key: resetKey,
    cursors: [],
    restarted: false,
    handled: null,
  });

  // Adjusted while rendering (not in an effect), so the page never asks for a stale cursor first.
  let current = state;
  if (state.key !== resetKey) {
    current = { key: resetKey, cursors: [], restarted: false, handled: state.handled };
    setState(current);
  } else if (isCursorInvalid(error) && error !== state.handled) {
    current = { ...state, cursors: [], restarted: true, handled: error };
    setState(current);
  }

  const { cursors } = current;
  return {
    cursor: cursors.at(-1),
    page: cursors.length + 1,
    canPrevious: cursors.length > 0,
    restarted: current.restarted,
    next: (nextCursor) => {
      setState((previous) => ({
        ...previous,
        cursors: [...previous.cursors, nextCursor],
        restarted: false,
      }));
    },
    previous: () => {
      setState((previous) => ({
        ...previous,
        cursors: previous.cursors.slice(0, -1),
        restarted: false,
      }));
    },
    reset: () => {
      setState((previous) => ({ ...previous, cursors: [], restarted: false }));
    },
  };
}
