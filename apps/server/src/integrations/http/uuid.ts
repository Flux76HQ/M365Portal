// The version 4 UUID from the injected `RandomSource` lives with the source (`ports/clock.ts`) so that the
// services can use it too; this module keeps the import path of the clients.
export { uuidV4 } from '../../ports/clock.js';
