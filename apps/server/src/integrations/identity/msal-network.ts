// The network client MSAL uses (T-B-075, T-B-076): requests go through `JsonFetch`, the one wrapper
// that calls `fetch`, so every MSAL request has the same rules as the rest of the product: the fixed
// login origin, `redirect: 'error'`, a timeout on the injected scheduler, JSON answers only, no
// `Origin` header and no header that is not on the allow-list (MSAL's telemetry headers are dropped).
// Learn rejects client credentials that arrive with an `Origin` header
// (https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow).
//
// The device code poll is adapted for what MSAL 7.0.1 does not do (V-B04: any answer but
// `authorization_pending` ends the poll with an error):
//   - `slow_down` (RFC 8628 section 3.5; undocumented on the Entra page, U22) is turned into
//     `authorization_pending` and every later poll waits 5 seconds longer than MSAL's interval;
//   - `temporarily_unavailable` is turned into `authorization_pending` (Learn: retry after a delay).
// MSAL's own deadline (`expires_in`) still ends the flow, so neither can loop forever.
//
// Two gaps of MSAL 7.0.1 are closed here as well, because the wizard has to tell a Conditional Access
// block from a typo (FR-B-217):
//   - the device code request is not checked by MSAL: an error answer (`{"error": ...}`) would reach
//     the callback as a response with undefined fields and the poll would start with
//     `device_code=undefined`. A refused request is thrown here as an `AuthError` whose code is the
//     OAuth error string and whose message starts `Error(s): <AADSTS number>` (the form `ServerError`
//     has), so it ends the flow at once with the number;
//   - a failed poll keeps only the OAuth error string in MSAL's error, not the description, so the
//     AADSTS number of the last refused poll is reported to `onPollError`.
import { extractAadsts } from '@m365portal/shared/auth/aadsts-map';
import { AuthError, type INetworkModule, type NetworkRequestOptions } from '@azure/msal-node';
import type { Scheduler } from '../../ports/clock.js';
import type { JsonFetch } from '../http/json-fetch.js';

const TIMEOUT_MS = 10_000;
/** RFC 8628 section 3.5: "increase the interval by 5 seconds". */
const SLOW_DOWN_STEP_MS = 5_000;
const DEVICE_GRANTS = new Set(['device_code', 'urn:ietf:params:oauth:grant-type:device_code']);

export interface MsalNetworkOptions {
  readonly jsonFetch: JsonFetch;
  readonly scheduler: Scheduler;
  /** Adapt the answers of the device code flow (the bootstrap only). */
  readonly deviceCodePolling?: boolean;
  /** Told the OAuth error and the AADSTS number of every refused poll (never the description). */
  readonly onPollError?: (error: {
    readonly error: string;
    readonly aadsts: number | null;
  }) => void;
}

const WORD = /^[a-z][a-z_]{0,63}$/;

/** `{error, aadsts}` of a JSON error answer; the description is read for its leading number only. */
function errorOf(body: unknown): { error: string; aadsts: number | null } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const fields = body as { error?: unknown; error_description?: unknown };
  if (typeof fields.error !== 'string') return undefined;
  return {
    error: WORD.test(fields.error) ? fields.error : 'unknown',
    aadsts: extractAadsts(fields.error_description),
  };
}

export function createMsalNetworkClient(options: MsalNetworkOptions): INetworkModule {
  let extraWaitMs = 0;

  function pause(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      options.scheduler.setTimeout(resolve, milliseconds);
    });
  }

  function formOf(body: string | undefined): Record<string, string> | undefined {
    if (body === undefined) return undefined;
    return Object.fromEntries(new URLSearchParams(body).entries());
  }

  async function send(
    method: 'GET' | 'POST',
    url: string,
    request: NetworkRequestOptions | undefined,
  ): Promise<{ headers: Record<string, string>; body: never; status: number }> {
    const form = method === 'POST' ? formOf(request?.body) : undefined;
    const polling = options.deviceCodePolling === true && DEVICE_GRANTS.has(form?.grant_type ?? '');
    if (polling && extraWaitMs > 0) await pause(extraWaitMs);

    const answer = await options.jsonFetch({
      method,
      url,
      timeoutMs: TIMEOUT_MS,
      ...(form === undefined ? {} : { form }),
    });
    let body = answer.body;
    const refused = errorOf(body);
    if (options.deviceCodePolling === true && method === 'POST' && url.includes('/devicecode')) {
      if (answer.status < 200 || answer.status >= 300 || refused !== undefined) {
        const message = refused?.aadsts == null ? '' : `Error(s): ${String(refused.aadsts)}`;
        throw new AuthError(refused?.error ?? 'unknown', '', message);
      }
    }
    if (polling && refused !== undefined) {
      if (refused.error === 'slow_down') {
        extraWaitMs += SLOW_DOWN_STEP_MS;
        body = { error: 'authorization_pending' };
      } else if (refused.error === 'temporarily_unavailable') {
        body = { error: 'authorization_pending' };
      } else if (refused.error !== 'authorization_pending') {
        options.onPollError?.(refused);
      }
    }
    // The body is Microsoft's JSON; MSAL decides what it is. `never` is assignable to its `T`.
    return { headers: {}, body: body as never, status: answer.status };
  }

  return {
    sendGetRequestAsync: (url: string, request?: NetworkRequestOptions) =>
      send('GET', url, request),
    sendPostRequestAsync: (url: string, request?: NetworkRequestOptions) =>
      send('POST', url, request),
  };
}
