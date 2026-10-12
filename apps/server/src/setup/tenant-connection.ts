// The `tenant_connection` row (T-B-133 and after, data-model 6): the pinned tenant, the application,
// its service principals, the redirect URIs and the proof list. One row, created by the first step that
// learns an id; `tenant_id` is set once (the trigger forbids changing or deleting it afterwards). Only
// the setup engine and repair write it, always inside the transaction that records the change.
import { eq } from 'drizzle-orm';
import { tenantConnection, type DatabaseHandle } from '../db/index.js';
import type { Tx } from '../db/tx.js';

export interface TenantConnectionRow {
  readonly tenantId: string | null;
  readonly tenantName: string | null;
  readonly initialDomain: string | null;
  readonly appObjectId: string | null;
  readonly appId: string | null;
  readonly spObjectId: string | null;
  readonly graphSpId: string | null;
  readonly exchangeSpId: string | null;
  readonly exchangeEnabled: boolean;
  readonly exchangeRoleTemplateId: string | null;
  readonly permissionSetVersion: number;
  readonly redirectUris: readonly string[];
  readonly certificateId: string | null;
  readonly proofText: string;
  readonly verifiedAt: string | null;
  readonly updatedAt: string;
}

export interface TenantConnectionPatch {
  readonly tenantName?: string | null;
  readonly initialDomain?: string | null;
  readonly appObjectId?: string | null;
  readonly appId?: string | null;
  readonly spObjectId?: string | null;
  readonly graphSpId?: string | null;
  readonly exchangeSpId?: string | null;
  readonly exchangeEnabled?: boolean;
  readonly exchangeRoleTemplateId?: string | null;
  readonly permissionSetVersion?: number;
  readonly redirectUris?: readonly string[];
  readonly certificateId?: string | null;
  readonly verifiedAt?: string | null;
}

interface Raw {
  tenant_id: string | null;
  tenant_name: string | null;
  initial_domain: string | null;
  app_object_id: string | null;
  app_id: string | null;
  sp_object_id: string | null;
  graph_sp_id: string | null;
  exchange_sp_id: string | null;
  exchange_enabled: number;
  exchange_role_template_id: string | null;
  permission_set_version: number;
  redirect_uris: string;
  certificate_id: string | null;
  proof: string;
  verified_at: string | null;
  updated_at: string;
}

export class TenantConnectionRepository {
  readonly #now: () => number;

  constructor(options: { readonly now: () => number }) {
    this.#now = options.now;
  }

  read(db: DatabaseHandle): TenantConnectionRow | undefined {
    const raw = db.sqlite.prepare('SELECT * FROM tenant_connection WHERE id = 1').get() as
      Raw | undefined;
    if (raw === undefined) return undefined;
    return {
      tenantId: raw.tenant_id,
      tenantName: raw.tenant_name,
      initialDomain: raw.initial_domain,
      appObjectId: raw.app_object_id,
      appId: raw.app_id,
      spObjectId: raw.sp_object_id,
      graphSpId: raw.graph_sp_id,
      exchangeSpId: raw.exchange_sp_id,
      exchangeEnabled: raw.exchange_enabled === 1,
      exchangeRoleTemplateId: raw.exchange_role_template_id,
      permissionSetVersion: raw.permission_set_version,
      redirectUris: JSON.parse(raw.redirect_uris) as string[],
      certificateId: raw.certificate_id,
      proofText: raw.proof,
      verifiedAt: raw.verified_at,
      updatedAt: raw.updated_at,
    };
  }

  /** Create the row if there is none. */
  ensure(tx: Tx): void {
    tx.sqlite
      .prepare('INSERT OR IGNORE INTO tenant_connection (id, updated_at) VALUES (1, ?)')
      .run(new Date(this.#now()).toISOString());
  }

  /** Set the given fields (creating the row first). Absent fields stay as they are. */
  update(tx: Tx, patch: TenantConnectionPatch): void {
    this.ensure(tx);
    const values: Partial<typeof tenantConnection.$inferInsert> = {
      updatedAt: new Date(this.#now()).toISOString(),
    };
    for (const key of Object.keys(patch) as (keyof TenantConnectionPatch)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      if (key === 'exchangeEnabled') values.exchangeEnabled = value === true ? 1 : 0;
      else if (key === 'redirectUris') values.redirectUris = JSON.stringify(value);
      else if (key === 'permissionSetVersion') values.permissionSetVersion = Number(value);
      else values[key] = value as string | null;
    }
    tx.orm.update(tenantConnection).set(values).where(eq(tenantConnection.id, 1)).run();
  }

  /** Pin the tenant. The trigger refuses a change of a pinned id; the same id again is a no-op. */
  pinTenant(tx: Tx, tenantId: string): void {
    this.ensure(tx);
    tx.sqlite
      .prepare('UPDATE tenant_connection SET tenant_id = ?, updated_at = ? WHERE id = 1')
      .run(tenantId, new Date(this.#now()).toISOString());
  }

  /** Replace the stored proof list (the caller validated it). */
  writeProofText(tx: Tx, text: string): void {
    this.ensure(tx);
    tx.sqlite
      .prepare('UPDATE tenant_connection SET proof = ?, updated_at = ? WHERE id = 1')
      .run(text, new Date(this.#now()).toISOString());
  }
}
