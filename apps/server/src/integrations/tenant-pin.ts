// The tenant the panel is connected to (T-B-081, FR-B-311): read from the single `tenant_connection`
// row. The runtime clients exist only for a pinned tenant, that is, once the wizard has stored the
// tenant id and the client id of the application it created; before that every client says
// `NotConnectedError`. The row is read per call (it changes while the wizard runs), never cached here.
import type { DatabaseHandle } from '../db/index.js';
import { isGuid } from './http/url-guard.js';

export interface TenantPin {
  /** The tenant id (lower-case GUID). */
  readonly tenantId: string;
  /** The client id of the panel's application (lower-case GUID). */
  readonly clientId: string;
}

export function readTenantPin(database: DatabaseHandle | undefined): TenantPin | undefined {
  if (database === undefined) return undefined;
  try {
    const row = database.sqlite
      .prepare(
        'SELECT tenant_id AS tenantId, app_id AS clientId FROM tenant_connection WHERE id = 1',
      )
      .get() as { tenantId: string | null; clientId: string | null } | undefined;
    if (row === undefined) return undefined;
    const tenantId = row.tenantId?.toLowerCase();
    const clientId = row.clientId?.toLowerCase();
    return isGuid(tenantId) && isGuid(clientId) ? { tenantId, clientId } : undefined;
  } catch {
    // A database that is closing or unreadable is "not connected": the readiness checks say why.
    return undefined;
  }
}

/**
 * The initial (`.onmicrosoft.com`) domain of the pinned tenant, lower-case, as the wizard stored it from
 * `GET /organization`; `undefined` when there is none or the row does not hold a domain name. The Exchange
 * worker connects with it (`Connect-ExchangeOnline -Organization`).
 */
export function readInitialDomain(database: DatabaseHandle | undefined): string | undefined {
  if (database === undefined) return undefined;
  try {
    const row = database.sqlite
      .prepare('SELECT initial_domain AS domain FROM tenant_connection WHERE id = 1')
      .get() as { domain: string | null } | undefined;
    const domain = row?.domain?.trim().toLowerCase();
    return domain !== undefined && /^(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(domain)
      ? domain
      : undefined;
  } catch {
    return undefined;
  }
}
