// A version 4 UUID from the injected `RandomSource`, for the `client-request-id` header. Ids of this
// kind go through `RandomSource` (PB-20); `crypto.randomUUID` is not used under `integrations/`.
import type { RandomSource } from '../../ports/clock.js';

export function uuidV4(random: RandomSource): string {
  const bytes = random.bytes(16);
  if (bytes.length !== 16) throw new RangeError('a UUID needs 16 random bytes');
  // The bytes are shaped by value: `& 0x0f | 0x40` is the version, `& 0x3f | 0x80` the variant.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
