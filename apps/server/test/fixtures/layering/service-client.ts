// Negative fixture of server/layering.test.ts: a service that builds a concrete Microsoft client
// instead of asking the registry.
export const virtualPath = 'setup/rogue-client.ts';
export const source = `import { createHttpGraphClient } from '../integrations/graph/graph-client.js';
export const client = createHttpGraphClient;
`;
