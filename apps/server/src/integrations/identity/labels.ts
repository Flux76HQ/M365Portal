// Short display labels taken from identity claims (T-B-076, T-B-078): the user principal name and the
// display name are shown, never trusted (Learn marks `preferred_username` mutable and says it "can't
// be used to make authorization decisions", id-token-claims-reference). A label is a string cut at
// 256 bytes at a character boundary; anything else is `null`.
const LABEL_MAX_BYTES = 256;

export function labelOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let out = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > LABEL_MAX_BYTES) break;
    out += character;
    bytes += size;
  }
  return out;
}
