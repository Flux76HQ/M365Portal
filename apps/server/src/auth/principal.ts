// The principal and its key (T-B-183, FR-B-406, EB-22). A person is the pair `(tid, oid)` and nothing
// else: `tid` must equal the pinned tenant, `oid` is the object id. `sub` (pairwise per application),
// `email`, `preferred_username`, `upn` and `name` are labels the panel shows and never selects or
// authorises by. A guest of the pinned tenant has a `tid` of that tenant and an `oid` of its own, so
// the guest is an ordinary principal by `oid`; a token of another tenant is refused.
//
// `app_user` holds the last-known labels (cut at 256 bytes, the `CHECK` of the table) and the time of
// the last sign-in. It is written by `upsertAppUser` inside the sign-in transaction, so a sign-in
// that fails leaves no row behind. Nothing in this folder or any other selects a user by a label; the
// scan in `test/auth/identity-key.test.ts` keeps it so.
import { appUser } from '../db/index.js';
import type { Tx } from '../db/tx.js';
import type { ValidatedIdToken } from '../ports/identity.js';

/** The label limit in bytes: `app_user_labels` in the migration. */
const LABEL_MAX_BYTES = 256;

export interface PrincipalKey {
  /** Tenant id, lower case. */
  readonly tid: string;
  /** Object id, lower case; empty only for a break-glass principal. */
  readonly oid: string;
}

export type PrincipalResult =
  | { readonly ok: true; readonly key: PrincipalKey }
  | { readonly ok: false; readonly reason: 'tenant_mismatch' };

/** The canonical string of a principal key: lower case `tid/oid`. The one spelling used as a map key. */
export function identityKey(tid: string, oid: string): string {
  return `${tid.toLowerCase()}/${oid.toLowerCase()}`;
}

/** The principal of a validated ID token, or the reason it is not one of this installation. */
export function principalOf(token: ValidatedIdToken, pinnedTenantId: string): PrincipalResult {
  const tid = token.tid.toLowerCase();
  if (tid !== pinnedTenantId.toLowerCase()) return { ok: false, reason: 'tenant_mismatch' };
  return { ok: true, key: { tid, oid: token.oid.toLowerCase() } };
}

/** A label cut at 256 bytes on a character boundary; an empty or absent label is `null`. */
export function labelOf(value: string | null): string | null {
  if (value === null || value === '') return null;
  if (Buffer.byteLength(value, 'utf8') <= LABEL_MAX_BYTES) return value;
  let cut = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > LABEL_MAX_BYTES) break;
    cut += character;
    bytes += size;
  }
  return cut === '' ? null : cut;
}

/**
 * Insert or refresh the `app_user` row of the token's principal: the labels are overwritten at every
 * sign-in, `last_signin_at` moves, `first_seen_at` and `groups_resolved_at` stay. Call it inside the
 * sign-in transaction; the caller has checked the tenant with `principalOf`.
 */
export function upsertAppUser(tx: Tx, token: ValidatedIdToken, nowIso: string): void {
  const upnLabel = labelOf(token.upn);
  const nameLabel = labelOf(token.name);
  tx.orm
    .insert(appUser)
    .values({
      tid: token.tid.toLowerCase(),
      oid: token.oid.toLowerCase(),
      upnLabel,
      nameLabel,
      firstSeenAt: nowIso,
      lastSigninAt: nowIso,
    })
    .onConflictDoUpdate({
      target: [appUser.tid, appUser.oid],
      set: { upnLabel, nameLabel, lastSigninAt: nowIso },
    })
    .run();
}
