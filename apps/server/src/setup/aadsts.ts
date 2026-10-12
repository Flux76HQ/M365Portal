// The projection of a Microsoft sign-in failure onto the wizard's result codes (T-B-131, FR-B-217,
// TB-05, EB-04, EB-05). `shared/auth/aadsts-map` decides what a Microsoft error MEANS (a closed list of
// reasons); this file decides what the WIZARD says about it. The free text of Microsoft never gets
// here: a `DeviceCodeError` carries a kind and an AADSTS number and nothing else.
//
//   expired, declined, cancelled          device_code_expired, device_code_declined, device_code_cancelled
//   blocked (AADSTS53003)                 device_code_blocked      (offers manual mode; never a custom
//                                                                    BOOTSTRAP_CLIENT_ID as the cure)
//   AADSTS65001                           consent_required
//   AADSTS90093, AADSTS90094              admin_approval_required
//   AADSTS50105                           assignment_required
//   anything else                         bootstrap_failed, with the AADSTS number when there is one
import { AADSTS_NUMBER_REASONS, type AadstsReason } from '@m365portal/shared/auth/aadsts-map';
import type { ResultCode } from '@m365portal/shared/setup/result-codes';
import type { PanelState } from './bootstrap-slot.js';
import type { StepDetail } from './step-repository.js';
import { DeviceCodeError } from '../ports/errors.js';

export interface ConnectFailure {
  readonly code: ResultCode;
  readonly detail: StepDetail;
  /** What the device-code panel shows. */
  readonly panel: PanelState;
}

const BY_REASON: Readonly<Partial<Record<AadstsReason, ResultCode>>> = {
  consent_required: 'consent_required',
  admin_approval_required: 'admin_approval_required',
  assignment_required: 'assignment_required',
  conditional_access_blocked: 'device_code_blocked',
};

/** The result for a failure of the device code flow. */
export function connectFailureOf(error: DeviceCodeError): ConnectFailure {
  const aadsts = error.aadsts;
  const withNumber: StepDetail = aadsts === undefined ? {} : { aadsts };
  switch (error.kind) {
    case 'expired':
      return { code: 'device_code_expired', detail: withNumber, panel: 'expired' };
    case 'declined':
      return { code: 'device_code_declined', detail: withNumber, panel: 'declined' };
    case 'cancelled':
      return { code: 'device_code_cancelled', detail: {}, panel: 'cancelled' };
    case 'blocked':
      return { code: 'device_code_blocked', detail: withNumber, panel: 'blocked' };
    case 'bad_code':
      return { code: 'bootstrap_failed', detail: withNumber, panel: 'expired' };
    case 'failed': {
      const reason = aadsts === undefined ? undefined : AADSTS_NUMBER_REASONS[aadsts];
      const code = (reason === undefined ? undefined : BY_REASON[reason]) ?? 'bootstrap_failed';
      return {
        code,
        detail: withNumber,
        panel: code === 'device_code_blocked' ? 'blocked' : 'expired',
      };
    }
  }
}

/**
 * The connect failures after which the wizard offers the manual provisioning mode (FR-B-218, EB-04):
 * the device code is blocked, or consent or an administrator's approval is needed. A custom
 * `BOOTSTRAP_CLIENT_ID` is never offered as the cure for a block (EB-04).
 */
export const MANUAL_MODE_OFFERED_AFTER: readonly ResultCode[] = Object.freeze([
  'device_code_blocked',
  'consent_required',
  'admin_approval_required',
]);

export function offersManualMode(code: ResultCode | null): boolean {
  return code !== null && MANUAL_MODE_OFFERED_AFTER.includes(code);
}
