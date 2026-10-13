// What the member picker and the pages that use it share, apart from the picker itself (which is a chunk of its
// own, loaded when a dialog opens): the shape of a candidate, how many results one search asks for, and the
// name a candidate is shown by.

/** A person or contact that can be picked. */
export interface PickerCandidate {
  readonly id: string;
  readonly kind: 'user' | 'contact';
  readonly displayName: string | null;
  readonly mail: string | null;
  /** True when it is a member already; `null` when that was not checked. */
  readonly alreadyMember: boolean | null;
}

export type PickerSearch = (
  query: string,
  signal: AbortSignal,
) => Promise<readonly PickerCandidate[]>;

/** How many results the picker asks for; when it gets that many it says there may be more. */
export const PICKER_PAGE_SIZE = 25;

/** The name a candidate is shown by. */
export function candidateName(candidate: PickerCandidate, unnamed: string): string {
  return candidate.displayName === null || candidate.displayName === ''
    ? (candidate.mail ?? unnamed)
    : candidate.displayName;
}
