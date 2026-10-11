// `cn`: join class names and resolve Tailwind conflicts (the last conflicting utility wins), the one
// helper every component uses for `className`. It is the `cn` package (a drop-in for clsx plus
// tailwind-merge) with merge tables compiled for OUR theme (styles/app.css): the default tables know
// only Tailwind's own names, so without this `cn('text-body', 'text-fg')` would drop `text-body` (both
// look like `text-<colour>`) and `cn('shadow-1', 'shadow-2')` would keep both.
//
// The tables are compiled at build time (build/plugins/cn-tables.ts) from the utility names in
// `lib/cn-config.ts` and written to `cn-tables.generated.ts`, so the browser compiles nothing at
// start-up. Add a utility name to the config and the next build regenerates the file; the unit test
// fails until the regenerated file is committed.
import { createCn } from 'cn/engine';
import tables from './cn-tables.generated';

export type { ClassValue } from 'cn';

export const cn = createCn(tables);
