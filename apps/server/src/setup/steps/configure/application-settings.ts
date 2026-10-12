// Sub-action `application_settings` (T-B-133, FR-B-303, FR-B-220; plan 9.5): compare the application
// with the desired state member by member and patch only what drifted. Read first:
// `GET /applications/{id}?$select=signInAudience,web,optionalClaims,requiredResourceAccess,tags,...`.
// A clean application costs no write. The redirect URIs and the permission-set version are stored in
// `tenant_connection` on every pass, so Settings, Connection shows what the application holds.
//
// The port does not show `web.implicitGrantSettings` or `isFallbackPublicClient`, so drift in those two
// cannot be seen here (open point, FR-B-309 V4): the `application` sub-action sets the implicit flags
// off when it adopts a foreign application, and every patch of the `web` member sends them off again.
// Our own tag is added to the tags an application already had.
import { PERMISSION_SET_VERSION } from '@m365portal/shared/setup/graph-roles';
import type { ApplicationInfo, ApplicationPatch } from '../../../ports/provisioner.js';
import { SetupFailure, type SubActionDefinition } from '../../context.js';
import { desiredOf, ensureResolved, provisionerOf, recordChange } from './common.js';

function isAdopted(ctx: Parameters<SubActionDefinition['run']>[0], objectId: string): boolean {
  return (
    (
      ctx.db.sqlite
        .prepare(
          "SELECT origin FROM setup_object WHERE kind = 'application' AND tenant_object_id = ?",
        )
        .get(objectId) as { origin: string } | undefined
    )?.origin === 'adopted'
  );
}

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  new Set(left).size === new Set(right).size &&
  left.every((item) => right.includes(item));

function accessKeys(
  list:
    | ApplicationInfo['requiredResourceAccess']
    | readonly {
        resourceAppId: string;
        resourceAccess: readonly { id: string; type: string | null }[];
      }[],
): string[] {
  return (list ?? []).flatMap((resource) =>
    resource.resourceAccess.map(
      (entry) => `${resource.resourceAppId}:${entry.id}:${entry.type ?? 'Role'}`,
    ),
  );
}

export const applicationSettingsSubAction: SubActionDefinition = {
  step: 'configure',
  key: 'application_settings',

  async run(ctx) {
    const { services } = ctx;
    const provisioner = provisionerOf(ctx);
    await ensureResolved(ctx);
    const desired = desiredOf(ctx);
    const connection = services.connections.read(ctx.db);
    const objectId = connection?.appObjectId;
    if (objectId === null || objectId === undefined) throw new SetupFailure('graph_error');

    ctx.log('setup.log.read', { what: 'application_settings' });
    const app = await provisioner.getApplication(objectId);
    if (app === null) throw new SetupFailure('graph_error');
    ctx.checkpoint();

    const drift: string[] = [];
    const patch: {
      -readonly [K in keyof ApplicationPatch]: ApplicationPatch[K];
    } = {};
    if (app.signInAudience !== desired.signInAudience) drift.push('sign_in_audience');
    const uris = app.redirectUris ?? [];
    if (!sameSet(uris, desired.web.redirectUris)) {
      drift.push('redirect_uris');
      patch.web = {
        redirectUris: [...desired.web.redirectUris],
        implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
      };
    }
    if (!desired.tags.every((tag) => app.tags?.includes(tag) === true)) {
      drift.push('tags');
      patch.tags = [...new Set([...(app.tags ?? []), ...desired.tags])];
    }
    if (
      !sameSet(accessKeys(app.requiredResourceAccess), accessKeys(desired.requiredResourceAccess))
    ) {
      drift.push('required_resource_access');
      patch.requiredResourceAccess = desired.requiredResourceAccess.map((resource) => ({
        resourceAppId: resource.resourceAppId,
        resourceAccess: resource.resourceAccess.map((entry) => ({
          id: entry.id,
          type: entry.type,
        })),
      }));
    }
    const claims = app.optionalClaims?.idToken ?? [];
    const claimsOk = desired.optionalClaims.idToken.every((wanted) =>
      claims.some((claim) => claim.name === wanted.name && claim.essential !== true),
    );
    if (!claimsOk) {
      drift.push('optional_claims');
      patch.optionalClaims = {
        idToken: desired.optionalClaims.idToken.map((claim) => ({
          name: claim.name,
          essential: claim.essential,
        })),
      };
    }
    if (app.signInAudience !== desired.signInAudience) {
      // The audience cannot be repaired by a patch we are willing to send: a personal-account audience
      // is refused outright (FR-B-303). Reported as drift; the patch below carries no audience.
    }

    const tenantFields = {
      redirectUris: [...desired.web.redirectUris],
      permissionSetVersion: PERMISSION_SET_VERSION,
    };
    if (drift.length === 0) {
      ctx.transact(({ tx, services: s, log }) => {
        s.connections.update(tx, tenantFields);
        log('setup.log.unchanged', { kind: 'application' });
      });
      return { status: 'succeeded', detail: { name: app.displayName ?? '', objectId } };
    }

    await provisioner.patchApplication(objectId, patch);
    ctx.checkpoint();
    const name = app.displayName ?? ctx.run.applicationName;
    recordChange(ctx, {
      kind: 'application',
      tenantObjectId: objectId,
      appId: app.appId,
      name,
      origin: isAdopted(ctx, objectId) ? 'adopted' : 'created',
      op: 'update',
      tenantFields,
      log: { key: 'setup.log.drift_found', params: { kind: 'application' } },
    });
    return { status: 'succeeded', detail: { name, objectId }, drift };
  },
};
