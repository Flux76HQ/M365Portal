// Starts `audit-worker.ts` in a worker thread. A worker does not inherit the TypeScript support of the
// process that creates it (`--import tsx` in `execArgv` is accepted and does nothing there), so the
// worker registers tsx's module hooks itself before it loads the TypeScript file.
import { register } from 'tsx/esm/api';

register();
await import('./audit-worker.ts');
