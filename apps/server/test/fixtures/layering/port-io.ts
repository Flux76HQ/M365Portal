// Negative fixture of server/layering.test.ts: a port that reaches for a module that does I/O.
export const virtualPath = 'ports/rogue.ts';
export const source = `import { readFileSync } from 'node:fs';
export const read = readFileSync;
`;
