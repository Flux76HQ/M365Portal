// Negative fixture of server/layering.test.ts: jose in the Graph client (token decoding lives in
// integrations/identity/id-token.ts only).
export const virtualPath = 'integrations/graph/rogue-jose.ts';
export const source = `import { decodeJwt } from 'jose';
export const claims = (token: string) => decodeJwt(token);
`;
