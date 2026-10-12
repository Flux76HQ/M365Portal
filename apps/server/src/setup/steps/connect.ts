// Step 2, the device-code bootstrap (T-B-131, FR-B-214 to FR-B-217, EB-03 to EB-05, plan 8.6, 9.4).
//
// `device_code`: ask Entra for a device code (authority: the tenant hint or `organizations`, never
// `common`; exactly the three bootstrap scopes), show the user code and the allow-listed link, wait for
// the administrator to sign in, and keep the signed-in bootstrap object in the engine's slot. Then:
//
//   - tenant pin (FR-B-216): a pinned tenant must be the tenant of this sign-in, otherwise the step
//     ends `tenant_mismatch` and the bootstrap object is discarded; the tenant of the first sign-in is
//     stored as the PROPOSED tenant and becomes the pinned one only after verification V2;
//   - the first delegated call (the Graph service principal, which every later step needs anyway): a
//     403 means the account lacks the roles the scopes need (`bootstrap_role_insufficient`, EB-05);
//   - the signed-in identity becomes the designated first Owner while the wizard is open (`oid` plus
//     `tid`, never `sub`).
//
// No token is ever kept here: the authenticator is the single holder (FR-B-215) and the slot drops it
// on every end condition.
import { GRAPH_RESOURCE_APP_ID } from '@m365portal/shared/setup/graph-roles';
import { DeviceCodeError, GraphForbiddenError, GraphUnauthorizedError } from '../../ports/errors.js';
import { connectFailureOf } from '../aadsts.js';
import { auditTenantPin } from '../audit.js';
import { SetupFailure, type SubActionDefinition } from '../context.js';

export const deviceCodeSubAction: SubActionDefinition = {
  step: 'connect',
  key: 'device_code',

  async run(ctx) {
    const { services, run } = ctx;
    const slot = services.bootstrap;
    const clients = services.deps.clients;

    // A bootstrap that is already signed in is reused (a reconcile run that follows a connect).
    if (slot.live() && slot.identity() !== undefined) {
      return { status: 'succeeded', detail: {} };
    }

    ctx.checkpoint();
    const authenticator = clients.createBootstrap();
    slot.begin(authenticator);

    const fail = (error: DeviceCodeError): never => {
      const failure = connectFailureOf(error);
      slot.setPanelState(failure.panel);
      slot.discard('failure');
      // A cancel that the operator asked for is a cancelled run, not a failed step.
      ctx.checkpoint();
      throw new SetupFailure(failure.code, failure.detail);
    };

    let info;
    try {
      info = await authenticator.start(run.tenantHint === undefined ? {} : { tenantHint: run.tenantHint });
    } catch (error) {
      if (error instanceof DeviceCodeError) return fail(error);
      slot.discard('failure');
      throw error;
    }
    slot.deviceCodeIssued(info);
    ctx.log('setup.log.bootstrap_waiting', {
      seconds: Math.max(0, Math.round((info.expiresAt - ctx.now()) / 1000)),
    });

    let identity;
    try {
      const completion = authenticator.completion();
      // MSAL notices a cancel at its next poll; the operator should not have to wait for that.
      completion.catch(() => undefined);
      const winner = await Promise.race([
        completion.then((value) => ({ value })),
        run.cancellation.then(() => 'cancelled' as const),
      ]);
      if (winner === 'cancelled') {
        authenticator.cancel();
        slot.discard('cancel');
        ctx.checkpoint();
        throw new SetupFailure('device_code_cancelled');
      }
      identity = winner.value;
    } catch (error) {
      if (error instanceof DeviceCodeError) return fail(error);
      if (!(error instanceof SetupFailure)) slot.discard('failure');
      throw error;
    }
    ctx.checkpoint();

    // The pinned tenant, or the tenant an earlier sign-in of this install already created objects in.
    const connection = services.connections.read(ctx.db);
    const proposed = services.state.read(ctx.db).proposedTenantId;
    const mismatch =
      (connection?.tenantId != null && connection.tenantId !== identity.tid) ||
      (connection?.appObjectId != null && proposed !== null && proposed !== identity.tid);
    if (mismatch) {
      slot.discard('failure');
      if (run.actor.kind === 'setup') {
        ctx.transact(({ tx }) => {
          auditTenantPin(tx, {
            now: ctx.now(),
            tenantId: identity.tid,
            mode: ctx.mode,
            outcome: 'rejected',
          });
        });
      }
      throw new SetupFailure('tenant_mismatch');
    }

    const provisioner = await clients.provisionerFactory()(authenticator);
    slot.signedIn(identity, provisioner);

    // The first delegated call: a refusal means the account does not hold the roles the scopes need.
    try {
      await provisioner.findServicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
    } catch (error) {
      if (error instanceof GraphForbiddenError || error instanceof GraphUnauthorizedError) {
        slot.discard('failure');
        throw new SetupFailure('bootstrap_role_insufficient');
      }
      throw error;
    }

    const state = services.state.read(ctx.db);
    ctx.transact(({ tx, services: s, log }) => {
      if (state.state === 'in_progress' && connection?.tenantId == null) {
        s.state.setProposedTenant(tx, identity.tid);
        s.state.setDesignatedOwner(tx, identity.oid);
      }
      log('setup.log.bootstrap_signed_in');
    });
    return { status: 'succeeded', detail: { tenantId: identity.tid } };
  },
};
