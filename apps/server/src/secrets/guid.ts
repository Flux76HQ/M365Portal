// A random version-4 GUID in the canonical lower-case form the `secret` and `certificate` columns
// require (`guid()` check macro). The bytes come from the injected `RandomSource`.
import type { RandomSource } from '../ports/clock.js';

export function randomGuid(random: RandomSource): string {
  const bytes = Uint8Array.from(random.bytes(16));
  if (bytes.length !== 16) throw new Error('the random source returned too few bytes for a GUID');
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
