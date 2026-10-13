// The members ticked in a table, by id (FR-D-203). The names travel with the ids, because the confirmation and
// the result view name the members and the page that was ticked may no longer be on screen. State of the page
// that owns the table; the actions component reads it.
import { useState } from 'react';

export interface MemberSelection {
  readonly count: number;
  readonly ids: readonly string[];
  /** Names by id. */
  readonly names: ReadonlyMap<string, string>;
  readonly has: (id: string) => boolean;
  readonly toggle: (id: string, name: string, selected: boolean) => void;
  readonly clear: () => void;
}

export function useMemberSelection(): MemberSelection {
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  return {
    count: picked.size,
    ids: [...picked.keys()],
    names: picked,
    has: (id) => picked.has(id),
    toggle: (id, name, selected) => {
      setPicked((previous) => {
        const next = new Map(previous);
        if (selected) next.set(id, name);
        else next.delete(id);
        return next;
      });
    },
    clear: () => {
      setPicked(new Map());
    },
  };
}
