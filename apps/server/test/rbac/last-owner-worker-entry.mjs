// Starts `last-owner-worker.ts` in a worker thread (a worker does not inherit the TypeScript support of
// the process that creates it, so it registers tsx's module hooks itself).
import { register } from 'tsx/esm/api';

register();
await import('./last-owner-worker.ts');
