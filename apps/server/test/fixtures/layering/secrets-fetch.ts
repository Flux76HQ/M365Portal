// Negative fixture of server/layering.test.ts: secrets/ never talks to the network.
export const virtualPath = 'secrets/rogue-network.ts';
export const source = `export const go = () => globalThis.fetch('https://example.invalid');
export const goDirect = () => fetch('https://example.invalid');
`;
