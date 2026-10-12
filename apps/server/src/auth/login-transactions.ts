// Login transactions (T-B-182, FR-B-402): the memory of one sign-in between `GET /auth/login` and
// `GET /auth/callback`. A transaction is made of random values only and lives in this process:
//
//   id             256 random bits, the value of the transaction cookie (single use)
//   state, nonce   256 random bits each (the callback compares `state`, the validator checks `nonce`)
//   codeVerifier   256 random bits, 43 base64url characters (PKCE, S256)
//   purpose        `signin` or `stepup`; for step-up the SHA-256 of the session id it belongs to
//   returnTo       already sanitised by `safeReturnTo`
//
// Bounds: 1,000 pending in total and 20 per client address (the oldest is evicted), lifetime 600 s.
// A restart forgets every transaction, which only sends a few people back to the sign-in page.
// Time and randomness are injected; nothing here is logged.
import { LIMITS } from '@m365portal/shared/limits';
import type { LoginPurpose } from '@m365portal/shared/schemas/auth';
import type { Clock, RandomSource } from '../ports/clock.js';
import { newCookieId } from './cookies.js';

export interface LoginTransaction {
  readonly id: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly purpose: LoginPurpose;
  readonly returnTo: string;
  /** Milliseconds since the epoch. */
  readonly startedAt: number;
  /** SHA-256 hex of the session id a step-up belongs to; `null` for a sign-in. */
  readonly stepUpSessionHash: string | null;
  readonly clientKey: string;
}

export interface NewLoginTransaction {
  readonly purpose: LoginPurpose;
  readonly returnTo: string;
  readonly stepUpSessionHash: string | null;
  readonly clientKey: string;
}

export interface LoginTransactions {
  start(input: NewLoginTransaction): LoginTransaction;
  /** Single use: the transaction is removed whatever the answer. `undefined` when unknown or expired. */
  take(id: string): LoginTransaction | undefined;
  /** Drop the expired ones; the number dropped. */
  sweep(): number;
  readonly size: number;
}

export interface LoginTransactionOptions {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly max?: number;
  readonly perClientMax?: number;
  readonly lifetimeMs?: number;
}

export function createLoginTransactions(options: LoginTransactionOptions): LoginTransactions {
  const max = options.max ?? LIMITS.signIn.loginTxMax;
  const perClientMax = options.perClientMax ?? LIMITS.signIn.loginTxPerClientMax;
  const lifetimeMs = options.lifetimeMs ?? LIMITS.signIn.loginTxLifetimeSeconds * 1000;
  // Insertion order is age order: the first entry is the oldest.
  const pending = new Map<string, LoginTransaction>();

  const expired = (transaction: LoginTransaction, now: number): boolean =>
    now - transaction.startedAt >= lifetimeMs;

  function evictOldestOf(clientKey: string | undefined): void {
    for (const [id, transaction] of pending) {
      if (clientKey === undefined || transaction.clientKey === clientKey) {
        pending.delete(id);
        return;
      }
    }
  }

  return {
    start(input) {
      const transaction: LoginTransaction = {
        id: newCookieId(options.random),
        state: newCookieId(options.random),
        nonce: newCookieId(options.random),
        codeVerifier: newCookieId(options.random),
        purpose: input.purpose,
        returnTo: input.returnTo,
        startedAt: options.clock.now(),
        stepUpSessionHash: input.stepUpSessionHash,
        clientKey: input.clientKey,
      };
      let held = 0;
      for (const other of pending.values()) if (other.clientKey === input.clientKey) held += 1;
      for (let over = held - (perClientMax - 1); over > 0; over -= 1) {
        evictOldestOf(input.clientKey);
      }
      while (pending.size >= max) evictOldestOf(undefined);
      pending.set(transaction.id, transaction);
      return transaction;
    },

    take(id) {
      const transaction = pending.get(id);
      if (transaction === undefined) return undefined;
      pending.delete(id);
      return expired(transaction, options.clock.now()) ? undefined : transaction;
    },

    sweep() {
      const now = options.clock.now();
      let dropped = 0;
      for (const [id, transaction] of pending) {
        if (expired(transaction, now)) {
          pending.delete(id);
          dropped += 1;
        }
      }
      return dropped;
    },

    get size() {
      return pending.size;
    },
  };
}
