// Sub-action `exchange_permissions` (T-B-135, FR-B-308, EB-08; plan 9.5): `Exchange.ManageAsApp` and,
// when the service principal exposes it, `Exchange.ManageAsAppV2`. A tenant without a service principal
// of "Office 365 Exchange Online" ends the sub-action `skipped` with `exchange_service_principal_missing`
// (a warning for the step), `exchange_enabled` stays false and nothing first-party is created.
import { EXCHANGE_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import type { SubActionDefinition } from '../../context.js';
import { ensureResolved } from './common.js';
import { ensureGrants } from './grants.js';

export const exchangePermissionsSubAction: SubActionDefinition = {
  step: 'configure',
  key: 'exchange_permissions',

  async run(ctx) {
    await ensureResolved(ctx);
    const exchangeSpId = ctx.run.exchangeSpId;
    if (exchangeSpId === undefined) {
      ctx.transact(({ tx, services, log }) => {
        services.connections.update(tx, { exchangeEnabled: false, exchangeSpId: null });
        log('setup.log.exchange_skipped');
      });
      return { status: 'skipped', code: 'exchange_service_principal_missing', detail: { exchangeEnabled: false } };
    }
    const wanted = [
      EXCHANGE_APP_ROLES.required,
      ...(ctx.run.roleIds[EXCHANGE_APP_ROLES.whenExposed] === undefined ? [] : [EXCHANGE_APP_ROLES.whenExposed]),
    ];
    const result = await ensureGrants(ctx, { resourceSpId: exchangeSpId, wanted });
    return {
      status: 'succeeded',
      detail: { kind: 'app_role_assignment', count: wanted.length, name: wanted.join(','), exchangeEnabled: true },
      hintKey: 'setup.hint.grants',
      ...(result.extra.length > 0 ? { drift: ['extra_exchange_role'] } : {}),
    };
  },
};
