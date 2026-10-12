// The bootstrap authenticator: the device code flow through MSAL Node (T-B-076, FR-B-214 client half,
// FR-B-215 object, EB-03 part, plan 8.6.2; V-B04, V-B13).
//
// The administrator signs in on a Microsoft page with a code (Learn,
// https://learn.microsoft.com/entra/identity-platform/v2-oauth2-device-code); this object polls for
// the result through `PublicClientApplication.acquireTokenByDeviceCode` and then holds the delegated
// token the wizard's Graph calls need. It is the SINGLE HOLDER of Microsoft bootstrap tokens
// (`T-B-131` proves the lifetime): `discard()` clears the MSAL cache, drops the account and the
// callbacks and is idempotent, and `bearer()` fails with `NotConnectedError` before the sign-in and
// after the discard.
//
// Rules this file keeps (FR-B-214):
//   - one `PublicClientApplication` per attempt, client id `BOOTSTRAP_CLIENT_ID`, authority
//     `https://login.microsoftonline.com/<tenant hint or organizations>`, never `common` or `consumers`;
//     the hint is a tenant id or a domain, checked by `tenantHint` (FR-B-317) before any request;
//   - no cache plugin: the tokens, and the refresh token MSAL adds with `offline_access`, live in the
//     in-memory cache of this attempt only (V-B04: MSAL adds `openid`, `profile`, `offline_access`);
//   - exactly the scopes of `BOOTSTRAP_SCOPES`;
//   - the `message` text of the device code response is never forwarded; the verification link is
//     forwarded only when it is https on an allow-listed Microsoft host (an empty string otherwise),
//     because the host Entra uses is only observed (U43);
//   - cancelling sets `cancel = true` on the request MSAL polls with;
//   - every request goes through `JsonFetch` (msal-network.ts), which also adapts `slow_down`.
import { isAllowedVerificationUri } from '@m365portal/shared/setup/steps';
import { BOOTSTRAP_SCOPES } from '@m365portal/shared/setup/graph-roles';
import { mapMicrosoftError } from '@m365portal/shared/auth/aadsts-map';
import {
  LogLevel,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type DeviceCodeRequest,
} from '@azure/msal-node';
import type { Clock, Scheduler } from '../../ports/clock.js';
import { DeviceCodeError, NotConnectedError, type DeviceCodeKind } from '../../ports/errors.js';
import type {
  BootstrapAuthenticator,
  BootstrapIdentity,
  DeviceCodeInfo,
} from '../../ports/identity.js';
import type { BearerTokenProvider } from '../../ports/provisioner.js';
import type { JsonFetch } from '../http/json-fetch.js';
import { MICROSOFT_ORIGINS, isGuid, tenantHint } from '../http/url-guard.js';
import type { IdentityLog } from './http.js';
import { labelOf } from './labels.js';
import { msalErrorFields } from './msal-error.js';
import { createMsalNetworkClient } from './msal-network.js';

export interface BootstrapDeps {
  /** `BOOTSTRAP_CLIENT_ID`. */
  readonly clientId: string;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  /** Every MSAL request goes through this wrapper. */
  readonly jsonFetch: JsonFetch;
  readonly log?: Pick<IdentityLog, 'warn'>;
}

interface Attempt {
  readonly app: PublicClientApplication;
  readonly request: DeviceCodeRequest;
  completion: Promise<BootstrapIdentity>;
  account: AccountInfo | undefined;
  cancelled: boolean;
  /** The AADSTS number of the last refused poll: MSAL's error does not keep it. */
  pollAadsts: number | undefined;
}

const USER_CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** Which `DeviceCodeKind` an MSAL failure is (Learn lists the polling errors). */
function kindOf(
  failure: unknown,
  cancelled: boolean,
  pollAadsts: number | undefined,
): { kind: DeviceCodeKind; aadsts?: number } {
  const fields = msalErrorFields(failure);
  const { code, sub } = fields;
  const aadsts = fields.aadsts ?? pollAadsts;
  const aadstsPart = aadsts === undefined ? {} : { aadsts };
  if (cancelled || code === 'device_code_polling_cancelled' || code === 'user_canceled') {
    return { kind: 'cancelled' };
  }
  const error = sub === '' ? code : sub;
  if (code === 'device_code_expired' || error === 'expired_token') return { kind: 'expired' };
  if (error === 'authorization_declined') return { kind: 'declined' };
  if (error === 'bad_verification_code') return { kind: 'bad_code' };
  const byNumber =
    aadsts === undefined
      ? 'unknown'
      : mapMicrosoftError({ errorDescription: `AADSTS${String(aadsts)}` }).reason;
  // A Conditional Access block is recognised by its number (AADSTS53003, from the description the
  // network client reads) or, failing that, by `access_denied` (U61).
  if (error === 'access_denied' || byNumber === 'conditional_access_blocked') {
    return { kind: 'blocked', ...aadstsPart };
  }
  return { kind: 'failed', ...aadstsPart };
}

function identityOf(result: AuthenticationResult): BootstrapIdentity {
  const claims = result.idTokenClaims as Record<string, unknown>;
  const { account } = result;
  const tid = (account === null ? result.tenantId : account.tenantId).toLowerCase();
  const oidSource = typeof claims.oid === 'string' ? claims.oid : account?.localAccountId;
  const oid = typeof oidSource === 'string' ? oidSource.toLowerCase() : '';
  if (!isGuid(tid) || !isGuid(oid)) throw new DeviceCodeError({ kind: 'failed' });
  return {
    tid,
    oid,
    upnLabel: labelOf(claims.preferred_username),
    nameLabel: labelOf(claims.name),
  };
}

export function createBootstrapAuthenticator(deps: BootstrapDeps): BootstrapAuthenticator {
  let attempt: Attempt | undefined;

  /** Still the current attempt, and signed in. */
  function isLive(target: Attempt): boolean {
    return target === attempt && target.account !== undefined;
  }

  function drop(target: Attempt | undefined): void {
    if (target === undefined) return;
    target.cancelled = true;
    target.request.cancel = true;
    target.request.deviceCodeCallback = () => undefined;
    target.account = undefined;
    target.app.clearCache();
  }

  return {
    async start(options) {
      const hint =
        options.tenantHint === undefined ? 'organizations' : tenantHint(options.tenantHint);
      // A second start is a new attempt: nothing of the earlier one stays reachable.
      drop(attempt);
      attempt = undefined;

      const app = new PublicClientApplication({
        auth: {
          clientId: deps.clientId.toLowerCase(),
          authority: `${MICROSOFT_ORIGINS.login}/${hint}`,
        },
        system: {
          networkClient: createMsalNetworkClient({
            jsonFetch: deps.jsonFetch,
            scheduler: deps.scheduler,
            deviceCodePolling: true,
            onPollError: (refused) => {
              if (attempt?.app === app && refused.aadsts !== null) {
                attempt.pollAadsts = refused.aadsts;
              }
            },
          }),
          loggerOptions: {
            logLevel: LogLevel.Error,
            piiLoggingEnabled: false,
            // Only the level reaches the log: MSAL's message holds Microsoft's free text.
            loggerCallback: (level) => {
              deps.log?.warn({ event: 'msal_error', level }, 'msal_error');
            },
          },
        },
      });

      let announce: (info: DeviceCodeInfo) => void = () => undefined;
      const announced = new Promise<DeviceCodeInfo>((resolve) => {
        announce = resolve;
      });
      const request: DeviceCodeRequest = {
        scopes: [...BOOTSTRAP_SCOPES],
        cancel: false,
        deviceCodeCallback: (response) => {
          // The `message` is dropped here: no text of Microsoft's is forwarded.
          const interval =
            Number.isSafeInteger(response.interval) && response.interval > 0
              ? response.interval
              : 5;
          const allowed = isAllowedVerificationUri(response.verificationUri);
          if (!allowed) {
            deps.log?.warn({ event: 'device_code_uri_rejected' }, 'device_code_uri_rejected');
          }
          announce({
            userCode: response.userCode,
            verificationUri: allowed ? response.verificationUri : '',
            expiresAt: deps.clock.now() + response.expiresIn * 1000,
            intervalSeconds: interval,
          });
        },
      };
      const current: Attempt = {
        app,
        request,
        completion: Promise.resolve({ tid: '', oid: '', upnLabel: null, nameLabel: null }),
        account: undefined,
        cancelled: false,
        pollAadsts: undefined,
      };
      attempt = current;
      current.completion = app.acquireTokenByDeviceCode(request).then(
        (result) => {
          if (result === null) throw new DeviceCodeError({ kind: 'failed' });
          if (current.cancelled) throw new DeviceCodeError({ kind: 'cancelled' });
          current.account = result.account ?? undefined;
          return identityOf(result);
        },
        (failure: unknown) => {
          if (failure instanceof DeviceCodeError) throw failure;
          throw new DeviceCodeError(kindOf(failure, current.cancelled, current.pollAadsts));
        },
      );

      // Whichever comes first: the code to show, or the flow ending before there was one.
      const failedEarly = current.completion.then(
        () => new Promise<never>(() => undefined),
        (failure: unknown) => {
          throw failure;
        },
      );
      const info = await Promise.race([announced, failedEarly]);
      if (!USER_CODE.test(info.userCode)) {
        drop(current);
        throw new DeviceCodeError({ kind: 'failed' });
      }
      return info;
    },

    completion() {
      if (attempt === undefined) return Promise.reject(new NotConnectedError());
      return attempt.completion;
    },

    bearer(): BearerTokenProvider {
      const owner = attempt;
      return async () => {
        if (owner === undefined || !isLive(owner) || owner.account === undefined) {
          throw new NotConnectedError();
        }
        try {
          const result = await owner.app.acquireTokenSilent({
            account: owner.account,
            scopes: [...BOOTSTRAP_SCOPES],
          });
          // `discard()` may have run while the request was out.
          if (!isLive(owner)) throw new NotConnectedError();
          return result.accessToken;
        } catch {
          throw new NotConnectedError();
        }
      };
    },

    cancel() {
      if (attempt === undefined) return;
      attempt.cancelled = true;
      attempt.request.cancel = true;
    },

    discard() {
      const current = attempt;
      attempt = undefined;
      drop(current);
    },
  };
}
