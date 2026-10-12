// Negative fixture of server/layering.test.ts: a service that opens its own connection.
export const virtualPath = 'setup/rogue-service.ts';
export const source = `import https from 'node:https';
export function ping(): void {
  https.get('https://graph.microsoft.com/v1.0/organization');
}
`;
