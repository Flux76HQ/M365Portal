// A client address of its own for every browser context and API client (T-B-370). The sign-in routes
// have a small rate bucket per client (`rateLimit.auth`: 10 tokens, one back every 5 s, SB-28), and an
// e2e run signs in far more often than that from one machine. Instance A therefore trusts one proxy
// hop (`TRUST_PROXY=1`) and every context sends its own `X-Forwarded-For`, so each context is its own
// client, as a person on their own machine would be. Instance B does not trust a proxy (its setup
// routes answer 404 to a forwarded request on purpose, FR-B-201), so it is never sent one.
import { randomInt } from 'node:crypto';

let counter = randomInt(0, 60_000);

/** A private address no other context of this run uses (collisions across processes are 1 in 60,000). */
export function freshClientAddress(): string {
  counter = (counter + 1) % 65_000;
  return `10.${String(1 + (counter >> 8))}.${String(counter & 255)}.${String(1 + randomInt(0, 250))}`;
}
