// The one place the bootstrap object lives (T-B-131, FR-B-215, plan 9.12): the device-code
// authenticator, the identity it signed in as, the delegated provisioner built on its bearer and the
// panel the wizard shows while the administrator signs in. All of it is memory: a restart ends it, and
// `discard()` drops every reference after clearing the MSAL cache (idempotent).
//
// The device code itself never leaves this object; the panel carries the user code and, only for an
// allow-listed https link, the verification link (`isAllowedVerificationUri`; the authenticator already
// passes an empty string for a link it does not trust, and that maps to `null`).
import { isAllowedVerificationUri } from '@m365portal/shared/setup/steps';
import type { BootstrapAuthenticator, BootstrapIdentity, DeviceCodeInfo } from '../ports/identity.js';
import type { TenantProvisioner } from '../ports/provisioner.js';
import type { DeviceCodePanel } from './wire.js';

export type PanelState = DeviceCodePanel['state'];

export type DiscardReason =
  | 'audit_reads_done'
  | 'failure'
  | 'cancel'
  | 'timeout'
  | 'session_end'
  | 'exit'
  | 'finish';

export interface BootstrapSlot {
  /** Is there a signed-in bootstrap whose delegated calls can still be made? */
  live(): boolean;
  /** Take over a new authenticator (the previous one, if any, is discarded first). */
  begin(authenticator: BootstrapAuthenticator): void;
  authenticator(): BootstrapAuthenticator | undefined;
  /** The device code was issued. */
  deviceCodeIssued(info: DeviceCodeInfo): void;
  setPanelState(state: PanelState): void;
  signedIn(identity: BootstrapIdentity, provisioner: TenantProvisioner): void;
  identity(): BootstrapIdentity | undefined;
  provisioner(): TenantProvisioner | undefined;
  /** The panel for the wizard, or `null` when no device code is pending or shown. */
  panel(): DeviceCodePanel | null;
  /** Ask a pending device-code acquisition to stop (`cancel = true`). */
  cancelPending(): void;
  /** Drop everything and clear the MSAL cache. Idempotent. */
  discard(reason: DiscardReason): void;
  /** Why the last discard happened (for the logs of the tests; never a secret). */
  lastDiscard(): DiscardReason | undefined;
}

export function createBootstrapSlot(): BootstrapSlot {
  let auth: BootstrapAuthenticator | undefined;
  let who: BootstrapIdentity | undefined;
  let tenantProvisioner: TenantProvisioner | undefined;
  let info: DeviceCodeInfo | undefined;
  let state: PanelState | undefined;
  let reason: DiscardReason | undefined;
  let signedInFlag = false;

  return {
    live: () => auth !== undefined && signedInFlag && tenantProvisioner !== undefined,

    begin(next) {
      if (auth !== undefined) auth.discard();
      auth = next;
      who = undefined;
      tenantProvisioner = undefined;
      info = undefined;
      state = undefined;
      signedInFlag = false;
    },

    authenticator: () => auth,

    deviceCodeIssued(issued) {
      info = issued;
      state = 'waiting_for_user';
    },

    setPanelState(next) {
      state = next;
    },

    signedIn(identity, provisioner) {
      who = identity;
      tenantProvisioner = provisioner;
      signedInFlag = true;
      state = 'signed_in';
    },

    identity: () => who,
    provisioner: () => tenantProvisioner,

    panel() {
      if (info === undefined || state === undefined) return null;
      return {
        userCode: info.userCode,
        verificationUri: isAllowedVerificationUri(info.verificationUri)
          ? info.verificationUri
          : null,
        expiresAt: new Date(info.expiresAt).toISOString(),
        intervalSeconds: info.intervalSeconds,
        state,
      };
    },

    cancelPending() {
      if (auth !== undefined && !signedInFlag) auth.cancel();
    },

    discard(why) {
      const held = auth;
      auth = undefined;
      who = undefined;
      tenantProvisioner = undefined;
      signedInFlag = false;
      // The panel stays readable after an end that the operator should still see (declined, expired).
      if (state === 'signed_in' || state === 'waiting_for_user') state = undefined;
      if (state === undefined) info = undefined;
      reason = why;
      held?.discard();
    },

    lastDiscard: () => reason,
  };
}
