// Tenant pinning (T-B-136, FR-B-216, FR-B-309 V2, EB-36, I-B7; plan 9.8): the tenant a bootstrap
// sign-in names is only PROPOSED (`setup_state.proposed_tenant_id`) until the app-only
// `GET /organization` confirms it: the single item it returns has an `id` equal to the proposal. Only
// then, in one transaction with the display name, the `isInitial` domain, the verification time and the
// audit entry `setup.tenant.pin`, is it stored as `tenant_connection.tenant_id`. The trigger of the
// database forbids changing or deleting it afterwards. A repair run compares and never changes.
import { withTransaction } from '../db/index.js';
import type { OrganizationInfo } from '../ports/graph.js';
import { auditTenantPin } from './audit.js';
import type { SetupServices } from './context.js';

export type PinOutcome =
  | { readonly kind: 'pinned' }
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'mismatch'; readonly reason: 'organization_mismatch' | 'tenant_mismatch' };

/**
 * Confirm the proposed tenant against the organization the app-only token sees. `pin` is false when
 * the caller only compares (re-verification from Settings, repair). Does not call Microsoft.
 */
export function confirmTenant(
  services: SetupServices,
  organization: OrganizationInfo,
  options: { readonly pin: boolean },
): PinOutcome {
  const { deps } = services;
  const db = deps.requireDatabase();
  const state = services.state.read(db);
  const connection = services.connections.read(db);
  const seen = organization.id.toLowerCase();

  if (connection?.tenantId != null) {
    return connection.tenantId === seen
      ? { kind: 'confirmed' }
      : { kind: 'mismatch', reason: 'tenant_mismatch' };
  }
  const proposed = state.proposedTenantId;
  if (proposed === null || proposed !== seen) {
    withTransaction(db, (tx) => {
      auditTenantPin(tx, { now: deps.now(), tenantId: seen, mode: state.mode, outcome: 'rejected' });
    });
    return { kind: 'mismatch', reason: 'organization_mismatch' };
  }
  if (!options.pin) return { kind: 'confirmed' };

  withTransaction(db, (tx) => {
    services.connections.pinTenant(tx, seen);
    services.connections.update(tx, {
      tenantName: organization.displayName?.slice(0, 256) ?? null,
      initialDomain: organization.initialDomain?.slice(0, 256) ?? null,
      verifiedAt: new Date(deps.now()).toISOString(),
    });
    auditTenantPin(tx, { now: deps.now(), tenantId: seen, mode: state.mode, outcome: 'success' });
    services.wizardLog.append(tx, {
      step: 'verify',
      level: 'info',
      messageKey: 'setup.log.tenant_pinned',
      params: {},
    });
  });
  // The runtime clients exist for the pinned tenant from now on.
  deps.clients.reload();
  return { kind: 'pinned' };
}
