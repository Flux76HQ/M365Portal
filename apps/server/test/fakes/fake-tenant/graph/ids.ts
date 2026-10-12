// Deterministic identifiers for the fake directory. A test that creates "the application" gets the
// same object id on every run, so a failure message names the same object each time. The shape is a
// version 4 GUID (the clients validate the shape and nothing else).

/** FNV-1a over the text, as 8 hexadecimal digits. */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** `fakeGuid('application', 3)` is always the same GUID, and differs per namespace and number. */
export function fakeGuid(namespace: string, n: number): string {
  const head = fnv(`${namespace}#head`);
  const mid = fnv(`${namespace}#mid`).slice(0, 4);
  const tail = fnv(`${namespace}#${String(n)}`);
  const tail2 = fnv(`${namespace}#${String(n)}#b`);
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(tail2.slice(0, 1), 16) % 4] ?? '8';
  return `${head}-${mid}-4${tail2.slice(1, 4)}-${variant}${tail2.slice(4, 7)}-${tail}${fnv(`${String(n)}#${namespace}`).slice(0, 4)}`;
}

export function isGuidText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * An opaque id such as Graph gives an app role assignment or a directory role assignment: a base64url
 * string, not a GUID (Learn shows `lAPpYvVpN0KRkAEhdxReEJC2sEqbR_9Hr48lds9SGHI-1` for a role
 * assignment). A client that insists on a GUID for these ids fails against the fake.
 */
export function opaqueId(namespace: string, n: number): string {
  const bytes = Buffer.alloc(32);
  for (let index = 0; index < 8; index += 1) {
    bytes.write(fnv(`${namespace}#${String(n)}#${String(index)}`), index * 4, 'hex');
  }
  return bytes.toString('base64url');
}
