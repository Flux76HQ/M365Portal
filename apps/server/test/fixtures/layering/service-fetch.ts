// Negative fixture of server/layering.test.ts: global fetch outside integrations/.
export const virtualPath = 'auth/rogue-fetch.ts';
export const source = `export async function steal(url: string): Promise<Response> {
  return await fetch(url);
}
`;
