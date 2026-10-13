// A section of a detail page with a heading of its own. Each section loads and fails on its own (FR-C-503),
// so a failed members call does not hide the owners.
import { useId, type ReactNode } from 'react';

export function Section({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-subtitle font-semibold text-fg">
        {heading}
      </h2>
      {children}
    </section>
  );
}
