# Microsoft Learn research for Phase B

> **Date:** 2026-10-10. **Scope:** every Microsoft claim that Phase B (onboarding wizard, OIDC sign-in and sessions, RBAC foundation) relies on. **Method:** Microsoft Learn only (search, fetch, code-sample search). A page is "read" when it was fetched in full on this date; "snippet" means a search excerpt only; "carried" means it was read for `specs/001-m365portal/research-microsoft.md` (001 research) the same day and not re-read. What Learn does not state is **UNVERIFIED** and listed in section 15 (U18 and up; U1 to U17 stay in the 001 register). This file builds on the 001 research and does not repeat it, except where Phase B needs the exact request shape.

Status legend: **verified** = Learn states it as written. **corrected** = the brief, the 001 research or an earlier assumption is wrong or incomplete; the Learn-backed wording is given. **UNVERIFIED** = not found on Learn.

## Samenvatting (Nederlands)

Alle tien onderdelen zijn tegen Microsoft Learn gecontroleerd. Wat de implementatie mag aannemen:

- **Wizard-aanroepen** (sectie 2 tot 4): `POST /applications` (alleen `displayName` verplicht, maar `signInAudience: "AzureADMyOrg"` expliciet zetten, want de documentatie spreekt zichzelf tegen over de standaard), `POST /servicePrincipals`, certificaat via `PATCH keyCredentials` (publiek deel, geen `customKeyIdentifier` meegeven, maximaal 1 jaar geldig), rollen toekennen met `POST /servicePrincipals/{resource}/appRoleAssignedTo` (rol-id's tijdens runtime opzoeken, niet hardcoden) en de Entra-rol met `POST /roleManagement/directory/roleAssignments`. Een zelfondertekend certificaat wordt geaccepteerd (Learn raadt het wel af).
- **Device code** (sectie 5): `Directory.Read.All` is niet nodig; drie scopes volstaan. Microsoft maakt tenants een beheerd Conditional Access-beleid "Block device code flow" (eerst report-only, na minimaal 30 dagen aan). Dat beleid blokkeert de *stroom*, ongeacht welke client: `BOOTSTRAP_CLIENT_ID` helpt daar dus niet tegen. Het reservepad is een handmatige modus (sectie 16, B4).
- **Aanmelden** (sectie 6 en 7): auth code + PKCE, certificaat-assertion `PS256` met `x5t#S256`, ID-token valideren met `jose`; `amr` is een optionele claim (aanvragen in de app-registratie), MFA = `amr` bevat `mfa`. `acr` bestaat alleen in v1.0-tokens; `ctxt` is op Learn niet te vinden. `response_mode=query` past bij de Lax-statuscookie; `form_post` niet. `max_age` is voor Entra niet gedocumenteerd.
- **Groepen** (sectie 8): geen `groups`-claim vragen; per aanmelding `checkMemberGroups` (maximaal 20 groep-id's per aanroep) met de applicatie-permissies `User.Read.All` + `GroupMember.Read.All`.
- **Exchange** (sectie 9): de Admin API (Preview) kent zes endpoints, uitsluitend `POST`, en dekt geen distributielijst-beheer of contacten. Voor fase D is `pwsh` met de ExchangeOnlineManagement-module het enige gedocumenteerde pad; Linux-ondersteuning staat alleen voor Ubuntu LTS. `InvokeCommand` staat nergens op Learn.
- **Voortplanting** (sectie 10): Learn noemt geen vertraging voor Entra-rol naar Exchange. Strategie: nieuw token per poging (`skipCache`), exponentiële backoff met jitter, begrensd venster, meten bij de eigenaar.
- **Eigenaarsbeslissingen B1 tot en met B5** staan in sectie 16 met een aanbeveling per punt. Alles wat alleen tegen een echte tenant te bewijzen is, staat in sectie 14 als *owner-verified*.

## 1. Results at a glance

| # | Item | Status | What changes for the design |
|---|---|---|---|
| 1 | App registration with Graph | verified, 4 corrections | Set `signInAudience` explicitly; certificate lifetime at most 1 year; leave `customKeyIdentifier` unset; `http://localhost` only, never `127.0.0.1`; idempotent create exists (`uniqueName` upsert). |
| 2 | Admin consent in code | verified | Grant by `appRoleAssignedTo`; look up role ids by resource `appId` at runtime. Takes effect immediately; no review step. |
| 3 | `Exchange.ManageAsApp` and role | verified; propagation UNVERIFIED | Resource `00000002-0000-0ff1-ce00-000000000000`; Admin API needs a *different* app role (`Exchange.ManageAsAppV2`). Retry with a fresh token each time. |
| 4 | Device code flow | verified, 3 corrections | `Directory.Read.All` dropped; `slow_down` not documented for Entra; CA flow block applies to every client; MSAL adds `offline_access` itself. |
| 5 | Confidential-client sign-in | verified, 2 corrections | Use `response_mode=query`; `max_age` not documented; post-logout URI must be a registered redirect URI. |
| 6 | `amr` / `acr` / `xms_cc` / `ctxt` | corrected | `amr` optional claim only; `acr` v1.0 only; `xms_cc` is an access-token claim; `ctxt` UNVERIFIED. |
| 7 | Group membership | verified | Ignore the `groups` claim entirely; `checkMemberGroups`, 20 ids per call. |
| 8 | Exchange Admin API, InvokeCommand, pwsh | verified; production terms UNVERIFIED | Six POST-only endpoints; no DL management; `InvokeCommand` undocumented; module supported on Ubuntu LTS only. |
| 9 | Throttling and eventual consistency | verified; U16 closed | Users, groups, applications and service principals share the identity-and-access limits; replication delay "several minutes". |
| 10 | Other wizard findings | discovered | Managed CA "Block device code flow"; Security Defaults effect on `amr`; app management policy can cap credential lifetime; Node cannot create X.509 certificates natively. |

## 2. Item 1: create the app registration with Graph

### 2.1 `POST /applications` (verified)

Source (read): https://learn.microsoft.com/en-us/graph/api/application-post-applications?view=graph-rest-1.0 and the resource page https://learn.microsoft.com/en-us/graph/api/resources/application?view=graph-rest-1.0

Only `displayName` is required; success is `201 Created` with `id` (object id) and `appId` (client id). Proposed body:

```http
POST https://graph.microsoft.com/v1.0/applications
Content-Type: application/json

{
  "displayName": "M365Portal",
  "description": "Created by the M365Portal setup wizard",
  "signInAudience": "AzureADMyOrg",
  "web": {
    "redirectUris": ["<base>/auth/callback", "<base>/auth/logged-out"],
    "implicitGrantSettings": { "enableIdTokenIssuance": false, "enableAccessTokenIssuance": false }
  },
  "requiredResourceAccess": [
    { "resourceAppId": "00000003-0000-0000-c000-000000000000",
      "resourceAccess": [ { "id": "<id of User.Read.All, resolved>", "type": "Role" } ] },
    { "resourceAppId": "00000002-0000-0ff1-ce00-000000000000",
      "resourceAccess": [ { "id": "<id of Exchange.ManageAsApp, resolved>", "type": "Role" } ] }
  ],
  "optionalClaims": { "idToken": [ { "name": "amr", "essential": false } ] }
}
```

| Property | Rule | Evidence |
|---|---|---|
| `signInAudience` | Always send `AzureADMyOrg`. | **corrected.** The resource page says `AzureADMyOrg` is the default; the create page's own example response shows `AzureADandPersonalMicrosoftAccount`. The value also decides the write throttle on the `applications` path: for `AzureADMyOrg` and `AzureADMultipleOrgs` 70,000 requests per 5 minutes, for the personal-account audiences 60 per minute (throttling-limits, identity and access). The resource page adds that `signInAudience` "isn't a replacement for proper tenant validation": the app must pin `tid` itself (section 6.4). |
| `web.redirectUris` | See 2.2. | reply-url page (read). |
| `web.implicitGrantSettings` | Both false. Code flow returns the ID token from `/token`, so implicit grant is not needed. | v2-oauth2-auth-code-flow (read): ID token "only provided if `openid` scope was requested" on the token response. |
| `web.logoutUrl` | Omit in Phase B (section 6.6). | |
| `isFallbackPublicClient` | Leave false (default). | application resource. |
| `requiredResourceAccess` | `type: "Role"` marks an application permission. Limit 50 resource APIs and 400 permissions. | Exchange page (carried) shows `"type": "Role"`; limits from the application resource page. It drives the consent UI only; the grant itself is section 3. |
| `optionalClaims.idToken` | `{"name":"amr","essential":false}`. `amr` is in the "v2.0-specific optional claims set" for JWT ID and access tokens. | optional-claims-reference (read). `include_granular_amr` is for SAML only. `optionalClaim` fields are `name`, `essential`, `source`, `additionalProperties` (optionalClaim page, read). |
| `groupMembershipClaims` | Leave null: no `groups` claim (section 8). | application resource. |
| `uniqueName` | Optional alternate key; immutable once set. | application resource, update page. |

**Idempotent create (verified, permissions UNVERIFIED U18).** `PATCH https://graph.microsoft.com/v1.0/applications(uniqueName='{uniqueName}')` with header `Prefer: create-if-missing` creates (201 with body) or updates (204); `displayName` stays required in the body (https://learn.microsoft.com/en-us/graph/api/application-upsert?view=graph-rest-1.0, snippet). `PATCH /servicePrincipals(appId='{appId}')` with the same header creates the service principal if missing (https://learn.microsoft.com/en-us/graph/api/serviceprincipal-upsert?view=graph-rest-1.0, snippet; permissions and roles identical to create). Both make a crashed wizard step safe to re-run. The upsert page's permission table for applications was not read (U18); the service-principal one matches create.

### 2.2 Redirect URIs (verified; Graph acceptance of `http://localhost` UNVERIFIED, extends U14)

Source (read): https://learn.microsoft.com/en-us/entra/identity-platform/reply-url. Property: `web.redirectUris` (webApplication page, read).

| Rule | Consequence |
|---|---|
| Must begin with `https`, except `localhost`: `http://localhost` and `http://localhost/abc` are valid, `http://contoso.com/...` is not. | `PUBLIC_BASE_URL` over plain HTTP is registrable only for host `localhost`. Any other host: wizard error before any Graph call. |
| The **port is ignored** when matching a localhost redirect URI; two localhost URIs that differ only by port are ambiguous ("picks one arbitrarily"). | Register `http://localhost/auth/callback` without a port; separate callback and post-logout URIs by **path**. |
| `127.0.0.1` is preferred by Learn, but the portal text box cannot add `http://127.0.0.1`; only the manifest `replyUrlsWithType` can. `[::1]` is not supported. | Register `localhost` only. If the owner browses `http://127.0.0.1:8080`, the redirect URI will not match (`AADSTS50011`). |
| Paths are case-sensitive; no `! $ ' ( ) , ;`; no IDN; a URI without a path is returned with a trailing slash (query/fragment response modes). | Always register an explicit path. |
| At most 256 URIs of at most 256 characters each (`AzureADMyOrg`). Wildcards allowed for single-tenant work accounts but "strongly" discouraged. | Never register wildcards. |
| Never put redirect URIs on the service principal. | Application object only. |
| `post_logout_redirect_uri` "must match one of the redirect URIs registered" (v2-protocols-oidc, read). | Register `/auth/logged-out` as a second redirect URI. |

### 2.3 `POST /servicePrincipals` (verified)

Source (read): https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-serviceprincipals?view=graph-rest-1.0

```http
POST https://graph.microsoft.com/v1.0/servicePrincipals
{ "appId": "<client id from 2.1>" }
```

Only `appId` is required; `201 Created`. The sample response shows `appRoleAssignmentRequired: false`, which is the wanted default: the panel enforces access in its own RBAC, so **Assignment required stays off**. `passwordCredential` cannot be set on create.

### 2.4 Certificate credential (verified, with corrections)

Sources (read): addKey https://learn.microsoft.com/en-us/graph/api/application-addkey?view=graph-rest-1.0; keyCredential https://learn.microsoft.com/en-us/graph/api/resources/keycredential?view=graph-rest-1.0; how-to https://learn.microsoft.com/en-us/graph/applications-how-to-add-certificate; assertion https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials; MSAL Node https://learn.microsoft.com/en-us/entra/msal/javascript/node/certificate-credentials; tenant policy https://learn.microsoft.com/en-us/graph/api/resources/keycredentialconfiguration?view=graph-rest-1.0

| Question | Answer |
|---|---|
| `keyCredentials` on create or update versus `addKey` | Create and update "can continue to be used to add and update key credentials for any application with or without a user's context" (addKey page). `addKey` additionally needs a **proof of possession** of an existing valid key (a self-signed JWT: `aud` `00000002-0000-0000-c000-000000000000`, `iss` = application id, `nbf`, `exp` = `nbf` + 10 minutes) and "applications that don't have any existing valid certificates ... won't be able to use this service action". So: **initial upload = `PATCH /applications/{id}` with `keyCredentials`**; **rotation = `addKey` signed with the current key**, which "doesn't need any specific permission to roll its own keys" (the runtime app can rotate itself; Phase D). A lapsed certificate can only be repaired by a wizard re-run with an administrator. `PATCH` replaces the whole `keyCredentials` collection: send the full intended list. |
| Request shape | `PATCH /applications/{id}` body `{"keyCredentials":[{"type":"AsymmetricX509Cert","usage":"Verify","key":"<base64 of the DER certificate>","displayName":"<subject>","startDateTime":"<notBefore>","endDateTime":"<notAfter>"}]}`; `204 No Content`. `type` and `usage` "must be `AsymmetricX509Cert` and `Verify`". `key` is "the certificate's raw data ... converted to Base64 string": DER of the public certificate, **not PEM text and never a PFX**. `key` is returned only with `GET /applications/{id}?$select=keyCredentials` (single object), otherwise `null`. |
| Self-signed accepted? | **Yes, accepted**: Learn's own how-to and the MSAL page use one, and the Exchange app-only page says "the certificate can be self-signed". Learn **advises against** it in a caution ("don't use self-signed certificates ... get certificates from a well-known trusted certificate authority"). For a self-hosted panel there is no CA; document the trade-off in `docs/security.md`. No tenant policy of type "trusted CA" exists on the key-credential policy resource read (only `asymmetricKeyLifetime`). |
| Lifetime | The how-to states `endDateTime` "can be a maximum of one year from the **startDateTime**; if you don't specify it, the system automatically assigns a date one year after". **corrected vs. the usual assumption of multi-year certificates.** Which of the certificate's own `NotAfter` and the sent `endDateTime` wins is not stated (**U19**). Generate the certificate with `notBefore` = now minus 5 minutes and validity of 360 days, and send matching dates. |
| Tenant policy | An app management policy can cap certificate lifetime: `keyCredentialConfiguration` with `restrictionType: asymmetricKeyLifetime` and `maxLifetime` (ISO 8601), optionally scoped by `restrictForAppsCreatedAfterDateTime`, with `excludeActors`. The error shape when the PATCH is refused is not documented (**U19**): surface the Graph error text and offer a shorter lifetime. |
| Key type and format | RSA with PSS padding: the assertion algorithm is `PS256`. MSAL Node accepts the private key as PEM PKCS#8 (encrypted or not) or PKCS#1; an encrypted key must be decrypted first. Learn names no minimum or maximum RSA size and no EC statement (**U20**); use RSA 2048. |
| `customKeyIdentifier`, thumbprint | "A 40-character binary type ... When not provided in the payload, defaults to the thumbprint of the certificate" (keyCredential). The how-to: "the thumbprint is included in the encoded key. Adding the key also adds the thumbprint." **Do not send `customKeyIdentifier`.** Entra therefore holds the SHA-1 thumbprint without any action. |
| `x5t#S256` or SHA-1 `x5t` | The documented assertion header is `alg` `PS256`, `typ` `JWT`, `x5t#S256` (base64url of the SHA-256 of the certificate DER). `x5t` is not listed (**U21**). MSAL Node takes `thumbprintSha256` ("*X.509 SHA-256* thumbprint") and `privateKey`. The probe (`stack-probe.md` section 8) found a community answer claiming Entra locates the certificate by SHA-1; since the SHA-1 is registered by default (previous row) and `x5t#S256` is the documented header, **both cases are covered when `customKeyIdentifier` is left alone**. Fallback if the first token request fails with `AADSTS700027`: send both headers through MSAL's `clientAssertion` callback. |
| Assertion claims | `aud` `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`; `iss` = `sub` = client id; `jti` unique; `nbf` now; `iat`; `exp` "5-10 minutes after `nbf` at most". Request parameters `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and `client_assertion`. |
| Malformed key | `AADSTS700027: Client assertion contains an invalid signature` is the documented symptom of a key string with `\r`, `\n` or bag attributes (MSAL page). |

**Implementation note (not a Microsoft claim, checked locally on Node 22.22.0):** `node:crypto` exports `X509Certificate` (parse only) and no certificate-creation API. Generating the self-signed certificate needs a dependency or an `openssl` binary; the distroless runtime has no `openssl`. The plan must choose and justify one, and the `image` smoke test must create a certificate inside the real image.

### 2.5 Delegated permission and directory role per call (verified)

| Call | Delegated permission (least) | Entra role of the signed-in user | Source |
|---|---|---|---|
| `POST /applications` | `AppRegistration.Create` (higher: `Application.ReadWrite.All`) | Default member user unless the tenant restricted it; otherwise Application Developer (becomes owner), Application Administrator, Cloud Application Administrator, Security Administrator | application-post-applications (read) |
| `POST /servicePrincipals` | `Application.ReadWrite.All` | Application Administrator or Cloud Application Administrator; for a single-tenant app a non-admin owner needs Application Developer | serviceprincipal-post-serviceprincipals (read) |
| `PATCH /applications/{id}` | `Application.ReadWrite.All` | same list as create | application-update (read) |
| `POST /servicePrincipals/{id}/appRoleAssignedTo` | `AppRoleAssignment.ReadWrite.All` **and** `Application.Read.All` (`Application.ReadWrite.All` is listed as the higher alternative) | **Privileged Role Administrator "the least privileged role supported for Microsoft Graph and Azure AD Graph app roles"**; Application Administrator and Cloud Application Administrator are also listed (for non-Graph resources, carried from 001 research 2.3) | serviceprincipal-post-approleassignedto (read) |
| `POST /roleManagement/directory/roleAssignments` | `RoleManagement.ReadWrite.Directory` | **Privileged Role Administrator** "is the least privileged role supported" | rbacapplication-post-roleassignments (read) |
| `GET /servicePrincipals?$filter=appId eq ...` | `Application.Read.All` | none beyond the above | permissions-grant-via-msgraph (read, prerequisites) |

So three delegated scopes cover the whole wizard: `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`. `Directory.Read.All` appears only as a higher alternative and is **not needed** (**corrected**, confirms 001 research 2.2). Global Administrator satisfies every row; the documented minimum is Privileged Role Administrator plus an app-registration-capable role (B3).

### 2.6 Pitfalls

1. After `POST /applications`, `GET`/`PATCH` of the new object can return **404** for several minutes (replication; section 11). The same applies to `POST /servicePrincipals` right after, and to `appRoleAssignedTo` referencing the new service principal (error code for the latter UNVERIFIED, **U32**).
2. `PATCH keyCredentials` with only the new certificate **deletes** existing ones.
3. A service principal is **not** created by `POST /applications`; create it explicitly.
4. Do not put the private key, the PFX or its passphrase into any Graph body or log; a canary test scans outbound bodies (R-07).

## 3. Item 2: admin consent in code (verified)

Sources (read): https://learn.microsoft.com/en-us/graph/permissions-grant-via-msgraph (application-permission part: prerequisites, steps 1 and 2) and https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto?view=graph-rest-1.0

**Look up (step 1):**

```http
GET https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '00000003-0000-0000-c000-000000000000'&$select=id,displayName,appId,appRoles
```

The same call with `appId eq '00000002-0000-0ff1-ce00-000000000000'` returns the Exchange resource. `id` is the resource service principal's object id; each `appRoles[]` entry has `allowedMemberTypes`, `id`, `isEnabled`, `value`. Match on `value` **and** `allowedMemberTypes` contains `Application` **and** `isEnabled`. Filter by `appId`, never by `displayName` (the Learn consent page does filter by name; names are not unique keys).

**Grant (step 2):** a client service principal is granted an app role by naming three ids:

```http
POST https://graph.microsoft.com/v1.0/servicePrincipals/{resourceSpId}/appRoleAssignedTo
Content-Type: application/json

{ "principalId": "<our service principal id>", "resourceId": "{resourceSpId}", "appRoleId": "<role id>" }
```

`201 Created`, response carries `principalType: "ServicePrincipal"`. Learn: permissions granted this way "aren't subject to review or confirmation and take effect immediately". Verification reads: `GET /servicePrincipals/{resourceSpId}/appRoleAssignedTo` (or `.../{clientSpId}/appRoleAssignments`); both carry a replication-delay note (https://learn.microsoft.com/en-us/graph/api/serviceprincipal-list-approleassignedto?view=graph-rest-1.0, snippet). Duplicate and idempotency behaviour of the POST is not documented (**U31**): list first, skip what exists.

**Role ids as test fixtures only (carried from 001 research 1.1; `User.Read.All` re-confirmed today in the grant example):**

| Permission | App role id |
|---|---|
| `User.Read.All` | `df021288-bdef-4463-88db-98f22de89214` |
| `GroupMember.Read.All` | `98830695-27a2-44f7-8c18-0c3ebc9698f6` |
| `GroupMember.ReadWrite.All` | `dbaae8cf-10b5-4b86-a4a1-f871c94c6695` |
| `Organization.Read.All` | `498476ce-e0fe-48b0-b801-37ba7e2685c6` |
| Exchange `Exchange.ManageAsApp` | `dc50a0fb-09a3-484d-be87-e023b12c6440` |

The runtime lookup is the rule; a mismatch between lookup and fixture is a warning in the wizard log, not an error.

**Optional, for non-admin panel users (UNVERIFIED, U30):** tenant-wide delegated consent for the panel's own sign-in scopes. `POST /oauth2PermissionGrants` with `{"clientId":"<our SP id>","consentType":"AllPrincipals","resourceId":"<Graph SP id>","scope":"..."}` (same page, delegated part; needs `DelegatedPermissionGrant.ReadWrite.All` plus `Application.Read.All`; Cloud Application Administrator is "the least privileged role"). It would be a fourth bootstrap scope. Section 16 (E3) recommends not adding it.

## 4. Item 3: `Exchange.ManageAsApp`, Exchange role, propagation

| Item | Value | Status / source |
|---|---|---|
| Resource | "Office 365 Exchange Online", `appId` `00000002-0000-0ff1-ce00-000000000000`; scope for tokens `https://outlook.office365.com/.default` | verified; app-only-auth-powershell-v2 (snippet today, read in 001 research) and admin-api-authentication (read) |
| App role (Exchange Online PowerShell) | `Exchange.ManageAsApp`, id `dc50a0fb-09a3-484d-be87-e023b12c6440` (carried); resolve at runtime by `value` | verified |
| App role (Admin API, Preview) | `Exchange.ManageAsAppV2` under the same resource; id not given on Learn | verified name; id **UNVERIFIED (U6)**; resolve at runtime. The same page's verification step still shows `Exchange.ManageAsApp`: Learn is inconsistent. Whether a token with only `ManageAsApp` is accepted by the Admin API, or the reverse for the module, is not stated (U6). |
| Grant | `appRoleAssignedTo` as in section 3; admin consent is mandatory ("Admin consent required: Yes") | verified |
| Entra role for the service principal | `POST /roleManagement/directory/roleAssignments` `{"@odata.type":"#microsoft.graph.unifiedRoleAssignment","roleDefinitionId":"29232cdf-9323-42fd-ade2-1d097af3e4de","principalId":"<our SP id>","directoryScopeId":"/"}` | verified (rbacapplication-post-roleassignments, read): `roleDefinitionId` may be "the service-wide template Id"; `directoryScopeId` `/` is tenant scope |
| Role template ids | Exchange Administrator `29232cdf-9323-42fd-ade2-1d097af3e4de` (named *Exchange Service Administrator* in the Graph API and PowerShell), Exchange Recipient Administrator `31392ffb-586c-42d1-9346-e59415a2cc4e` | verified (permissions-reference, snippet) |
| Mapping to Exchange roles | Exchange Administrator maps to Organization Management; Exchange Recipient Administrator to Recipient Management; Global Reader to View-Only Organization Management | verified (https://learn.microsoft.com/en-us/exchange/permissions-exo/permissions-exo, snippet) |
| Supported Entra roles for app-only EXO | Compliance Administrator, Exchange Administrator, Exchange Recipient Administrator, Global Administrator, Global Reader, Helpdesk Administrator, Security Administrator, Security Reader; "The Global Administrator and Exchange Administrator roles provide the required permissions for any task in Exchange Online PowerShell" | verified (snippet) |
| Delegated permission and role to make the assignment | `RoleManagement.ReadWrite.Directory`; Privileged Role Administrator | verified (section 2.5) |
| Mechanism | "The application object provisioned inside Microsoft Entra ID has a Directory Role assigned to it, which is returned in the access token. The session's RBAC is configured using the directory role information that's available in the token" | verified (app-only-auth-powershell-v2, snippet) |

**Propagation: UNVERIFIED (U4 stays).** Learn gives **no** delay for "Entra role assignment until Exchange accepts the app-only token". Analogies that are not evidence for this call: Azure RBAC "up to 10 minutes" (a different system, troubleshooting page); federated credentials "several minutes" plus advice to "add retry logic for token requests ... even after a token was successfully obtained"; PIM role changes "can't be removed within five minutes". The mechanism row implies the role is baked into the access token, so a token issued before the assignment will not carry it.

**How to detect it has taken effect (design):**

1. Each attempt requests a **new** app-only token: `acquireTokenByClientCredential({ scopes: [...], skipCache: true })` (`skipCache` is documented: "Skip token cache lookup and force request to authority to get a new token. Defaults to false", https://learn.microsoft.com/en-us/javascript/api/@azure/msal-node/clientcredentialrequest?view=msal-js-latest).
2. Do **not** decode the Exchange or Graph access token to look for roles: Learn warns "Don't attempt to validate or read tokens for any API you don't own".
3. Make one cheap real call and read the status: for the pwsh path `Connect-ExchangeOnline -AppId ... -Certificate ... -Organization <initial .onmicrosoft.com domain>` then `Get-OrganizationConfig`; for the Admin API path the call in section 9.3. Admin API statuses are documented: 401 = token or scope problem, 403 = "Missing RBAC role or trying to manage objects outside your scope", 200 = effective.
4. Retry window and schedule are an implementation choice (R-14): immediate probe, then 5, 10, 20, 30, 45, 60 seconds with +-20% jitter, repeating at 60 seconds, default total 15 minutes, hard maximum 60. The owner records the observed delay in the Phase B report (owner-verified OV-06).

**Least-privilege alternative (carried, 001 research 3.2):** custom Exchange role group via `New-ServicePrincipal` and `Add-RoleGroupMember` needs an interactive Exchange PowerShell session during the wizard; minimal role set UNVERIFIED (U5, U6). See B2.

## 5. Item 4: device code flow with "Microsoft Graph Command Line Tools"

Sources (read): https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code; Conditional Access https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-block-authentication-flows and https://learn.microsoft.com/en-us/entra/identity/conditional-access/managed-policies; MSAL Node (snippets) https://learn.microsoft.com/en-us/javascript/api/@azure/msal-node/devicecoderequest?view=msal-js-latest

### 5.1 Endpoints and shape (verified)

```http
POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode
Content-Type: application/x-www-form-urlencoded

client_id=14d82eec-204b-4c2f-b7e8-296a70dab67e&scope=https%3A%2F%2Fgraph.microsoft.com%2FApplication.ReadWrite.All%20https%3A%2F%2Fgraph.microsoft.com%2FAppRoleAssignment.ReadWrite.All%20https%3A%2F%2Fgraph.microsoft.com%2FRoleManagement.ReadWrite.Directory
```

Response: `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval`, `message`; `verification_uri_complete` "is not included or supported". From the request the user has **15 minutes** (default `expires_in`). The polling request is `POST /{tenant}/oauth2/v2.0/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `client_id`, `device_code`. Success returns `token_type`, `scope`, `expires_in`, `access_token`, `id_token` (if `openid`), `refresh_token` (if `offline_access`).

### 5.2 Polling errors

| Error | Meaning on Learn | Client action |
|---|---|---|
| `authorization_pending` | user has not finished, has not cancelled | repeat after at least `interval` seconds |
| `authorization_declined` | user denied | stop, revert to unauthenticated |
| `bad_verification_code` | `device_code` not recognised | check the code sent |
| `expired_token` | `expires_in` exceeded | stop |
| `slow_down` | **not listed on the Entra page** (defined by RFC 8628 section 3.5: add 5 seconds to the interval) | **UNVERIFIED (U22)**: handle it as RFC 8628 says; the default `interval` value is also not stated |

`interval` semantics: "the number of seconds the client should wait between polling requests". The wizard server polls; the browser only displays `user_code` and `verification_uri` (and polls the server).

### 5.3 MSAL Node (verified)

`PublicClientApplication.acquireTokenByDeviceCode({ scopes, deviceCodeCallback, cancel? })` returns `AuthenticationResult | null`. The callback receives the device code response for display; "MSAL polls the token endpoint for the interval specified"; setting `cancel = true` stops polling. **MSAL "always" adds `openid`, `profile`, `email` and `offline_access`** (Zero Trust token-management page and permissions reference, snippets) and passing them explicitly "might return an error": request only the three Graph scopes. Consequences: (a) a refresh token exists in MSAL's **in-memory** cache for the lifetime of the `PublicClientApplication` object; configure **no** `cachePlugin`, discard the object and clear its cache as soon as provisioning ends; (b) the bootstrap flow never stores a token (brief 3, FR-B-003). Raw protocol (5.1) is the alternative if the owner wants no refresh token at all; Learn recommends MSAL "when possible".

### 5.4 Scope format and consent (verified; UI details UNVERIFIED, U23)

- Omitting the resource identifier means Microsoft Graph (`User.Read` equals `https://graph.microsoft.com/User.Read`, consent-types-developer, snippet). Use the explicit form in code and logs.
- All three scopes are admin-restricted. Non-admins "receive an error message that says they're not authorized to consent" (`AADSTS90094`, or `AADSTS90093`; both documented, unexpected-user-consent-error, snippet).
- "Administrators can grant consent for themselves or for the entire organization." The prompt for a user at least Privileged Role Administrator carries a checkbox **"Consent on behalf of your organization", default off**; Cloud Application Administrator and Application Administrator do not see it (application-consent-experience, snippet). The Graph PowerShell documentation says the same client is "not pre-authorized" and "you need to sign in with an admin account to consent" (carried, 001 research 2.4).
- So the five wizard scopes of the brief are **not** requested "interactively as five": three are needed. The wizard should leave the checkbox **off**: a per-user grant for the temporary bootstrap client is enough, and a tenant-wide grant of `RoleManagement.ReadWrite.Directory` to Microsoft's client would linger. The per-user grant does remain after the wizard; the completion screen tells the owner where to review it (Enterprise applications, Microsoft Graph Command Line Tools, Permissions). Whether the consent screen appears inside the device flow exactly like this is the owner test OV-01.
- Error mapping the wizard needs: `AADSTS65001` (not consented), `AADSTS90094`/`90093` (admin approval), `AADSTS50105` (assignment required on the enterprise app; "the assignment requirement doesn't apply to Global Administrators", so a Global Administrator is not blocked by it), `AADSTS53003` (blocked by Conditional Access), `AADSTS530036` (refresh token invalid due to authentication-flow checks). Sources: unexpected-user-consent-error, troubleshoot-consent-issues, error-code-aadsts50105, troubleshoot-conditional-access, concept-authentication-flows (all snippets).

### 5.5 Tenant selection (verified)

`{tenant}` may be `common`, `consumers`, `organizations`, or a tenant GUID or domain. Use a tenant id or domain when the owner supplies one, otherwise `organizations` (work and school accounts only; never `common` or `consumers`). For guests the tenant identifier is mandatory ("for guest scenarios ... you must provide the tenant identifier to correctly sign them into the resource tenant", v2-protocols-oidc, read). After sign-in, show `tid` (from MSAL's `account.tenantId`) and the account name as a confirmation step; they come from the ID token issued to the Microsoft client, whose audience is not ours, so they are display and binding hints, confirmed later by the app-only `GET /organization` with the new credential. `oid` is identical across applications for the same user (id-token-claims-reference, read), so the bootstrap identity maps to the first Owner by `oid` + `tid`; `sub` is pairwise per application and must not be used for that mapping.

### 5.6 When Conditional Access blocks device code flow (verified, corrects 001 framing)

- Conditional Access has an **Authentication flows** condition with **Device code flow**; Microsoft recommends "as close as possible to a unilateral block". The policy matches the **flow**, not a client: a custom `BOOTSTRAP_CLIENT_ID` does **not** avoid it. (Inference from the policy definition; 001 research O5 implied the override helps. It helps only if Microsoft restricts the first-party client.)
- Microsoft-managed policy **"Block device code flow"** is created in eligible tenants in report-only state and "enabled no less than 30 days after" introduction unless set to Off; notification 2 weeks before (managed-policies, read). Many tenants will therefore block the wizard's default path; expect it.
- A blocked sign-in shows `AADSTS53003` (BlockedByConditionalAccess). Sign-in logs show which authentication flow matched; a refresh token obtained through device code is "protocol tracked" (`AADSTS530036`), irrelevant because the wizard never reuses it.
- Remedies the wizard can name: (1) a Conditional Access administrator temporarily excludes the signing-in administrator from the policy (Learn: exclude "break-glass accounts and any other necessary users"); (2) the manual provisioning mode (B4).

### 5.7 Token lifetime (verified)

Access tokens get a random 60 to 90 minutes (75 on average); clients with Continuous Access Evaluation can receive 24 to 28 hours (access-tokens, snippet). The device code itself lives 15 minutes. Design: request the bootstrap token only when the "configure tenant" stage starts; finish all delegated calls inside it; discard it **before** the propagation probes, which use only the new app credential.

## 6. Item 5: sign-in as a confidential client with a certificate

Sources (read): https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow, https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc, https://learn.microsoft.com/en-us/entra/identity-platform/id-tokens, https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference, https://learn.microsoft.com/en-us/entra/identity-platform/signing-key-rollover, https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials

### 6.1 Authorization request (verified)

```http
GET https://login.microsoftonline.com/{tid}/oauth2/v2.0/authorize
  ?client_id={appId}
  &response_type=code
  &redirect_uri={base}/auth/callback
  &response_mode=query
  &scope=openid%20profile
  &state={random}
  &nonce={random}
  &code_challenge={S256 of verifier}
  &code_challenge_method=S256
```

- Use the **tenant-specific** authority (`{tid}`), never `common`. PKCE is "recommended for all application types, both public and confidential clients"; `S256`.
- `response_mode`: `query` is the default for a code response; `form_post` is "recommended" by Learn, "especially when using `http://localhost`". **Choose `query`.** Reason (browser behaviour, not a Learn statement): a `form_post` callback is a cross-site POST, which a `SameSite=Lax` or `Strict` cookie does not accompany; the brief's short Lax state cookie (BC-03) works only with a top-level GET. Switching to `form_post` would need `SameSite=None; Secure` for that cookie. Authorization codes expire "after about 1 minute".
- `nonce`: Learn lists it as required for ID-token responses; the id-tokens page says the `nonce` claim "must match the nonce parameter passed into the `/authorize` endpoint"; send and check it for the code flow too.
- Do not request `offline_access`: the panel never calls Graph as the user, and without it no refresh token is issued ("Only provided if `offline_access` scope was requested").
- `prompt=login` forces credentials ("negating single sign-on"). `login_hint` pre-fills. `max_age` is **not** in either page's parameter table; it appears on Learn only in the Microsoft-account server reference and in ASP.NET Core's generic OIDC options, never as an Entra v2.0 parameter (U13 stays).
- The `claims` parameter exists for claims challenges, documented with `access_token` examples (claims-challenge, snippet). Its use with an `id_token` member for `amr` is **UNVERIFIED (U27)**.

### 6.2 Redeeming the code with a certificate (verified)

`POST /{tid}/oauth2/v2.0/token`, form body: `client_id`, `scope` (optional), `code`, `redirect_uri`, `grant_type=authorization_code`, `code_verifier`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, `client_assertion=<JWT>`. Header and claims as in section 2.4. The discovery document lists `token_endpoint_auth_methods_supported`: `client_secret_post`, `private_key_jwt` (v2-protocols-oidc sample). Token response: `access_token` (not needed), `token_type` `Bearer`, `expires_in`, `scope`, `id_token`. Token endpoint errors that matter: `invalid_grant` (code or verifier wrong or expired), `invalid_client` (credential invalid), `interaction_required`/`consent_required`, `temporarily_unavailable` (retry once after a short delay).

### 6.3 Discovery and signing keys (verified)

Discovery: `https://login.microsoftonline.com/{tid}/v2.0/.well-known/openid-configuration`; keys `jwks_uri` = `.../{tid}/discovery/v2.0/keys`; end session `end_session_endpoint` (listed in the discovery document, v2-protocols-oidc table: Logout `/oauth2/v2.0/logout`, GET and POST). Key handling rules from signing-key-rollover: discover and cache keys **per tenant** with the tenant-specific endpoint; cache each key by `kid`, **TTL 24 hours, refresh every hour**; refresh on startup, hourly, and on an unknown `kid`, but not more often than every 5 minutes; "there's always more than one valid key", order is meaningless; an unknown `kid` still fails after one refresh. A `jose` remote key set approximates this only when configured for it (re-fetch interval about one hour, at least 5 minutes between re-fetches triggered by an unknown `kid`); the exact option names are checked against the pinned jose 6.2.12 when the code is written (R-19).

### 6.4 ID token validation (verified; library parameters are implementation choices)

Learn: "Only confidential clients should validate ID tokens"; use a library; validate signature, then timestamps (`iat`, `nbf`, `exp`), `aud` equal to the application id, `nonce`. From the claims reference: `iss` is the issuer URI, ending in `/v2.0` for v2.0 tokens; the sample v2.0 token carries `iss` = `https://login.microsoftonline.com/{tid}/v2.0`; `tid` is the tenant GUID ("Always check that the `tid` ... matches", claims-validation, carried); `ver` is `2.0`; `kid` in the header; the sample header `alg` is `RS256`. ID token lifetime 1 hour by default. `c_hash` and `at_hash` are not present on ID tokens from `/token`.

Checks to implement (all MUST, R-19): signature via JWKS; `alg` in `["RS256"]` (U33: Learn shows only RS256 in its example); `iss === https://login.microsoftonline.com/{pinned tid}/v2.0`; `tid === pinned tid`; `aud === appId`; `nonce` equals the stored value, single use; `exp` and `nbf` with a 60-second tolerance (Learn gives **no** skew value for ID tokens, U33); `ver === "2.0"`; user key = `oid` + `tid`. Never key on `sub`, `email`, `preferred_username` or `upn`: Learn marks them mutable and "can't be used to make authorization decisions".

### 6.5 Re-authentication and step-up (Phase B needs only the first; the rest prepares Phase D)

| Mechanism | Status |
|---|---|
| `prompt=login` | verified: forces credential entry. It does **not** by itself force MFA: MFA happens only when tenant policy (Conditional Access, Security Defaults, per-user MFA) asks for it. If the tenant never asks, a step-up that needs MFA cannot succeed; the panel must then refuse with an explicit reason rather than loop. |
| `auth_time` | verified as an optional claim ("Time when the user last authenticated", JWT). Request it with `amr`: `optionalClaims.idToken` `[{"name":"amr"},{"name":"auth_time"}]`. Whether single sign-on reuse updates it is not stated (U27). |
| `iat` | the claims reference says `iat` "indicates when the authentication for the token occurred". |
| `max_age` | UNVERIFIED for Entra (U13). Do not rely on it. |
| `claims` with `amr` values | UNVERIFIED for ID tokens (U27). |
| Authentication context `acrs` | verified in 001 research 5.3 (Entra ID P1; Conditional Access policy per context id); not Phase B. |

### 6.6 Sign-out (verified)

Sign-out has two required steps: redirect the user agent to `end_session_endpoint` **and** end the app session (v2-protocols-oidc). Request: `GET https://login.microsoftonline.com/{tid}/oauth2/v2.0/logout?post_logout_redirect_uri=<registered redirect URI>`; `logout_hint` is optional and requires the `login_hint` optional claim (do not use UPN or phone number as the hint). After sign-out, a valid Primary Refresh Token can make the next sign-in show an account picker. Order in the app: destroy the server session and clear the cookie **first**, then redirect, so a failed redirect never leaves a live session.

Front-channel logout: Entra sends an HTTP **GET** to each application's front-channel logout URL (`web.logoutUrl`); the app must clear the session and return 200; one URL per application. **Phase B does not register one.** Reasons: that GET arrives in a cross-site frame, where `__Host-` `SameSite=Strict` cookies are not sent, so the server could not tell which session to end, and Learn lists no query parameters (`sid`, `iss`) for it (U29); an unauthenticated GET that ends sessions is also a logout-CSRF primitive. The brief's "uitloggen overal" is satisfied by invalidating all of the user's server-side sessions in the panel database.

## 7. Item 6: `amr`, `acr`, `xms_cc`, `ctxt`

| Claim | Where it exists | Status |
|---|---|---|
| `amr` | v2.0 ID and access tokens **only when requested** as an optional claim ("v2.0-specific optional claims set"); not in the default ID-token claim table | verified |
| `acr` | "0 or 1, only present in v1.0 tokens" (access-token claims reference, carried); absent from the v2.0 ID-token table | corrected (the brief says `amr`/`acr`) |
| `xms_cc` | optional claim for **access tokens**; the *resource* decides whether it appears; `cp1` means the client can handle claims challenges. Clients declare capability with `{"access_token":{"xms_cc":{"values":["cp1"]}}}` or MSAL `clientCapabilities: ["cp1"]` (also available to MSAL Node confidential clients) | verified; not an ID-token claim. Relevant only when the panel receives claims challenges from Graph as a client (Phase C/D). |
| `ctxt` | not found on Learn | **UNVERIFIED (U28)**; do not use |
| `acrs` | Authentication context ids; optional claim; P1 | verified (carried) |
| `auth_time`, `login_hint`, `tenant_ctry`, `idtyp`, `acct` (0 member, 1 guest) | optional claims listed | verified |

**`amr` values (OIDC v2.0), read from optional-claims-reference:**

| Entra method | `amr` values |
|---|---|
| Password | `pwd` |
| Authenticator push | `rsa`, `ngcmfa`, `mfa` |
| Authenticator TOTP | `totp`, `mfa` |
| Hardware OATH token | `hotp`, `mfa` |
| Phone sign-in (passwordless Authenticator) | `swk`, `rsa`, `mfa` |
| SMS | `sms`, `mfa` |
| Phone call | `tel`, `mfa` |
| Email | `emailotp`, `mfa` |
| FIDO2 security key, passkeys (device-bound, synced) | `fido`, `mfa` (labelled PRMFA) |
| Windows Hello for Business | `hwk`, `mfa`, `ngcmfa` (PRMFA) |
| Certificate-based, multi-factor / single-factor | `hwk` / `x509`, then `mfa`, `rsa` per the table; "`x509` alone does not qualify as phishing-resistant MFA" |
| Temporary Access Pass | `otp`, `mfa` |
| Windows integrated (Kerberos) | `wia` |
| Device-based X.509 | `x509` |

"The `multipleauthn` and `mfa` values are emitted only when the user has completed MFA." Entra "forwards the `amr` values sent from an external MFA provider along with the `amr` values for the authentication methods performed in Microsoft Entra ID."

**Robust check:** `Array.isArray(claims.amr) && claims.amr.includes("mfa")`. Missing claim means not satisfied (fail closed; this is why the optional claim must exist in the app registration). Never allow-list the full value set, never test `amr[0]`, never treat `pwd`, `wia` or `x509` alone as MFA. A phishing-resistant requirement (Phase D, optional) would additionally need `fido` or `hwk`; Learn's documented way to require it is a Conditional Access authentication strength, so that stays a tenant policy. Behaviour on missing MFA, and the Security Defaults caveat, are in B5.

## 8. Item 7: group membership at sign-in

| Topic | Fact | Source |
|---|---|---|
| `groups` claim in v2.0 ID tokens | appears only if the app's `groupMembershipClaims` is set (the `groups` optional claim only changes its formatting and "must be set as well"). Limits: 200 groups in a JWT, 150 in SAML; beyond that the claim is dropped and `_claim_names.groups` + `_claim_sources` appear; `hasgroups: true` is the signal in the implicit flow | id-token-claims-reference (read) |
| What to do | Do not request the claim; ignore `groups`, `_claim_names`, `_claim_sources` and `hasgroups` if present; never call the URL in `_claim_sources` (it can be an Azure AD Graph URL). The brief already re-evaluates through Graph at every sign-in. | 001 research 5.4 (carried) |
| `POST /users/{oid}/checkMemberGroups` body `{"groupIds":["..."]}` | transitive; **at most 20 group ids per request**; "Microsoft Graph evaluates the groupIds collection as a single request": one malformed id fails the whole request; groups the caller may not evaluate (hidden membership) may be omitted; Microsoft 365 groups cannot contain groups. Least privileged application permissions: `User.ReadBasic.All` + `GroupMember.Read.All` (the planned set `User.Read.All` + `GroupMember.Read.All` is on the list). `GroupMember.ReadWrite.All` alone is **not** listed. Cost 4 resource units. | checkMemberGroups (snippet) and getMemberGroups permission table (read), throttling-limits (read) |
| `POST /users/{oid}/getMemberGroups` `{"securityEnabledOnly":true}` | all group ids; up to **11,000**; beyond that `400 Directory_ResultSizeLimitExceeded` and Learn says to use `transitiveMemberOf`. `securityEnabledOnly: false` also returns directory roles. Cost 2. | getMemberGroups (read) |
| `GET /users/{oid}/transitiveMemberOf` | groups, directory roles and administrative units; default page 100, max 999; `$top`, `$select`; `$filter`, `$search`, `$orderby` and OData cast need `ConsistencyLevel: eventual` plus `$count` and use an index that "might not be up-to-date with recent changes"; follow `@odata.nextLink`. | user-list-transitivememberof (snippet) |
| `/me/...` | delegated only: "Application permissions aren't supported when using the `/me` endpoint". Use `/users/{oid}`. | getMemberGroups (read) |

Design: the RBAC tables bind a small set of Entra group ids to roles; at each sign-in call `checkMemberGroups` with those ids in chunks of 20 (a panel with more than 20 bound groups needs several calls). Nested membership is covered by the transitive semantics. Hidden-membership groups would silently never match (fail closed); `Member.Read.Hidden` is not requested (001 research 1.4). If Graph fails, group-derived grants are denied and audited; directly assigned roles still apply (R-23). `transitiveMemberOf` is the paging fallback for the "who is in which group" screens of Phase D.

## 9. Item 8: Exchange Admin API (Preview), `InvokeCommand`, `pwsh`

Sources (read today): https://learn.microsoft.com/en-us/exchange/reference/admin-api-overview, `.../admin-api-get-started`, `.../admin-api-authentication`, `.../admin-api-endpoints-reference`, `.../admin-api-endpoints-accepted-domain`, `.../admin-api-endpoints-dynamic-distribution-group-member`, `.../admin-api-endpoints-mailbox`, `.../admin-api-endpoints-mailbox-folder-permission`; `organization-config` and `distribution-group-member` carried from 001 research 3.5.

### 9.1 Endpoint list (verified, complete)

Every call is `POST <BaseUrl>/adminapi/v2.0/<TenantID>/<EndpointName>`. **There is no GET.** Base URL `https://outlook.office365.com` (also GCC); other clouds differ.

| Endpoint | Cmdlets accepted | Role group needed |
|---|---|---|
| `OrganizationConfig` | `Get-OrganizationConfig` (no parameters) | View-Only Organization Management |
| `AcceptedDomain` | `Get-AcceptedDomain` (`Identity`, `ResultSize`) | View-Only Organization Management |
| `Mailbox` | `Get-Mailbox` (`Identity`, `ResultSize`, `IncludeGrantSendOnBehalfToWithDisplayNames`), `Set-Mailbox` (`Identity`, `GrantSendOnBehalfTo` only) | Recipient Management |
| `MailboxFolderPermission` | `Get-`, `Add-`, `Set-`, `Remove-MailboxFolderPermission` | Recipient Management |
| `DistributionGroupMember` | `Get-DistributionGroupMember` (`Identity` required, `ResultSize`) | Recipient Management |
| `DynamicDistributionGroupMember` | `Get-DynamicDistributionGroupMember` (`Identity` required, `ResultSize`) | Recipient Management |

Anything else returns `400 Bad Request`. **No** `Get-DistributionGroup`, `Add-/Remove-DistributionGroupMember` or any `*-MailContact` cmdlet: Phase D writes cannot use this API. The overview states the API "doesn't replace the full Exchange administration surface" and is built for EWS-deprecation scenarios.

### 9.2 Request, authentication, paging, throttling (verified)

- Headers: `Authorization: Bearer`, `Content-Type: application/json`, **`X-AnchorMailbox` mandatory**; app-only value `APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@<tenantId or .onmicrosoft.com domain>` (the GUID "is the same across all organizations").
- Body: `{"CmdletInput":{"CmdletName":"<cmdlet>","Parameters":{...}}}`. `$select` is a query parameter on the URL.
- Token: client credentials, scope `https://outlook.office365.com/.default`; app role `Exchange.ManageAsAppV2` (delegated `Exchange.ManageV2`); RBAC by Entra role or custom role group; "Without the appropriate RBAC role assignments, even valid tokens fail with ... 403 Forbidden".
- Paging: `ResultSize` (default 1,000, `Unlimited` where allowed), `@odata.nextLink` valid 5 to 10 minutes, POST to it with the same headers and parameters.
- Throttling: "Implement retry logic for throttling (HTTP 429) and honor Retry-After". No numeric limits published (U7 stays).
- Preview: every page says "currently in Preview, aren't available in all organizations, and are subject to change"; the Preview response still contains the full cmdlet output and will be narrowed. No page states production-use terms or an SLA (**U25**).

### 9.3 Role-propagation probe (design)

```http
POST https://outlook.office365.com/adminapi/v2.0/{tid}/AcceptedDomain
Authorization: Bearer <fresh app-only token>
Content-Type: application/json
X-AnchorMailbox: APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@{tid}

{ "CmdletInput": { "CmdletName": "Get-AcceptedDomain", "Parameters": { "ResultSize": 1 } } }
```

`Get-AcceptedDomain` is the smallest read: it needs only View-Only Organization Management, which Exchange Administrator and Exchange Recipient Administrator both cover. 200 = role and consent effective; 403 = RBAC missing or not yet propagated; 401 = token or scope (consent for `ManageAsAppV2` missing). **It is a probe for the Admin API path only.** Because the API is Preview and "not available in all organizations", a persistent failure is **inconclusive**, not proof that the pwsh path is broken. It also needs the second app role (`ManageAsAppV2`), whose id is not on Learn (U6).

### 9.4 Memo: `InvokeCommand` and `pwsh` (for B1)

| Path | Learn status | Covers Phase D? |
|---|---|---|
| `InvokeCommand` REST endpoint | **No page.** Searches for `InvokeCommand`, `adminapi` internals and the EXO REST connection protocol found nothing; the module's REST wire protocol is undocumented. | Unsupported. Do not build on it. |
| Admin API (Preview) | Documented (9.1 to 9.3) | No: no DL membership writes, no contacts. |
| `pwsh` + ExchangeOnlineManagement | Documented: `Connect-ExchangeOnline -AppId <id> -Certificate <X509Certificate2> -Organization <tenant>.onmicrosoft.com` works with a certificate **object** or `-CertificateFilePath` + `-CertificatePassword`; `-CertificateThumbprint` is Windows-only; CNG certificates are unsupported on Windows (irrelevant on Linux); the Organization value must be the primary `.onmicrosoft.com` domain. All cmdlets are REST-backed with a 15-minute timeout (carried). Unattended app-only does not support `*-UnifiedGroup*` and `*-UnifiedGroupLinks`. | Yes. The only documented path. |

**Linux and containers (read today, https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2?view=exchange-ps and https://learn.microsoft.com/en-us/powershell/scripting/install/install-ubuntu?view=powershell-7.6):**

- The module is "officially supported" on Linux **only** on Ubuntu 24.04 LTS, 22.04 LTS, 20.04 LTS and 18.04 LTS. Debian, Alpine and distroless are not listed (U9 stays); Ubuntu 26.04 is listed for PowerShell itself but **not** for the module (U26).
- Version coupling: module 3.10.0 (June 2026) or later requires PowerShell 7.6.0 (March 2026) or later; 3.5.0 to 3.9.2 require 7.4.0 or later; 3.0.0 to 3.4.0 require 7.2.0 to 7.3.7 on Ubuntu 24.04/22.04. Behind a proxy on Linux the module must be 3.0.0 or later.
- PowerShell on Ubuntu: installed from the Microsoft package repository (preferred) or a universal `.deb`; Microsoft's .NET SDK container images contain PowerShell but are "provided for testing purposes. If you need a Docker image for a production workload, you should build and maintain your own." The Arm paragraph mentions 32-bit Arm via binary archive; **arm64 for the module is not stated** (U26), which matters for the brief's amd64 + arm64 image.
- `Connect-IPPSSession` (Security & Compliance) is unavailable in PowerShell 7 on Linux; the product does not need it.

## 10. Item 9: throttling and eventual consistency

### 10.1 Graph throttling (verified; U16 closed)

Sources: https://learn.microsoft.com/en-us/graph/throttling-limits (identity and access section read), https://learn.microsoft.com/en-us/graph/throttling (carried).

- `429` carries `Retry-After`; wait that long, keep honouring it on repeated 429; no `Retry-After` means exponential backoff; `503` retries on a new connection; JSON-batch sub-requests are not retried by SDKs (carried, 001 research 6.1).
- The **identity and access** limits apply to `application`, `servicePrincipal`, `group`, `user`, `directoryObject`, `directoryRole`, `oauth2PermissionGrant`, `organization`, `subscribedSku`, `licenseDetails` and more (list read in full). **This closes U16.** Per application + tenant pair: 3,500 / 5,000 / 8,000 resource units per 10 seconds for tenants under 50 / 50 to 500 / over 500 users; write quota 3,000 requests per 2 minutes 30 seconds; tenant-wide 18,000 writes per 5 minutes; application-wide 150,000 units per 20 seconds. "It's possible to receive 429 responses even when the limits aren't reached."
- Costs relevant here: `GET users` 2, `GET applications` 2, `GET groups/{id}/members` 3, `POST users/{id}/checkMemberGroups` 4, `POST .../getMemberGroups` 2, `GET .../transitiveMemberOf` 2, `GET subscribedSkus` 3, other GET 1, other POST/PATCH/DELETE 1 plus 1 write unit; `$select` -1, `$expand` +1, `$top` < 20 -1.
- Headers: `x-ms-throttle-priority` (`low`, `normal`, `high`; "set priority to `high` only for the requests initiated by the user"), `x-ms-throttle-limit-percentage` (from 0.8), and on 429 `x-ms-throttle-scope`, `x-ms-throttle-information`. Wizard calls are user-initiated: send `high`; background cache refreshes `low`.
- Wizard volume: about 15 writes and a handful of reads, far below any limit. Sign-in: one `checkMemberGroups` per 20 bound groups per sign-in. Throttling is therefore a robustness item (R-15), not a capacity problem.

### 10.2 Eventual consistency (verified)

- Source: https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/app-integration/404-not-found-error-manage-objects-microsoft-graph. A newly created user, group or application can return **404** on `GET`/`PATCH` "shortly after its creation"; replication "might take **several minutes**"; the documented fix: "wait some time and retry ... If the 404 error still occurs after retrying, **double your waiting time** and try again."
- Add-member and update-group pages: a recently created group can answer `400` "The source resource object or one of the objects being referenced don't exist"; retry after "a brief delay" (carried).
- The app-role-assignment list pages carry a replication-delay note (3, snippet).
- Linked guidance: "Designing for Eventual Consistency for Microsoft Entra" (devblogs, referenced from Learn; not a Learn page).

**Recommended strategy (implementation choice built on the above):** classify each failure as *transient* (429, 503, network), *replication* (404 on an id the wizard just created or received, 400 with the "source resource object" message, 403 from Graph or Exchange within the propagation window after a grant) or *permanent* (everything else). Transient: `Retry-After` or backoff 1 s doubling to 30 s with full jitter, at most 6 tries. Replication: 2 s doubling to 60 s, total window 5 minutes for object-to-object chains (app, service principal, grants) and 15 minutes (configurable) for role-to-token propagation; every wait is reported in the live log as "waiting for Microsoft to replicate (n of m)". Never retry a permanent error. All values are tunables in one module with fake-timer tests.

## 11. Item 10: other findings the wizard design needs

1. **App creation rights.** If "users can register applications" is off, the signed-in administrator needs Application Developer (creates and owns the app even when members are restricted), Application Administrator or Cloud Application Administrator (section 2.5). The wizard's role check message should list these.
2. **Security Defaults.** Enforced: all users register for MFA; the 16 listed administrator roles (including Global Administrator, Application Administrator, Cloud Application Administrator, Exchange Administrator, Privileged Role Administrator) must do MFA **every time they sign in**; other users are prompted "when necessary". Learn also states "you can't enable any Conditional Access policies if you have security defaults enabled" (microsoft-365-secure-sign-in, snippet), so a Conditional Access device-code block cannot be active in such a tenant; the device flow with an administrator should therefore work, with MFA in the browser step (inference; OV-11). For the panel this means non-administrator users may sign in **without** `amr` containing `mfa` (B5).
3. **Per-user MFA** (legacy; "a configuration that Microsoft no longer recommends") is evaluated at sign-in like any other MFA, so the browser step of the device flow performs it (inference; OV-11); a managed policy exists that moves per-user-MFA users to Conditional Access (managed-policies, read).
4. **App management policies** can cap certificate lifetime (section 2.4). Treat a 400 on the credential PATCH as a possible policy refusal, show Graph's message, and offer a shorter lifetime.
5. **Assignment required.** If a tenant sets it on an enterprise app, users get `AADSTS50105` except Global Administrators. Keep it **off** for our service principal (default in the create sample); for the Microsoft client it can block a Privileged Role Administrator + Application Administrator pair.
6. **Consent for panel users (U30).** Tenants with user consent disabled show "Need admin approval" to non-admins for apps that request delegated permissions; whether `openid profile` alone triggers it is not stated. Mitigation without a new bootstrap scope: when the first sign-in of a non-admin fails with `AADSTS90094`/`65001`, the panel offers an administrator the tenant-wide consent link `https://login.microsoftonline.com/{tid}/v2.0/adminconsent?client_id={appId}&scope=openid profile&redirect_uri={registered URI}` (pattern shown on https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish-nested-app-auth-add-in, snippet; the redirect URI must be registered). UNVERIFIED for OIDC-only scopes; OV-12.
7. **Exchange service principal may be absent.** Whether every tenant has the "Office 365 Exchange Online" service principal (for example a tenant without Exchange Online) is not stated; if the lookup (section 3) returns nothing, stop the Exchange part with a named message instead of creating a first-party service principal (not documented for that case).
8. **Sovereign clouds.** Base URLs and authority hosts differ and the Microsoft client cannot be used in some clouds (carried, 001 research 2.1). Phase B supports the worldwide cloud only and refuses others explicitly.
9. **Primary domain.** `Connect-ExchangeOnline -Organization` needs the primary `.onmicrosoft.com` domain (carried). Derive it from Graph `GET /organization` (`verifiedDomains`; the `isInitial` flag of a verified domain was not re-read today) or from the Admin API `AcceptedDomain` response.

## 12. Call sheet: the wizard's calls in order

| # | Call | Token | Needs |
|---|---|---|---|
| 1 | device code + polling | none, then delegated (Microsoft client) | three scopes, administrator at least Privileged Role Administrator (+ app-registration role) or Global Administrator |
| 2 | `GET /servicePrincipals?$filter=appId eq '<Graph>'` and `... '<Exchange>'` | delegated | `Application.Read.All` (covered by `Application.ReadWrite.All`) |
| 3 | create or upsert application (2.1) | delegated | `Application.ReadWrite.All` |
| 4 | create or upsert service principal (2.3) | delegated | `Application.ReadWrite.All` |
| 5 | `PATCH` `keyCredentials` (2.4) | delegated | `Application.ReadWrite.All` |
| 6 | 4 x `appRoleAssignedTo` on Graph, 1 or 2 on Exchange (3) | delegated | `AppRoleAssignment.ReadWrite.All` |
| 7 | `POST roleAssignments` (4) | delegated | `RoleManagement.ReadWrite.Directory` |
| 8 | discard the bootstrap token | | |
| 9 | client-credentials token (Graph), `GET /organization`, `GET /users?$top=1` | app-only, `skipCache` | `Organization.Read.All`, `User.Read.All` |
| 10 | Exchange probe (4, 9.3), pwsh verification (B1) | app-only, `skipCache` | role effective |

## 13. Implementation rules with named controls

Paths use the 001 prefix table (`server/` = `apps/server/test/`, `shared/` = `packages/shared/test/`, `web/`, `e2e/` = `e2e/tests/`, `py/` = `scripts/`). **The file names are proposals; the Phase B spec owns the final names and must keep each row's control.** Microsoft is simulated by MSW for HTTP and by an in-process fake identity provider that signs with `jose`; no real tenant is involved. CI job names are the existing `quality` and `e2e`.

| ID | Strength | Rule | Control |
|---|---|---|---|
| R-01 | MUST | Create the application with explicit `signInAudience: "AzureADMyOrg"`, both implicit-grant flags false, no `groupMembershipClaims`, `optionalClaims.idToken` containing `amr` (and `auth_time` if step-up is in scope). | `server/setup/provision-app.test.ts` (MSW asserts the body field by field), job `quality` |
| R-02 | MUST | Register only `https://...` or `http://localhost/<path>` redirect URIs with explicit path; refuse any other host over HTTP, `127.0.0.1`, `[::1]`, wildcards and forbidden characters; register callback and post-logout URIs separately. | `shared/redirect-uri.test.ts` (table of valid and invalid URIs from section 2.2), `server/setup/provision-app.test.ts`, `quality` |
| R-03 | MUST | Resolve every app role id at runtime from `GET /servicePrincipals?$filter=appId eq '<appId>'&$select=id,displayName,appId,appRoles`, matching `value`, `allowedMemberTypes` containing `Application` and `isEnabled`; stop with a named error when missing; the id table in section 3 is a fixture only. | `server/setup/resolve-app-roles.test.ts` incl. negative cases (role missing, disabled, only `User` member type), `quality` |
| R-04 | MUST | Grant roles with `POST /servicePrincipals/{resource}/appRoleAssignedTo`; skip roles already assigned (list first); a duplicate response counts as success. | `server/setup/grant-roles.test.ts` (second run makes no POST), `quality` |
| R-05 | MUST | Assign the Entra role with the body in section 4; re-run is safe. | `server/setup/assign-exchange-role.test.ts` (idempotence and body), `quality` |
| R-06 | MUST | The runtime application receives exactly the permission set decided at the gate (default: `User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All`, `Exchange.ManageAsApp`); never `Directory.Read.All`, `Group.ReadWrite.All`, `User.ReadWrite.All` or `RoleManagement.ReadWrite.Directory`. | `server/setup/permission-set.test.ts` (snapshot), `server/docs-contract.test.ts` (each permission appears in `docs/permissions.md` with a reason), `quality` |
| R-07 | MUST | Send only the public DER certificate (base64) in `keyCredentials`, with `type` `AsymmetricX509Cert`, `usage` `Verify`, no `customKeyIdentifier`, `endDateTime` at most one year after `startDateTime`; private key, PFX and passphrase never appear in any outbound body, log line or error. | `server/setup/certificate.test.ts` (canary private key scanned in every MSW request body, log buffer and problem body), `quality` |
| R-08 | MUST | After upload, read back `keyCredentials` (`$select`), compare count and `keyId`, then obtain an app-only token with the new credential before the step is green. | `server/setup/verify-credential.test.ts`, `quality` |
| R-09 | MUST | Device code: scopes exactly the decided set, no explicit `openid`/`profile`/`offline_access`; poll no faster than `interval`; handle `authorization_pending`, `slow_down` (+5 s), `authorization_declined`, `expired_token`, `bad_verification_code`; stop at `expires_in`; `cancel` on wizard abort. | `server/setup/device-code.test.ts` (MSW, fake timers), `quality` |
| R-10 | MUST | The bootstrap token and its refresh token live in memory only: no cache plugin, object discarded and cache cleared after provisioning, on failure and on timeout. | `server/setup/bootstrap-token-lifecycle.test.ts` (canary access and refresh tokens absent from `/data`, database, logs and problem bodies; no `cachePlugin` configured), `quality` |
| R-11 | MUST | Map the AADSTS codes of section 5.4 and 5.6 to distinct wizard messages with a remedy. | `server/setup/aadsts-map.test.ts` (one case per code), `quality` |
| R-12 | MUST | Every probe uses a fresh token (`skipCache: true`) and never decodes tokens of Microsoft APIs. | `server/setup/propagation-probe.test.ts` (asserts the request flag; lint rule or test forbids `decodeJwt` on those tokens), `quality` |
| R-13 | MUST | Replication-class failures (section 10.2) retry with backoff, jitter and a bounded window that is shown to the user; permanent errors never retry. | `server/setup/replication-retry.test.ts` (fake timers), `quality` |
| R-14 | MUST | Role propagation: default window 15 minutes, hard maximum 60; 401/403 inside the window is "propagating", after it a failure with the hint of section 4. | `server/setup/propagation-probe.test.ts`, `quality` |
| R-15 | MUST | `GraphClient` honours `Retry-After` (seconds or HTTP date), falls back to exponential backoff with jitter, retries 503 on a new connection, sends `x-ms-throttle-priority`, never retries a permanent error. | `server/graph-client.test.ts` (FR-B-012), `quality` |
| R-16 | MUST | `/authorize` carries `response_type=code`, tenant-specific authority, `scope=openid profile`, `state`, `nonce`, S256 PKCE, `response_mode=query`; no `offline_access`. | `server/auth/authorize-request.test.ts`, `quality` |
| R-17 | MUST | Redeem the code with a certificate assertion: `alg` PS256, `x5t#S256`, claims per section 2.4, `exp` at most 10 minutes after `nbf`; never a client secret. | `server/auth/client-assertion.test.ts` (verifies the produced JWT against the certificate public key; negative: wrong alg, long `exp`), `quality` |
| R-18 | MUST | Validate the ID token as in section 6.4 against the fake identity provider, including key rotation. | `server/auth/id-token-validation.test.ts` (matrix: wrong `iss`, `aud`, `tid`, `nonce`, expired, not yet valid, `alg` none/HS256, unknown `kid`, rotated JWKS, `ver` 1.0), `quality` |
| R-19 | MUST | JWKS cache: TTL 24 hours, scheduled refresh hourly, refresh on unknown `kid` at most every 5 minutes. | `server/auth/jwks-cache.test.ts` (fake clock), `quality` |
| R-20 | MUST | MFA gate (when enabled, B5): `amr` array contains `mfa`; absent or otherwise means denied and audited. | `server/auth/mfa-check.test.ts` (every row of the table in section 7 plus missing claim, string instead of array), `quality` |
| R-21 | MUST | Identity key is `oid` + `tid`; `sub`, `email`, `preferred_username`, `upn` never select a user. | `server/auth/identity-key.test.ts` (two tokens, same email different `oid`), `quality` |
| R-22 | MUST | Sign-out destroys the server session, clears the cookie, then redirects to `end_session_endpoint` with a registered `post_logout_redirect_uri`; "sign out everywhere" invalidates all sessions of the user. | `server/auth/logout.test.ts`, `e2e/auth-logout.spec.ts` against the fake identity provider, `e2e` |
| R-23 | MUST | Group-derived grants come only from `checkMemberGroups` in chunks of at most 20 bound ids; `groups`, `_claim_names`, `_claim_sources`, `hasgroups` in a token are ignored and never fetched; on Graph failure group-derived grants are denied and audited, direct assignments still apply. | `server/rbac/group-resolution.test.ts` (chunking at 21 ids, overage token, Graph 403/429), `quality` |
| R-24 | MUST | No code path calls an Exchange endpoint other than the documented Admin API URL pattern or the pwsh adapter. | `server/exchange/exchange-client-contract.test.ts` (MSW `onUnhandledFrame: 'error'`; asserts method POST, URL pattern, `X-AnchorMailbox`, body envelope), `quality` |
| R-25 | SHOULD | Offer the tenant-wide consent link of section 11.6 when a sign-in ends in `AADSTS90094`/`65001`. | review only (no automated control possible: needs a real tenant); owner-verified OV-12 |

Everything marked owner-verified in section 14 is explicitly **not** covered by an automated control.

## 14. Owner-verified (only provable against a real tenant)

| ID | What the owner checks | Why automation cannot |
|---|---|---|
| OV-01 | Device-flow consent screen for the three scopes with a Global Administrator, and with Privileged Role Administrator + Application Administrator; the "Consent on behalf of your organization" checkbox appears for the first only; leaving it off works (U23). | Microsoft's UI and policy. |
| OV-02 | Device code is allowed in the tenant; if not, the wizard shows the Conditional Access message and the manual mode works (U24). | Tenant policy. |
| OV-03 | `POST /applications`, `POST /servicePrincipals`, certificate `PATCH`, `http://localhost/...` redirect URIs and `amr` optional claim are accepted; credential lifetime of 360 days accepted (U14, U19, U20). | Real Graph validation. |
| OV-04 | The first client-credentials token with the uploaded self-signed certificate succeeds with `x5t#S256` only (U21). | Real Entra token endpoint. |
| OV-05 | All five application permissions are effective for Graph calls (`GET /organization`, `GET /users?$top=1`); measured delay after the grant. | Replication. |
| OV-06 | Exchange role propagation: measured delay; Admin API probe available or not; the pwsh verification (`Get-OrganizationConfig`, `Get-DistributionGroup -ResultSize 1`) passes; Exchange Recipient Administrator tried as an alternative (U4, U5, U6, U25). | Real Exchange. |
| OV-07 | Real ID token: `amr` present and its values for the owner's methods, `tid`, `oid`, no `groups`, `ver` 2.0, `alg` (U33); `auth_time` present; `prompt=login` behaviour; `max_age` ignored or honoured (U13, U27). | Real Entra. |
| OV-08 | A user in more than 200 groups: sign-in resolves roles through `checkMemberGroups`; nested group grants a role. | Real directory. |
| OV-09 | Sign-out round trip lands on the registered post-logout URI; no front-channel URL registered; behaviour with an existing PRT (U29). | Real Entra and browser. |
| OV-10 | Behaviour when Graph or Exchange really throttle (cannot be forced). | Microsoft limits. |
| OV-11 | Security Defaults tenant: wizard works for an administrator; a non-administrator Reader signs in with and without `mfa` in `amr` (B5). | Tenant policy. |
| OV-12 | A non-administrator with a panel role signs in on a tenant with user consent disabled; the consent link of section 11.6 fixes it (U30). | Tenant policy. |
| OV-13 | Image: the real container can create the certificate, run `pwsh`, and connect (B1). | Needs the tenant for the connect part. |

## 15. UNVERIFIED register (new; copy to `docs/open-points.md`, date 2026-10-10)

| # | Claim | Where used | Tried | Needed to close |
|---|---|---|---|---|
| U18 | Permissions and roles of `PATCH /applications(uniqueName=...)` upsert | idempotent create (2.1) | upsert page: headers, body and responses read; permission table not | Read the page; dev-tenant call |
| U19 | Maximum credential lifetime enforced by Graph (how-to says one year); whether the certificate `NotAfter` or the sent `endDateTime` wins; error text when an app management policy refuses | certificate step | how-to and `keyCredentialConfiguration` read | Dev-tenant PATCH with 360 and 800 days; with a policy |
| U20 | Minimum and maximum RSA key size, and EC, for uploaded certificates and `PS256` | certificate generation | none found | Dev-tenant test with 2048 and 3072 |
| U21 | `x5t` (SHA-1) header accepted or required; Learn lists only `x5t#S256`; SHA-1 is registered by default as `customKeyIdentifier` | client assertion | certificate-credentials, MSAL page; community claim in `stack-probe.md` | First real token (OV-04); fallback sends both headers |
| U22 | `slow_down` and default `interval` in Entra's device flow | polling | device-code page lists four errors | Dev-tenant observation; RFC 8628 handling meanwhile |
| U23 | Consent UI inside the device flow; who may self-consent to `AppRoleAssignment.ReadWrite.All` and `RoleManagement.ReadWrite.Directory` | wizard step 2 | consent-experience (snippet) | OV-01 |
| U24 | Whether the "Microsoft Graph Command Line Tools" enterprise app exists before first use; exact error shown when Conditional Access blocks device code | wizard step 2 | managed-policies, concept-authentication-flows | OV-02 |
| U25 | Production-use terms and SLA of the Admin API Preview; how to detect "not available in this organization" | probe | five Admin API pages read | Microsoft statement; probe result `inconclusive` is allowed |
| U26 | ExchangeOnlineManagement on Linux arm64, on Ubuntu 26.04 and on Debian | image base | module and PowerShell install pages | Test the chosen base; owner decision B1 |
| U27 | `claims` request with an `id_token` member (`amr`), `max_age`, and whether `auth_time` changes on SSO reuse | step-up (Phase D) | auth-code-flow, OIDC, claims-challenge | OV-07 |
| U28 | `ctxt` claim | brief item | search found no page | none; do not use |
| U29 | Front-channel logout request parameters (`iss`, `sid`) and Entra back-channel logout configuration | logout | OIDC page read | OV-09; Phase D if needed |
| U30 | Whether `openid profile` sign-in needs consent when user consent is disabled; whether `/adminconsent` with OIDC-only scopes works | first non-admin sign-in | consent pages (snippets) | OV-12 |
| U31 | Duplicate-assignment behaviour of `appRoleAssignedTo` and `roleAssignments`; `$filter` on `principalId` for role-assignment listing | idempotence | POST pages read | Dev-tenant test |
| U32 | Error codes for create-then-use chains (service principal right after application; grant right after service principal) | replication retry | 404 article, add-member note | Dev-tenant observation |
| U33 | ID token `alg` values other than RS256; clock-skew norm | validation | sample header only | OV-07 |

**Updates to the 001 register:** U16 is **closed** (section 10.1); U2 and U3 move to OV-01/OV-02 and U24; U4, U5, U6 move to OV-06 (U6 gains the `ManageAsApp` versus `ManageAsAppV2` token question); U13 and U14 extend as above; U8, U10 to U12, U15, U17 are Phase C/D and unchanged.

## 16. Owner decisions that depend on this evidence

**Labels.** The list of defaults that carries B1 to B5 was not among the files I could read. I label the five choices the evidence decides B1 to B5 in the order below and map them to the 001 decisions (OD-06, OD-07, OD-08); rename if your numbering differs. Silence means the default of 001 spec section 11 applies, except where stated.

| ID | Decision | Evidence | Recommendation |
|---|---|---|---|
| **B1** (OD-07) | Exchange execution path and runtime base | `InvokeCommand` has no Learn page. The Admin API is Preview, POST-only, six endpoints, no DL or contact writes. `pwsh` + module is the only documented path for Phase D; module supported on Ubuntu LTS only; module 3.10.0+ needs PowerShell 7.6+; arm64 and Debian unstated; container images from Microsoft are "for testing", build your own. The brief's own Phase B verification (`Get-DistributionGroup -ResultSize 1`) cannot use the Admin API. | **`pwsh` worker inside the one container on an Ubuntu 24.04 LTS runtime base**, PowerShell 7.6 and ExchangeOnlineManagement 3.10.0 or later pinned by version; decide now (ADR in Phase B), build only a verification adapter in Phase B (`Connect-ExchangeOnline -AppId ... -Certificate ... -Organization ...`, `Get-OrganizationConfig`, `Get-DistributionGroup -ResultSize 1`) behind the `ExchangeClient` interface. The Admin API stays an optional, non-blocking secondary probe (needs the extra `ManageAsAppV2` consent). Reject `InvokeCommand`. Cost: the distroless runtime of FR-A-160 changes, the image grows, arm64 must be tested (U26). **Fallback if you decline the base change:** Phase B verifies Graph plus the Admin API probe (outcome `inconclusive` allowed), and Phase D stays blocked until B1 is answered. |
| **B2** (OD-08, part) | Service-principal role in Exchange | Exchange Administrator is documented as sufficient "for any task"; assigning it needs only Graph (`roleAssignments`). Exchange Recipient Administrator maps to Recipient Management and satisfies the Admin API read endpoints, but sufficiency for `Add-DistributionGroupMember` and mail contacts is UNVERIFIED (U5). A custom role group needs an interactive Exchange PowerShell session and an unproven minimal role set (U5, U6). | **Exchange Administrator now** (default of 001 stays), stored as a setting `exchange_role` so it can change without code. Add an owner experiment to the Phase B test: swap in Exchange Recipient Administrator (`31392ffb-586c-42d1-9346-e59415a2cc4e`), rerun the verification, then try `Add-DistributionGroupMember` with and without `-BypassSecurityGroupManagerCheck` on a test list; report the result. A narrower default belongs in Phase D, with evidence. |
| **B3** (OD-08, part; brief 3) | Role of the wizard user and the delegated scope set | Global Administrator satisfies every call; documented minimum is Privileged Role Administrator (grants and role assignment) plus an app-registration role. `Directory.Read.All` is needed by no call. Three scopes cover all calls. | Accept **both** Global Administrator and Privileged Role Administrator + (Application Administrator or Cloud Application Administrator); the wizard prints the requirement before the sign-in. Request exactly `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`; **drop `Directory.Read.All`**; tell the administrator to leave "Consent on behalf of your organization" unchecked. |
| **B4** (OD-08, part) | Bootstrap fallback when device code is blocked | The Conditional Access device-code block applies to the flow, not the client; Microsoft's managed policy blocks it by default after a 30-day report-only period; `BOOTSTRAP_CLIENT_ID` therefore does not help against it. | Keep `BOOTSTRAP_CLIENT_ID` (it covers "Microsoft restricts its client"). Make the supported fallback a **manual provisioning mode**: the wizard generates the certificate, offers the public `.cer` for download, prints the exact portal or Cloud Shell steps for the same objects (app, service principal, certificate, redirect URIs, `amr`, grants, role), takes the client id back and verifies it with its own credential. In the blocked case the message also names the temporary Conditional Access exclusion. Defer a loopback authorization-code bootstrap (unverified redirect URIs on Microsoft's client). |
| **B5** (OD-08, part; OD-06 neutral) | MFA policy | `amr` is an optional claim; `mfa` is emitted only after MFA; Security Defaults prompts non-administrators only "when necessary"; `prompt=login` does not force MFA; `max_age` and an `id_token` `claims` request are unverified. | Keep the 001 default: **`AUTH_REQUIRE_MFA=true`**, check `amr` contains `mfa`. When it fails, show a specific page ("sign-in without MFA; ask your administrator to enable Security Defaults or a Conditional Access MFA policy") and allow **one** retry with `prompt=login`; never loop. Switching it off is an audited, visible setting. Always enforce it for the Owner role. Test with both a Conditional Access and a Security Defaults tenant (OV-11). Do not build step-up on `max_age`. |

**Further choices that follow from this evidence (no B number):**

- **E1 Certificate lifetime and rotation.** Maximum one year per upload (how-to); recommend 360 days with a visible expiry in the status page and rotation by `addKey` signed with the current key (Phase D), not a hidden re-run. A lapsed certificate needs the wizard re-run with an administrator.
- **E2 Second Exchange app role.** Grant `Exchange.ManageAsAppV2` only if the Admin API probe is kept (B1); otherwise only `Exchange.ManageAsApp`.
- **E3 Delegated consent for panel sign-in.** Recommend *not* adding `DelegatedPermissionGrant.ReadWrite.All` to the bootstrap scopes; offer the tenant-wide consent link of section 11.6 when needed (U30).
- **E4 Certificate generation dependency.** Node has no X.509 creation API (checked locally); the plan must pick and justify a library or a bundled tool and prove it in the `image` smoke test.

## 17. Changes to the 001 research and the brief

| # | Earlier statement | Now |
|---|---|---|
| 1 | Brief 3: bootstrap scopes include `Directory.Read.All` | Not needed by any call (already corrected in 001); three scopes. |
| 2 | 001 O5: `BOOTSTRAP_CLIENT_ID` is the answer when device code is blocked | Only when Microsoft restricts its client; a Conditional Access flow block applies to every client. |
| 3 | Brief 3: five wizard scopes consented "interactively" | Three scopes; per-user consent is enough; tenant-wide consent for Microsoft's client is not wanted. |
| 4 | 001 3.3/5.6: certificate and `x5t#S256` | Unchanged, plus: maximum lifetime one year, do not set `customKeyIdentifier`, self-signed accepted but discouraged. |
| 5 | 001 6.1: U16 | Closed: all directory resources share the identity-and-access limits. |
| 6 | 001 5.2: `max_age` unverified | Still unverified; also `claims` with `id_token`. |
| 7 | Brief 6: SameSite rules | `response_mode=query` is required for the Lax state cookie to work; `form_post` (Learn's recommendation) conflicts with it. |
| 8 | Brief 3 step 4: Exchange verification with `Get-DistributionGroup -ResultSize 1` | Only possible through `pwsh` (Admin API has no such endpoint). |
| 9 | Brief 3: Exchange roles and resource | Two different app roles exist (`ManageAsApp`, `ManageAsAppV2`); the Admin API uses the second. |
