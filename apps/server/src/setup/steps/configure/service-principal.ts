// Sub-action `service_principal` (T-B-133, FR-B-305; plan 9.5): the enterprise application of the
// application. Read `GET /servicePrincipals?$filter=appId eq '<appId>'`; create with `POST
// /servicePrincipals {appId}` only when there is none. A 400 or 404 on the application that was just
// created is replication: the runner waits (the window is 300 seconds) and runs this again from the
// top, which finds the service principal if the first POST had in fact succeeded. The enterprise
// application keeps "assignment required" off (the panel's RBAC is the gate).
import { SetupFailure, type SubActionDefinition } from '../../context.js';
import { ensureResolved, isRecorded, provisionerOf, recordChange } from './common.js';

export const servicePrincipalSubAction: SubActionDefinition = {
  step: 'configure',
  key: 'service_principal',

  async run(ctx) {
    const { services, run } = ctx;
    const provisioner = provisionerOf(ctx);
    await ensureResolved(ctx);
    const connection = services.connections.read(ctx.db);
    const appId = connection?.appId;
    if (appId === null || appId === undefined) throw new SetupFailure('graph_error');

    ctx.log('setup.log.read', { what: 'service_principal' });
    let sp = await provisioner.findServicePrincipalByAppId(appId);
    ctx.checkpoint();
    let op: 'create' | 'adopt' = 'adopt';
    if (sp === null) {
      sp = await provisioner.createServicePrincipal(appId);
      run.markCreated(ctx.now());
      op = 'create';
    }
    const name = sp.displayName ?? run.applicationName;
    const known = isRecorded(ctx, 'service_principal', sp.id);
    recordChange(ctx, {
      kind: 'service_principal',
      tenantObjectId: sp.id,
      appId,
      name,
      origin: 'created',
      op,
      tenantFields: {
        spObjectId: sp.id,
        graphSpId: run.graphSpId ?? null,
        exchangeSpId: run.exchangeSpId ?? null,
        exchangeEnabled: run.exchangeSpId !== undefined,
      },
      hintKey: 'setup.hint.service_principal',
      hintDetail: { name, objectId: sp.id, appId },
      log:
        op === 'create'
          ? { key: 'setup.log.created', params: { kind: 'service_principal', name } }
          : known
            ? { key: 'setup.log.unchanged', params: { kind: 'service_principal' } }
            : { key: 'setup.log.adopted', params: { kind: 'service_principal', name } },
    });
    return {
      status: 'succeeded',
      detail: { name, objectId: sp.id, appId },
      hintKey: 'setup.hint.service_principal',
    };
  },
};
