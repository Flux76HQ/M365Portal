// Negative fixture of server/layering.test.ts: @peculiar/x509 outside secrets/x509/.
export const virtualPath = 'secrets/rogue-x509.ts';
export const source = `import * as x509 from '@peculiar/x509';
export const lib = x509;
`;
