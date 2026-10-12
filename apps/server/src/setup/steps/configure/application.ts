// Sub-action `application` (T-B-133, FR-B-303, FR-B-304, FR-B-318, EB-06, EB-07; plan 9.5).
//
// Read first: the stored object id, then the name (`discovery.ts`). Create only when nothing is found,
// with the desired state of `buildDesiredState` as the request body, field by field. A match that
// carries our install tag is adopted without a question (recorded as `adopt`, the repair of a run that
// died between the call and its transaction); a match without it waits for the operator's
// confirmation. The result is recorded in one transaction after the call returned: the `setup_object`
// row, `tenant_connection.app_object_id` and `app_id`, the rollback hint and the audit entry.
import type { ApplicationCreateBody } from '../../../ports/provisioner.js';
import type { SubActionDefinition } from '../../context.js';
import {
  desiredOf,
  ensureResolved,
  installTagOf,
  isRecorded,
  provisionerOf,
  recordChange,
} from './common.js';
import { discoverApplication } from './discovery.js';

export const applicationSubAction: SubActionDefinition = {
  step: 'configure',
  key: 'application',

  async run(ctx) {
    const { services, run } = ctx;
    const provisioner = provisionerOf(ctx);
    await ensureResolved(ctx);
    const desired = desiredOf(ctx);

    const connection = services.connections.read(ctx.db);
    const recorded = ctx.db.sqlite
      .prepare(
        "SELECT tenant_object_id FROM setup_object WHERE kind = 'application' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { tenant_object_id: string } | undefined;
    const storedObjectId = connection?.appObjectId ?? recorded?.tenant_object_id ?? null;

    ctx.log('setup.log.read', { what: 'application' });
    const found = await discoverApplication({
      provisioner,
      storedObjectId,
      displayName: run.applicationName,
      installTag: installTagOf(ctx),
      bootstrapOid: services.bootstrap.identity()?.oid,
    });
    ctx.checkpoint();

    const done = (id: string, appId: string, name: string) => ({
      status: 'succeeded' as const,
      detail: { name, objectId: id, appId },
      hintKey: 'setup.hint.application' as const,
    });

    if (found.kind === 'stored' || found.kind === 'ours') {
      const { app } = found;
      const name = app.displayName ?? run.applicationName;
      const known = isRecorded(ctx, 'application', app.id);
      recordChange(ctx, {
        kind: 'application',
        tenantObjectId: app.id,
        appId: app.appId,
        name,
        origin: 'created',
        // A recorded object is found again; one the run created before its transaction is adopted.
        op: 'adopt',
        tenantFields: { appObjectId: app.id, appId: app.appId },
        hintKey: 'setup.hint.application',
        hintDetail: { name, objectId: app.id, appId: app.appId },
        log: known
          ? { key: 'setup.log.found', params: { kind: 'application', name } }
          : { key: 'setup.log.adopted', params: { kind: 'application', name } },
      });
      return done(app.id, app.appId, name);
    }

    if (found.kind === 'foreign') {
      const { prompt } = found;
      const adoption = run.adoption;
      const confirmed =
        adoption?.confirmed === true &&
        adoption.prompt.candidate.objectId === prompt.candidate.objectId &&
        (!prompt.requiresAcknowledgement || adoption.acknowledgedForeign);
      if (!confirmed) {
        if (adoption?.prompt.candidate.objectId !== prompt.candidate.objectId) {
          run.adoption = { prompt, confirmed: false, acknowledgedForeign: false };
        }
        ctx.log(
          'setup.log.found',
          { kind: 'application', name: prompt.candidate.displayName },
          'warn',
        );
        return {
          status: 'waiting',
          code: 'application_adoption_required',
          detail: { name: prompt.candidate.displayName, objectId: prompt.candidate.objectId },
        };
      }
      const name = prompt.candidate.displayName;
      recordChange(ctx, {
        kind: 'application',
        tenantObjectId: prompt.candidate.objectId,
        appId: prompt.candidate.appId,
        name,
        origin: 'adopted',
        op: 'adopt',
        confirmed: true,
        tenantFields: { appObjectId: prompt.candidate.objectId, appId: prompt.candidate.appId },
        hintKey: 'setup.hint.application',
        hintDetail: { name, objectId: prompt.candidate.objectId, appId: prompt.candidate.appId },
        log: { key: 'setup.log.adopted', params: { kind: 'application', name } },
      });
      run.adoption = undefined;
      // An adopted application may carry settings we did not choose: the implicit flows go off now
      // (the port cannot read them back, so this is a write, not a repair of seen drift).
      await provisioner.patchApplication(prompt.candidate.objectId, {
        web: {
          redirectUris: [...desired.web.redirectUris],
          implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
        },
      });
      recordChange(ctx, {
        kind: 'application',
        tenantObjectId: prompt.candidate.objectId,
        appId: prompt.candidate.appId,
        name,
        origin: 'adopted',
        op: 'update',
        tenantFields: { redirectUris: [...desired.web.redirectUris] },
      });
      return done(prompt.candidate.objectId, prompt.candidate.appId, name);
    }

    // Nothing found: create it with the desired state.
    const body: ApplicationCreateBody = {
      displayName: desired.displayName,
      description: desired.description,
      signInAudience: desired.signInAudience,
      web: {
        redirectUris: [...desired.web.redirectUris],
        implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
      },
      requiredResourceAccess: desired.requiredResourceAccess.map((resource) => ({
        resourceAppId: resource.resourceAppId,
        resourceAccess: resource.resourceAccess.map((entry) => ({
          id: entry.id,
          type: entry.type,
        })),
      })),
      optionalClaims: {
        idToken: desired.optionalClaims.idToken.map((claim) => ({
          name: claim.name,
          essential: claim.essential,
        })),
      },
      tags: [...desired.tags],
    };
    const created = await provisioner.createApplication(body);
    run.markCreated(ctx.now());
    const name = created.displayName ?? desired.displayName;
    recordChange(ctx, {
      kind: 'application',
      tenantObjectId: created.id,
      appId: created.appId,
      name,
      origin: 'created',
      op: 'create',
      tenantFields: { appObjectId: created.id, appId: created.appId },
      hintKey: 'setup.hint.application',
      hintDetail: { name, objectId: created.id, appId: created.appId },
      log: { key: 'setup.log.created', params: { kind: 'application', name } },
    });
    return done(created.id, created.appId, name);
  },
};
