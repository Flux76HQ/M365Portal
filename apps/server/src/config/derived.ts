// Values computed from the configuration once, so that no other file converts a unit or builds a
// redirect URI on its own (FR-B-103, FR-B-407, tasks.md T-B-009):
//   - every duration the operator sets is converted to milliseconds here and nowhere else;
//   - the redirect URIs come from `@m365portal/shared/auth/redirect-uri`, the one module that builds
//     them (FR-B-713).
import {
  authorizeRedirectUri,
  postLogoutRedirectUri,
  redirectUris,
} from '@m365portal/shared/auth/redirect-uri';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export interface DerivedDurations {
  readonly setup: { readonly propagationTimeoutMs: number };
  readonly session: { readonly idleTimeoutMs: number; readonly absoluteTimeoutMs: number };
  readonly rbac: { readonly groupCacheTtlMs: number };
}

export interface DurationSettings {
  readonly setupPropagationTimeoutSeconds: number;
  readonly sessionIdleTimeoutMinutes: number;
  readonly sessionAbsoluteTimeoutHours: number;
  readonly groupCacheTtlSeconds: number;
}

/** The operator's durations, in milliseconds. */
export function deriveDurations(settings: DurationSettings): DerivedDurations {
  return {
    setup: { propagationTimeoutMs: settings.setupPropagationTimeoutSeconds * SECOND_MS },
    session: {
      idleTimeoutMs: settings.sessionIdleTimeoutMinutes * MINUTE_MS,
      absoluteTimeoutMs: settings.sessionAbsoluteTimeoutHours * HOUR_MS,
    },
    rbac: { groupCacheTtlMs: settings.groupCacheTtlSeconds * SECOND_MS },
  };
}

export interface DerivedRedirects {
  /** The two URIs to register on the application. */
  readonly redirectUris: { readonly callback: string; readonly loggedOut: string };
  /** The `redirect_uri` of authorize and token requests. */
  readonly authorizeRedirectUri: string;
  /** The `post_logout_redirect_uri` of sign-out requests. */
  readonly postLogoutRedirectUri: string;
}

/** The redirect URIs of a base URL that `parsePublicBaseUrl` has already accepted. */
export function deriveRedirects(publicBaseUrl: string): DerivedRedirects {
  return {
    redirectUris: redirectUris(publicBaseUrl),
    authorizeRedirectUri: authorizeRedirectUri(publicBaseUrl),
    postLogoutRedirectUri: postLogoutRedirectUri(publicBaseUrl),
  };
}
