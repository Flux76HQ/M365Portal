// Negative fixture of server/layering.test.ts: MSAL on the sign-in path (it adds offline_access,
// caches per account and would be a second assertion signer).
export const virtualPath = 'integrations/identity/token-endpoint.ts';
export const source = `import { ConfidentialClientApplication } from '@azure/msal-node';
export const app = ConfidentialClientApplication;
`;
