// The one production source of randomness (PB-20, T-B-022): bytes from `node:crypto`, and a float in
// `[0, 1)` for jitter (never a secret). The composition root passes it to every module as
// `ModuleDeps.random` and the CLI uses it for salts and keys; a test passes a seeded source instead.
// It lives in a file of its own so that the command line does not load the HTTP application.
import { randomBytes, randomInt } from 'node:crypto';
import type { RandomSource } from './ports/clock.js';

export const systemRandom: RandomSource = {
  bytes: (length) => new Uint8Array(randomBytes(length)),
  float: () => randomInt(0, 2 ** 30) / 2 ** 30,
};
