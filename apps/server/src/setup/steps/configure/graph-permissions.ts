// Sub-action `graph_permissions` (T-B-135, FR-B-301, FR-B-307; plan 9.5): the four application
// permissions on Microsoft Graph, exactly `GRAPH_APP_ROLES`. Forbidden roles are never requested; one
// that is present fails the sub-action.
import { GRAPH_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import { SetupFailure, type SubActionDefinition } from '../../context.js';
import { ensureResolved } from './common.js';
import { ensureGrants } from './grants.js';

export const graphPermissionsSubAction: SubActionDefinition = {
  step: 'configure',
  key: 'graph_permissions',

  async run(ctx) {
    await ensureResolved(ctx);
    const graphSpId = ctx.run.graphSpId;
    if (graphSpId === undefined)
      throw new SetupFailure('app_role_missing', { name: 'Microsoft Graph' });
    const result = await ensureGrants(ctx, { resourceSpId: graphSpId, wanted: GRAPH_APP_ROLES });
    return {
      status: 'succeeded',
      detail: {
        kind: 'app_role_assignment',
        count: GRAPH_APP_ROLES.length,
        name: GRAPH_APP_ROLES.join(','),
      },
      hintKey: 'setup.hint.grants',
      ...(result.extra.length > 0 ? { drift: ['extra_graph_role'] } : {}),
    };
  },
};
