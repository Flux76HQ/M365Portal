// The cursor half of a directory list (T-C-018, T-C-021, FR-C-103, EC-C3): turning the cursor of a
// request into a scan position, and the position a scan ended at into the cursor of the answer.
//
// A cursor is valid for the actor it was made for, on the route it was made on, for the same
// parameters; anything else (another actor, another list, a changed filter, an expired or unknown
// handle) is the same answer, 400 `cursor_invalid`, which the UI turns into "start again".
import { ProblemError } from '../http/problem.js';
import type { CursorStore } from './cursor-store.js';
import type { ScanPosition } from './scoped-list.js';

/** The canonical text of the parameters a cursor stands for: sorted, `undefined` left out. */
export function keyOf(params: Readonly<Record<string, string | undefined>>): string {
  return JSON.stringify(
    Object.entries(params)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Where the request starts: the first row without a cursor, otherwise what the cursor stands for. */
export function startOf(
  store: CursorStore,
  actorId: string,
  route: string,
  key: string,
  cursor: string | undefined,
): ScanPosition | null {
  if (cursor === undefined) return null;
  const state = store.take(actorId, cursor);
  if (state?.route !== route || state.key !== key) {
    throw new ProblemError('cursor_invalid');
  }
  return { pageToken: state.pageToken, skip: state.skip };
}

/** The cursor of the answer, or `undefined` at the end of the list. */
export function cursorFor(
  store: CursorStore,
  actorId: string,
  route: string,
  key: string,
  resume: ScanPosition | null,
): string | undefined {
  if (resume === null) return undefined;
  return store.put(actorId, { route, key, pageToken: resume.pageToken, skip: resume.skip });
}
