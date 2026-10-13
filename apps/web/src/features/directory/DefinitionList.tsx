// A definition list of properties, for the detail pages (FR-C-503): the name of a property is a term, its
// value a definition. Values are text nodes (data from Graph is never markup, FR-C-404). On a narrow screen
// the pairs stack.
import type { ReactNode } from 'react';

export interface DefinitionItem {
  readonly id: string;
  readonly term: string;
  readonly value: ReactNode;
}

export function DefinitionList({ items }: { readonly items: readonly DefinitionItem[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-body sm:grid-cols-[max-content_minmax(0,1fr)]">
      {items.flatMap((item) => [
        <dt key={`${item.id}-term`} className="py-1 font-medium text-fg-secondary">
          {item.term}
        </dt>,
        <dd key={`${item.id}-value`} className="m-0 min-w-0 py-1 break-words text-fg">
          {item.value}
        </dd>,
      ])}
    </dl>
  );
}
