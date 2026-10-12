// The administrator-consent link (T-B-188, FR-B-419, EB-28, TB-14; SHOULD): when the first sign-in of a
// person ends in `consent_required` or "need admin approval" (`AADSTS65001`, `AADSTS90093`,
// `AADSTS90094`), the sign-in page shows an administrator the tenant-wide consent URL
//
//   https://login.microsoftonline.com/<tid>/v2.0/adminconsent?client_id=<appId>&scope=openid%20profile&redirect_uri=<registered callback>
//
// the pattern of Learn's add-in consent page
// (https://learn.microsoft.com/office/dev/add-ins/develop/grant-admin-consent-to-an-add-in).
// What it does for OIDC-only scopes is UNVERIFIED (U30; owner-verified OV-12).
//
// The page cannot build the link itself (the sign-in page is public and needs the tenant and
// application ids), so `GET /api/v1/me` carries it as `adminConsentUrl` (TB-14): non-null only when a
// tenant is pinned, built from the pinned tenant id, the application id and the REGISTERED redirect
// URI (the one in the application registration: plain `http://localhost` without a port on localhost),
// all of which every authorize redirect already reveals. The page shows it for the codes of
// `SIGNIN_CONSENT_LINK_CODES` only; no other error gets a link.
import { redirectUris } from '@m365portal/shared/auth/redirect-uri';
import { ENTRA_LOGIN_HOST } from '@m365portal/shared/schemas/auth';
import {
  SIGNIN_CONSENT_LINK_CODES,
  type SigninErrorCode,
} from '@m365portal/shared/auth/signin-errors';
import { readTenantPin, type TenantPin } from '../integrations/tenant-pin.js';
import type { ModuleDeps } from '../module.js';

const ENTRA = `https://${ENTRA_LOGIN_HOST}`;

/** The consent URL of a pinned tenant. `publicBaseUrl` is the configured `PUBLIC_BASE_URL`. */
export function adminConsentUrl(pin: TenantPin, publicBaseUrl: string): string {
  const { callback } = redirectUris(publicBaseUrl);
  return (
    `${ENTRA}/${pin.tenantId}/v2.0/adminconsent` +
    `?client_id=${pin.clientId}&scope=openid%20profile&redirect_uri=${encodeURIComponent(callback)}`
  );
}

/** The link for `MeResponse.adminConsentUrl`: `null` until a tenant is pinned. */
export function adminConsentUrlOf(deps: ModuleDeps): string | null {
  const pin = readTenantPin(deps.database());
  return pin === undefined ? null : adminConsentUrl(pin, deps.config.publicOrigin);
}

/** Does this sign-in error get the consent link? Two codes; the `AADSTS` numbers map onto them. */
export function offersConsentLink(code: SigninErrorCode): boolean {
  return (SIGNIN_CONSENT_LINK_CODES as readonly string[]).includes(code);
}
