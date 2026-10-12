// The proof list (T-B-127, T-B-136, FR-B-309, FR-B-319, plan 9.8): `tenant_connection.proof`, a JSON
// object of at most 51,200 bytes, replaced as a whole: `{generatedAt, mode, items:[{key, status, at,
// params}]}`. Params are names, thumbprints and counts, never free text. `ProofSchema` is the
// validator, on the way in and on the way out: a stored value that does not parse reads as "no proof".
import { ProofSchema } from '@m365portal/shared/schemas/connection';
import { PROOF_KEYS } from '@m365portal/shared/schemas/connection';
import type { SetupMode } from '@m365portal/shared/setup/steps';
import type { z } from 'zod';
import type { DatabaseHandle } from '../db/index.js';
import type { Tx } from '../db/tx.js';
import type { TenantConnectionRepository } from './tenant-connection.js';

export type Proof = z.infer<typeof ProofSchema>;
export type ProofItem = Proof['items'][number];
export type ProofKey = (typeof PROOF_KEYS)[number];

export class ProofError extends Error {
  readonly code = 'proof_invalid';

  constructor() {
    super('the proof list is not valid');
    this.name = 'ProofError';
  }
}

/** The stored proof, or `null` when there is none (or the stored text no longer validates). */
export function readProof(connections: TenantConnectionRepository, db: DatabaseHandle): Proof | null {
  const row = connections.read(db);
  if (row === undefined || row.proofText === '' || row.proofText === '{}') return null;
  try {
    const parsed = ProofSchema.safeParse(JSON.parse(row.proofText));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Validate and store a proof list inside the caller's transaction. */
export function writeProof(
  connections: TenantConnectionRepository,
  tx: Tx,
  proof: Proof,
): void {
  const checked = ProofSchema.safeParse(proof);
  if (!checked.success) throw new ProofError();
  connections.writeProofText(tx, JSON.stringify(checked.data));
}

/**
 * Merge `items` into `existing`: an item replaces the one with the same key, the others stay, and the
 * result is in `PROOF_KEYS` order. A re-verification from Settings replaces the app-only items and
 * keeps the delegated ones.
 */
export function mergeProof(
  existing: Proof | null,
  items: readonly ProofItem[],
  meta: { readonly generatedAt: string; readonly mode: SetupMode },
): Proof {
  const byKey = new Map<ProofKey, ProofItem>();
  for (const item of existing?.items ?? []) byKey.set(item.key, item);
  for (const item of items) byKey.set(item.key, item);
  return {
    generatedAt: meta.generatedAt,
    mode: meta.mode,
    items: PROOF_KEYS.flatMap((key) => {
      const item = byKey.get(key);
      return item === undefined ? [] : [item];
    }),
  };
}

export function proofItem(
  key: ProofKey,
  status: ProofItem['status'],
  at: string | null,
  params: ProofItem['params'] = {},
): ProofItem {
  return { key, status, at, params };
}
