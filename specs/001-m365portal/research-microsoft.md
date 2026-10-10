# Microsoft Learn verification

> **Date:** 2026-10-10. **Scope:** every Microsoft claim in `docs/build-prompt.md` that feeds
> `docs/permissions.md` and `docs/security.md`. **Method:** Microsoft Learn only (search, fetch,
> code-sample search). Nothing below was taken from memory; a claim I could not find on Learn is
> marked UNVERIFIED and listed in the register at the end (copy it to `docs/open-points.md`).

Status legend: **verified** = Learn states it as written. **corrected** = the brief is wrong or
incomplete; the Learn-backed wording is given. **UNVERIFIED** = not found on Learn.

## 0. What changes in the brief

| # | Brief says | Learn says | Impact |
|---|---|---|---|
| 1 | Graph app permissions "minimaal `User.ReadWrite.All`, `Group.ReadWrite.All`, `GroupMember.ReadWrite.All`, `Directory.Read.All`, `Organization.Read.All`" | For the operations the product has (read users, add/remove group members, read org) the least-privileged application permissions are `User.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All` (plus `GroupMember.Read.All` to list groups). `User.ReadWrite.All`, `Group.ReadWrite.All` and `Directory.Read.All` are "higher privileged" for every one of these calls. | permissions.md: shrink the set (owner decision O1). |
| 2 | Wizard asks delegated `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`, `Directory.Read.All` | The first three are the documented scopes for their calls. `Directory.Read.All` is not needed by any wizard call. Creating the app registration alone lists `AppRegistration.Create` as least privileged. | permissions.md wizard table. |
| 3 | Requesting user is a "tijdelijke Global Administrator" | Global Administrator is sufficient, not necessary. Documented minimum: Privileged Role Administrator (app-role consent for Graph, Entra role assignment) plus a role allowed to register apps. | Offer both in wizard text (O4). |
| 4 | Exchange REST `InvokeCommand` endpoint | **Not documented on Learn.** Learn documents the Exchange Online Admin API (Preview): `POST {base}/adminapi/v2.0/{TenantID}/{Endpoint}` with a `CmdletInput` body. Its documented scope is four functions (organization config, distribution and dynamic distribution group *membership view*, mailbox folder permissions, send-on-behalf) over six endpoints; `Get-DistributionGroup`, `Add-/Remove-DistributionGroupMember` and every `*-MailContact` cmdlet are outside that list. | The pwsh fallback is the only documented path for Phase D writes (O2). |
| 5 | `Exchange.ManageAsApp` | Correct for Exchange Online PowerShell. The Admin API documents a different app role, `Exchange.ManageAsAppV2`. | Two roles; do not mix. |
| 6 | MFA enforcement "via de `amr`/`acr`-claim" | `amr` is an *optional* claim in v2.0 tokens (must be requested). `acr` is documented as v1.0-only. Authentication context uses the `acrs` claim and a claims request. | security.md OIDC section (O6). |
| 6b | Users list shows "licenties" (brief section 4) | `GET /users/{id}/licenseDetails` documents **"Application: Not supported."** (delegated only). The `assignedLicenses` user property was not found on a page that states its permission. | UNVERIFIED U17; Phase C must not assume app-only licence detail. |
| 7 | Groups-overage: resolve via Graph | Correct. Limits are 200 (JWT), 150 (SAML), 5-6 (implicit); detection is `_claim_names.groups` or `hasgroups`; do not call the URL inside `_claim_sources`. | Keep; use `checkMemberGroups`. |
| 8 | Throttling 429 + `Retry-After` | Correct for Graph. No Learn page publishes Exchange Online PowerShell/REST throttling limits for app-only. | UNVERIFIED U7. |

---

## 1. Graph application permissions

### 1.1 Names and meanings (claim 1a: verified)

All five exist as application permissions (app roles) and need admin consent. Source for every row:
https://learn.microsoft.com/en-us/graph/permissions-reference

| Permission | App role id | Learn description (application) | Notes |
|---|---|---|---|
| `User.ReadWrite.All` | `741f803b-c850-494e-b5df-cde7c675a1ca` | "Read and update user profiles without a signed in user." | Cannot update `passwordProfile` and `employeeLeaveDateTime`. |
| `Group.ReadWrite.All` | `62a82d76-70ea-41e2-9197-370581804d09` | "create groups, read all group properties and memberships, update group properties and memberships, and delete groups. Also ... read and write conversations." | For M365 groups also grants access to group content (conversations, files, notes). |
| `GroupMember.ReadWrite.All` | `dbaae8cf-10b5-4b86-a4a1-f871c94c6695` | "list groups, read basic properties, read and update the membership of the groups this app has access to ... Group properties and owners cannot be updated and groups cannot be deleted." | The narrow one. |
| `Directory.Read.All` | `7ab1d382-f21e-4acd-a863-ba3e13f7da61` | "read data in your organization's directory, such as users, groups and apps." | Page carries a caution: "Whenever possible, choose permissions specific to these resources and avoid using directory permissions." |
| `Organization.Read.All` | `498476ce-e0fe-48b0-b801-37ba7e2685c6` | "read the organization and related resources ... subscribed skus and tenant branding information." | |

Related ids used below: `User.Read.All` `df021288-bdef-4463-88db-98f22de89214`,
`GroupMember.Read.All` `98830695-27a2-44f7-8c18-0c3ebc9698f6`, `Directory.ReadWrite.All`
`19dbc75e-c2e2-444c-a770-ec69d8559fc7`, `Application.ReadWrite.All`
`1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9`, `AppRoleAssignment.ReadWrite.All`
`06b708a9-e830-4db3-a914-8e69da51d44f`, `RoleManagement.ReadWrite.Directory`
`9e3f62cf-ca93-4989-b6ce-bf83c28f9fe8` (same page). Resolve ids at runtime from the tenant's
`Microsoft Graph` service principal (`appId` `00000003-0000-0000-c000-000000000000`, see the
request shown on the permissions-reference intro) instead of hardcoding them.

### 1.2 Least privileged application permission per operation (claim 1b: corrected)

| Operation | API | Least privileged (application) | Higher privileged | Learn page |
|---|---|---|---|---|
| List/read users | `GET /users` | `User.Read.All` | `User.ReadWrite.All`, `Directory.Read.All`, `Directory.ReadWrite.All` | https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0 |
| Read `accountEnabled` | same | `User.Read.All` (+ `User.EnableDisableAccount.All` only to *write* it) | | same page, "Permissions for specific scenarios" |
| User's groups (display) | `GET /users/{id}/transitiveMemberOf` | `User.Read.All` | `Directory.Read.All`, `Group.Read.All`, `GroupMember.Read.All`, ... | https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof?view=graph-rest-1.0 |
| Add member | `POST /groups/{id}/members/$ref` | `GroupMember.ReadWrite.All` | `Directory.ReadWrite.All`, `Group.ReadWrite.All` (listed as higher in the remove-member page; the add-member table lists only `GroupMember.ReadWrite.All` for user/group members) | https://learn.microsoft.com/en-us/graph/api/group-post-members?view=graph-rest-1.0 |
| Remove member | `DELETE /groups/{id}/members/{id}/$ref` | `GroupMember.ReadWrite.All` | `Directory.ReadWrite.All`, `Group.ReadWrite.All` | https://learn.microsoft.com/en-us/graph/api/group-delete-members?view=graph-rest-1.0 |
| List members | `GET /groups/{id}/members` | `GroupMember.ReadBasic.All`; member objects of type user come back as `id` + `@odata.type` only unless the app also has a user-read permission | `Directory.Read.All`, `Group.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, ... | https://learn.microsoft.com/en-us/graph/api/group-list-members?view=graph-rest-1.0 and https://learn.microsoft.com/en-us/graph/permissions-overview#limited-information-returned-for-inaccessible-member-objects |
| Read org info | `GET /organization` | `Organization.Read.All` (`User.Read` is delegated-only and returns only `id`, `displayName`, `verifiedDomains`) | `Directory.Read.All`, `Organization.ReadWrite.All`, `Directory.ReadWrite.All` | https://learn.microsoft.com/en-us/graph/api/organization-get?view=graph-rest-1.0 |
| Resolve a user's membership in the panel's role groups | `POST /users/{id}/checkMemberGroups` (max 20 group ids, transitive) | `User.ReadBasic.All` + `GroupMember.Read.All` | `User.Read.All` + `GroupMember.Read.All`, `Directory.Read.All`, ... | https://learn.microsoft.com/en-us/graph/api/directoryobject-checkmembergroups?view=graph-rest-1.0 |

Answers to the three questions asked:

- **Is `User.Read.All` enough instead of `User.ReadWrite.All`?** Yes for reading users: list,
  detail, `accountEnabled`, groups of a user. `User.ReadWrite.All` is only needed if the product
  writes user properties, which no phase does. Verdict: **corrected**. Exception: the "licenties"
  column. `GET /users/{id}/licenseDetails` lists "Application: Not supported"
  (https://learn.microsoft.com/en-us/graph/api/user-list-licensedetails?view=graph-rest-1.0), so
  licence detail cannot come from that call app-only. The `assignedLicenses` user property
  and the beta `cloudLicensing` assignment APIs (`CloudLicensing.Read.All`, with `User.Read.All`
  listed as higher privileged) were seen only as search snippets; **UNVERIFIED (U17)**.
- **What does "add member" list as least privileged?** `GroupMember.ReadWrite.All` for user,
  group and orgContact (orgContact additionally needs `OrgContact.Read.All`; device and
  service principal need extra permissions). `Group.ReadWrite.All` is not required. Verdict:
  **corrected** (brief lists `Group.ReadWrite.All`).
- **Restriction for role-assignable groups?** Yes. Add and remove member on a role-assignable group
  needs the app to hold `RoleManagement.ReadWrite.Directory` as well, otherwise Graph returns 403
  (add-member page: "To add members to a role-assignable group, the app must also be assigned the
  *RoleManagement.ReadWrite.Directory* permission"; troubleshooting page step 3). Verdict:
  **verified**. `RoleManagement.ReadWrite.Directory` lets an app "grant additional privileges to
  itself, other applications, or any user" (permissions reference caution). Do not grant it to the
  runtime app; show role-assignable groups as read-only (`isAssignableToRole`, group resource
  https://learn.microsoft.com/en-us/graph/api/resources/groups-overview?view=graph-rest-1.0).

### 1.3 Group types Graph cannot manage (claim 1c: verified)

Source: https://learn.microsoft.com/en-us/graph/api/resources/groups-overview?view=graph-rest-1.0 and
https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/users-groups-entra-apis/authorization-requestdenied-403-error-add-user-group

| Type | `groupTypes` / `mailEnabled` / `securityEnabled` | Managed via Graph |
|---|---|---|
| Microsoft 365 group | `["Unified"]` / true / true or false | Yes |
| Security group | `[]` / false / true | Yes |
| Mail-enabled security group | `[]` / true / true | **No (read-only)** |
| Distribution group | `[]` / true / false | **No (read-only)** |
| Dynamic distribution group | n/a | Not supported in Graph |
| Dynamic-membership group (`groupTypes` contains `DynamicMembership`) | | Membership "can't be managed through Microsoft Graph"; remove-member page: "You can't remove a member from groups with dynamic memberships." |

This confirms the brief's "Graph kan geen leden aan distributielijsten toevoegen". Add-member
returns `403` for groups Graph cannot manage, `400` when the object is already a member or the
group was created seconds ago (retry after a brief delay). `PATCH /groups/{id}` with
`members@odata.bind` adds up to 20 members per request.

On-premises synced *security* groups: the Graph add-member page does not mention them, and I found
no Learn page stating the Graph behaviour. **UNVERIFIED (U8)**: read `onPremisesSyncEnabled` and
treat as read-only; confirm the error in a dev tenant.

### 1.4 Open points inside claim 1

- **`GET /groups` least privileged is odd (UNVERIFIED, U1).** The list-groups and get-group pages
  print `Group-NestingSupport.ReadWrite.All` as "least privileged" (a write permission for the
  `disableNesting` property) and do not list `GroupMember.ReadWrite.All` at all. The overview page
  (https://learn.microsoft.com/en-us/graph/permissions-overview#best-practices-for-using-microsoft-graph-permissions)
  says an app that reads groups needs "only the *GroupMember.Read.All* application permission".
  Plan: request `GroupMember.Read.All` in addition to `GroupMember.ReadWrite.All` and test whether
  the latter alone lists groups (its description says "list groups").
- **Hidden-membership groups** need `Member.Read.Hidden` for application permissions; without it
  those groups are omitted from `checkMemberGroups` and `members` results (checkMemberGroups page,
  "Important"). A panel role bound to such a group would silently never match (fails closed).
  Document it; do not request `Member.Read.Hidden` by default.
- **Groups in restricted-management administrative units** (`isManagementRestricted`) need an Entra
  role at that AU scope (groups resource, property table). Treat 403 as "read-only".

### 1.5 Recommended application permission set (owner decision O1)

| Permission | Why (one line for permissions.md) |
|---|---|
| `User.Read.All` | List and read users and their group memberships. |
| `GroupMember.Read.All` | List groups and their memberships (see U1). |
| `GroupMember.ReadWrite.All` | Add and remove members of security and M365 groups. |
| `Organization.Read.All` | Show tenant name, verified domains, SKUs; wizard verification. |

Not requested: `User.ReadWrite.All`, `Group.ReadWrite.All`, `Directory.Read.All`,
`RoleManagement.ReadWrite.Directory`. If the owner wants `Directory.Read.All` back as a single
convenience permission, say so in permissions.md, because Learn warns against it.

---

## 2. Wizard bootstrap with "Microsoft Graph Command Line Tools"

### 2.1 Client id and device code (claims 2a, 2b)

| Claim | Status | Evidence / notes |
|---|---|---|
| `14d82eec-204b-4c2f-b7e8-296a70dab67e` is "Microsoft Graph Command Line Tools" | **verified** | Listed among Microsoft tenant-owned applications: https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/governance/verify-first-party-apps-sign-in |
| It is what `Connect-MgGraph` uses by default | **UNVERIFIED (U2)** | The Learn `Get-MgContext` sample prints `ClientId : 615e6e7c-aa11-4402-91a1-6234967405d5`, `AppName : Microsoft Graph PowerShell` (https://learn.microsoft.com/en-us/powershell/module/microsoft.graph.authentication/get-mgcontext?view=graph-powershell-1.0). Learn does not reconcile the two ids. Keep the `BOOTSTRAP_CLIENT_ID` override. |
| Device code flow works with the default app | **verified** | `Connect-MgGraph -Scopes ... -UseDeviceAuthentication` (alias of `-UseDeviceCode`) is the documented usage: https://learn.microsoft.com/en-us/powershell/microsoftgraph/authentication-commands?view=graph-powershell-1.0 |
| The app is a *public client* | **UNVERIFIED (U2)** | No page read states the client type. General rule (verified): "The device code flow is available only for public client applications" (https://learn.microsoft.com/en-us/entra/identity-platform/msal-authentication-flows). Treat as inference from the previous row. |
| Custom bootstrap app (the `BOOTSTRAP_CLIENT_ID` case) | **verified** | Learn documents a custom public-client registration with "Allow public client flows" = Yes and a `Connect-MgGraph -ClientId <id> -TenantId <tenant>` call (same authentication-commands page; https://learn.microsoft.com/en-us/graph/tutorials/dotnet#register-an-application-for-user-authentication). |
| Sovereign clouds | **verified** | `BleuCloud`, `DelosCloud`, `GovSGCloud` "require you to register a custom application. You can't use the default Microsoft Graph PowerShell application"; "Globally registered apps don't replicate to Azure China" (authentication-commands page). Out of scope for the product unless the owner adds clouds. |

### 2.2 Delegated scopes (claim 2c: partly corrected)

| Wizard action | API | Least privileged delegated scope on Learn | Brief | Status |
|---|---|---|---|---|
| Create app registration | `POST /applications` | `AppRegistration.Create` (higher: `Application.ReadWrite.All`) | `Application.ReadWrite.All` | corrected (but see next row) |
| Create service principal | `POST /servicePrincipals` | `Application.ReadWrite.All` | same | **verified** |
| Upload certificate, set redirect URIs, optional claims | `PATCH /applications/{id}` or `POST /applications/{id}/addKey` | `Application.ReadWrite.All` | same | **verified** |
| Grant Graph application permissions (admin consent) | `POST /servicePrincipals/{id}/appRoleAssignedTo` | `AppRoleAssignment.ReadWrite.All` + `Application.Read.All` | `AppRoleAssignment.ReadWrite.All` | **verified** |
| Grant `Exchange.ManageAsApp` (non-Graph app role) | same call | same; `Application.ReadWrite.All` also "allows management of app role assignments, except those exposed by Microsoft Graph" | | **verified** |
| Assign Entra role to the service principal | `POST /roleManagement/directory/roleAssignments` | `RoleManagement.ReadWrite.Directory` (only option) | same | **verified** |
| Read directory | | `Directory.Read.All` appears only as a "higher privileged" alternative to `Application.Read.All` | listed | **corrected: not required** |

Since the wizard needs `Application.ReadWrite.All` anyway for service-principal creation and
updates, it need not also request `AppRegistration.Create`. Sources:
https://learn.microsoft.com/en-us/graph/api/application-post-applications?view=graph-rest-1.0,
https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-serviceprincipals?view=graph-rest-1.0,
https://learn.microsoft.com/en-us/graph/api/application-update?view=graph-rest-1.0,
https://learn.microsoft.com/en-us/graph/api/application-addkey?view=graph-rest-1.0,
https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto?view=graph-rest-1.0,
https://learn.microsoft.com/en-us/graph/api/rbacapplication-post-roleassignments?view=graph-rest-1.0.

Role assignment takes `roleDefinitionId` as either the role template id or the tenant role
definition id ("Note the use of the roleTemplateId for roleDefinitionId"), so no role-definition
lookup (and no `Directory.Read.All`) is needed. Template ids (https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference):
Exchange Administrator `29232cdf-9323-42fd-ade2-1d097af3e4de`, Exchange Recipient Administrator
`31392ffb-586c-42d1-9346-e59415a2cc4e`. Request body: `principalId`, `roleDefinitionId`,
`directoryScopeId` = `/`.

All four delegated scopes require admin consent ("AdminConsentRequired: Yes" for delegated
`Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`,
`Directory.Read.All`; permissions reference).

### 2.3 Entra role of the requesting user (claim 2d: corrected nuance)

- Grant Microsoft Graph app roles: "Privileged Role Administrator - the least privileged role
  supported for Microsoft Graph and Azure AD Graph app roles" (appRoleAssignedTo page). The task
  table agrees: "Consent to application permissions to Microsoft Graph" = Privileged Role
  Administrator; "Consent to application permissions not including Microsoft Graph" = Cloud
  Application Administrator (https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/delegate-by-task).
  So `Exchange.ManageAsApp` can be consented by a Cloud Application Administrator, the Graph
  roles need Privileged Role Administrator.
- Create a directory role assignment (Entra role for the service principal): "Privileged Role
  Administrator is the least privileged role supported" (roleAssignments page).
- Permissions overview says "Only Privileged Role Administrator and Global Administrator can consent
  to application permissions" (https://learn.microsoft.com/en-us/graph/permissions-overview#permission-types);
  the two pages differ for non-Graph resources, so the wizard should ask for Global Administrator or
  Privileged Role Administrator and not rely on the narrower reading.
- Register the app / create the SP / upload the certificate: Application Administrator or Cloud
  Application Administrator (others listed on those pages); a default member user can create an app
  unless the tenant restricted it.
- So: Global Administrator works (superset); the documented minimum is Privileged Role Administrator
  plus an app-registration-capable role. The brief's "Global Administrator" is **verified as
  sufficient**, not as required (O4).

### 2.4 Arbitrary tenant without pre-authorisation (claim 2e)

| Fact | Status | Source |
|---|---|---|
| Graph PowerShell permissions "aren't pre-authorized and users must perform one-time request for app permissions" | verified | https://learn.microsoft.com/en-us/powershell/microsoftgraph/overview?view=graph-powershell-1.0 |
| "You need to sign in with an admin account to consent to the required scopes" | verified | https://learn.microsoft.com/en-us/powershell/microsoftgraph/get-started?view=graph-powershell-1.0 |
| So a Global Administrator signing in gets a consent prompt for those four scopes; no pre-authorisation exists | verified (inference from the two rows) | |
| Exact error shown to a non-admin | UNVERIFIED (U3) | Not read. |
| A tenant can block the flow: enterprise app "Assignment required" with user assignment | verified | authentication-commands page (custom-app steps 11-15 show how to require assignment) |
| A tenant can block device code flow with Conditional Access; Microsoft "recommends blocking device code flow wherever possible" and calls it "a high-risk authentication method" | verified | https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-authentication-flows and https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-block-authentication-flows |
| Tenant user-consent settings / admin-consent workflow can interfere | verified in general | https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/user-admin-consent-overview |

Consequence for the wizard: ship the `BOOTSTRAP_CLIENT_ID` override and a clear "device code is
blocked in this tenant" message (O5). Do not claim the Microsoft client works in every tenant.

---

## 3. Exchange Online app-only (certificate) authentication

Primary source: https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2?view=exchange-ps

### 3.1 App role and resource (claim 3a: verified)

| Item | Value |
|---|---|
| Resource | "Office 365 Exchange Online" |
| Resource `appId` | `00000002-0000-0ff1-ce00-000000000000` |
| App role | `Exchange.ManageAsApp` |
| App role id | `dc50a0fb-09a3-484d-be87-e023b12c6440` (`"type": "Role"` in `requiredResourceAccess`) |
| Admin consent | Required; grant tenant-wide |
| Security & Compliance variant (not needed) | resource `00000007-0000-0ff1-ce00-000000000000`, role `455e5cd2-84e8-4751-8344-5672145dfa17` |
| Default Graph `User.Read` delegated permission | Learn tells admins to revoke its consent; the wizard should simply not add it |

### 3.2 Service-principal role (claim 3b: verified, with a gap)

Learn gives three options (same page, "Step 5"):

1. **Entra role** on the service principal. Supported roles for Exchange Online PowerShell:
   Compliance Administrator, **Exchange Administrator**, **Exchange Recipient Administrator**,
   Global Administrator, Global Reader, Helpdesk Administrator, Security Administrator, Security
   Reader. "The Global Administrator and Exchange Administrator roles provide the required
   permissions for any task in Exchange Online PowerShell. For example: Recipient management."
2. **Custom Exchange role group** (least privilege): `New-ServicePrincipal -AppId -ObjectId
   -DisplayName`, then `Add-RoleGroupMember -Identity "<role group>" -Member <sp identity>`. Needs a
   session in Exchange Online PowerShell as an admin.
3. Both combined (RBAC is the union).

Gaps and checks:

- **Exchange Recipient Administrator** is listed as supported and its Entra definition is
  "create and delete all recipients, and read and update all properties of recipients" (permissions
  reference). Whether it covers `Add-DistributionGroupMember` on groups the service principal does
  not own is **UNVERIFIED (U5)**; test in a dev tenant before choosing it.
- **`-BypassSecurityGroupManagerCheck`.** `Add-/Remove-DistributionGroupMember` require the caller
  to be in the group's `ManagedBy` unless this switch is used. The switch needs "a member of the
  Organization Management role group or ... the Security Group Creation and Membership role"
  (cmdlet pages). Exchange Administrator "is equivalent to the Organization Management role group"
  (https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/concept-understand-roles),
  so option 1 with Exchange Administrator satisfies it. The built-in *Recipient Management* role
  group holds Distribution Groups, Mail Recipient Creation, Mail Recipients, ... but **not**
  Security Group Creation and Membership
  (https://learn.microsoft.com/en-us/exchange/permissions-exo/permissions-exo). A custom role group
  must therefore add that role, or the service principal must own every list. Verdict: **verified
  that the switch exists and what it needs**; the exact minimal custom role set is **UNVERIFIED
  (U5)**.
- `New-ServicePrincipal` parameter set. The how-to uses `-AppId -ObjectId -DisplayName`; the cmdlet
  reference lists `-AppId`, `-ObjectId` and `-ServiceId` as mandatory
  (https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-serviceprincipal?view=exchange-ps).
  **UNVERIFIED (U6)** which is current; test.
- Recipient scoping at the Exchange side exists: `New-RoleGroup ... -CustomRecipientWriteScope`
  (https://learn.microsoft.com/en-us/exchange/permissions-exo/role-groups). The Learn page "Role Based
  Access Control for Applications in Exchange Online" is a different feature (mailbox data via Graph/EWS
  application roles) and does not apply to `Exchange.ManageAsApp`.
- Wizard consequence: option 1 is doable with Graph REST only (section 2.2). Option 2 needs an
  interactive Exchange PowerShell session (`Connect-ExchangeOnline -Device` is documented for
  PowerShell 7: https://learn.microsoft.com/en-us/powershell/exchange/connect-to-exchange-online-powershell?view=exchange-ps),
  so it needs the pwsh runtime inside the wizard (O3).
- Propagation delay between the role assignment and a working Exchange token: **UNVERIFIED (U4)**.
  Learn says only that "the Directory Role ... is returned in the access token", so a token cached
  before the assignment will not carry it (inference): request a fresh token during the wizard's
  retry loop. The "30 minutes to 2 hours" cache figure on the Application RBAC page applies to that
  other feature only.

### 3.3 Certificate requirements (claim 3c: verified)

For the Exchange Online PowerShell module (same page, step 3): X.509 certificate with an
**exportable private key** and the public certificate (`.cer`); self-signed, internal-PKI or
commercial CA are all allowed; "Cryptography: Next Generation (CNG) certificates aren't supported";
`-CertificateThumbprint` "is supported only in Microsoft Windows" (so on Linux use `-Certificate <X509Certificate2>`
or `-CertificateFilePath` + `-CertificatePassword`); `-Organization` must be the primary
`.onmicrosoft.com` domain.

For the Entra client-assertion token request (any language), see 5.6. Learn says `PS256`
(RSA-PSS) is the assertion algorithm, so use an RSA key (inference; no EC statement found).

### 3.4 Token audience / scope (claim 3d: verified)

Client credentials: `POST https://login.microsoftonline.com/{TenantID}/oauth2/v2.0/token` with
`grant_type=client_credentials` and `scope=https://outlook.office365.com/.default`, certificate via
`client_assertion` (https://learn.microsoft.com/en-us/exchange/reference/admin-api-authentication, "Client credentials
flow"). The admin-consent URL uses the same resource:
`https://login.microsoftonline.com/<tenant-id>/adminconsent?client_id=<client-id>&scope=https://outlook.office365.com/.default`.
The Exchange cmdlets themselves are run through the module, which fetches its own token.

### 3.5 Is a REST `InvokeCommand` endpoint documented? (claim 3e: **UNVERIFIED**, and corrected)

Searched Learn for `InvokeCommand`, `adminapi`, "Exchange Online Admin API", EXO V3 REST internals
and the code-sample index. **No page documents an `InvokeCommand` endpoint.** What Learn documents:

**A. Exchange Online Admin API (Preview)**
(https://learn.microsoft.com/en-us/exchange/reference/admin-api-overview,
`.../admin-api-get-started`, `.../admin-api-authentication`, `.../admin-api-endpoints-reference`)

| Item | Documented value |
|---|---|
| Status | "currently in Preview, aren't available in all organizations, and are subject to change"; built for EWS-deprecation scenarios (EWS "planned for deprecation in October 2026") |
| URL | `POST <BaseUrl>/adminapi/v2.0/<TenantID>/<EndpointName>`; base `https://outlook.office365.com` (GCC), `.cn`, `outlook.office365.us` (GCC High), `outlook-dod.office365.us` (DoD) |
| Body | `{"CmdletInput":{"CmdletName":"<cmdlet>","Parameters":{...}}}`, POST for every call including `Get-*` |
| Headers | `Authorization: Bearer`, `Content-Type: application/json`, **`X-AnchorMailbox` mandatory** (app-only: `APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@<tenantIdOrOrganization>`) |
| Auth | Delegated `Exchange.ManageV2`; app-only `Exchange.ManageAsAppV2`; scope `https://outlook.office365.com/.default`. The same page's verification step names `Exchange.ManageAsApp`, so the role name is inconsistent inside Learn; app role id for `ManageAsAppV2` not given (UNVERIFIED U6). |
| RBAC | Per endpoint: `/OrganizationConfig`, `/AcceptedDomain` need *View-Only Organization Management*; `/Mailbox`, `/MailboxFolderPermission`, `/DistributionGroupMember`, `/DynamicDistributionGroupMember` need *Recipient Management*. Entra role or custom role group both allowed. |
| Endpoints | `AcceptedDomain`, `DistributionGroupMember`, `DynamicDistributionGroupMember`, `Mailbox`, `MailboxFolderPermission`, `OrganizationConfig` |
| Supported cmdlets per endpoint | Each endpoint accepts only the cmdlets and parameters on its own page; anything else returns `400 Bad Request`. Read in full: `/DistributionGroupMember` supports **only** `Get-DistributionGroupMember` with `Identity` (required) and `ResultSize`; `/OrganizationConfig` supports **only** `Get-OrganizationConfig` with no parameters. The other four endpoint pages were read only as index entries. |
| Paging | `ResultSize` sets the page size, default 1,000 (`Unlimited` where supported); `@odata.nextLink` valid "5-10 minutes"; `$select` supported |
| Throttling | "Implement retry logic for throttling (HTTP 429) and honor Retry-After" |

Not covered by the Admin API's documented scope (overview lists four functions: organization
config, DL/DDL membership *view*, mailbox folder permissions, send-on-behalf; the endpoint list has
no distribution-group or contact endpoint): `Get-DistributionGroup`, `Add-DistributionGroupMember`,
`Remove-DistributionGroupMember`, `Get-/New-/Set-/Remove-MailContact`. The brief's design (REST
`InvokeCommand` for those cmdlets) therefore has **no documented REST path**. Only the Phase B
verification calls `Get-OrganizationConfig` and `Get-DistributionGroupMember` could use the Preview
API (the brief's `Get-DistributionGroup -ResultSize 1` verification call cannot).

**B. EXO V3 module "REST API connections".** Learn states all cmdlets are REST-backed since 2023,
"REST API cmdlets ... work just like their remote PowerShell equivalents", with a **15-minute
timeout** per REST-backed cmdlet
(https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2?view=exchange-ps).
The wire protocol of that connection is not documented, so reimplementing it is unsupported.

**pwsh fallback facts (needed to decide early):**
- Linux support is listed **only for Ubuntu LTS** (24.04, 22.04, 20.04, 18.04). Debian, Alpine and
  distroless are not listed (UNVERIFIED for them, U9).
- Module 3.10.0 or later "require PowerShell 7.6.0 ... or later"; 3.5.0 to 3.9.2 require 7.4.0+.
- `Invoke-Command` does not work in REST connections; Learn gives alternatives
  (https://learn.microsoft.com/en-us/powershell/exchange/invoke-command-workarounds-rest-api?view=exchange-ps).
- Bulk: use `Update-DistributionGroupMember` for up to ~5,000, add the rest with
  `Add-DistributionGroupMember` in a loop (same module page).
- Connection with certificate object on Linux: `Connect-ExchangeOnline -AppId <id> -Certificate
  <X509Certificate2> -Organization <tenant>.onmicrosoft.com`
  (https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/connect-exchangeonline?view=exchange-ps).
- Unattended app-only does not work with `Add-UnifiedGroupLinks`, `Remove-UnifiedGroupLinks`,
  `New-UnifiedGroup`, `Remove-UnifiedGroup`; Learn points to Graph for M365 groups. This matches
  the product split (M365 groups via Graph).

---

## 4. Exchange cmdlets and parameters (claim 4)

Pages: `https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/<cmdlet>?view=exchange-ps`.
All nine exist and are available in Exchange Online (the pages say "available in on-premises
Exchange and in the cloud-based service"). `Set-MailContact` and `Get-OrganizationConfig` were
checked through Learn's syntax and description index entries rather than a full-page read; the
parameters quoted below were all printed there.

| Cmdlet | Parameters the brief relies on | Result |
|---|---|---|
| `Get-DistributionGroup` | `-Identity` (optional, position 1), `-ResultSize` (default 1000, `Unlimited`) exist. **No** `-DisplayName`, `-Name`, `-Alias`. Search with `-Anr <string>` (CN, DisplayName, FirstName, LastName, Alias) or `-Filter` (OPATH). Also `-RecipientTypeDetails` (`MailNonUniversalGroup`, `MailUniversalDistributionGroup`, `MailUniversalSecurityGroup`, `RoomList`), `-SortBy` (`Name`, `DisplayName`, `Alias`, `City`, `FirstName`, `LastName`, `Office`, `ServerLegacyDN`), `-ManagedBy`, `-Include*WithDisplayNames` switches. | verified; note `$null` or non-existent `-Identity` returns **all** objects (page caution) so validate before calling. |
| `Get-DistributionGroupMember` | `-Identity` (mandatory), `-ResultSize` (default 1000). **No `-Member`.** `-IncludeSoftDeletedObjects` is cloud-only. | verified |
| `Add-DistributionGroupMember` | `-Identity` (mandatory), `-Member` (name, alias, DN, email, GUID), `-BypassSecurityGroupManagerCheck`. "add a single recipient". Supported members: `UserMailbox`, `SharedMailbox`, `RoomMailbox`, `EquipmentMailbox`, `MailUser`, `MailContact`, `MailUniversalDistributionGroup`, `MailUniversalSecurityGroup`. **Not supported**: Microsoft 365 groups, non-mail-enabled Entra users. | verified |
| `Remove-DistributionGroupMember` | `-Identity`, `-Member`, `-BypassSecurityGroupManagerCheck`; destructive, skip the prompt with `-Confirm:$false`. "You can't use [it] to remove the member of a dynamic distribution group." | verified |
| `Get-MailContact` | `-Identity` (optional), `-ResultSize` (default 1000), `-Anr`, `-Filter`, `-RecipientTypeDetails` (`MailContact`, `MailForestContact`), `-SortBy` (`Name`, `DisplayName`, `Alias`). No `-DisplayName`. | verified |
| `New-MailContact` | `-Name` (**mandatory**, max 64, "unique name"), `-ExternalEmailAddress` (**mandatory**), `-Alias` (max 64), `-DisplayName` (max 256; defaults to `-Name`), `-FirstName`, `-LastName`. `-PrimarySmtpAddress` is **on-premises only**; the external address is the primary address by default. No `-ResultSize`. | verified. Uniqueness of the *external address* is not stated on the page: the app must check it (UNVERIFIED as a service guarantee, U10). |
| `Set-MailContact` | `-Identity` (mandatory), `-ExternalEmailAddress`, `-DisplayName`, `-Alias`, `-Name`, `-EmailAddresses`, `-HiddenFromAddressListsEnabled`, `-WindowsEmailAddress`, many more. **No `-FirstName` / `-LastName`** in its syntax (they exist on `New-MailContact`). | verified. Learn: "use the Get-Contact and Set-Contact cmdlets to view and change organization and contact information properties. Use the Get-MailContact and Set-MailContact cmdlets to view or change mail-related properties" (https://learn.microsoft.com/en-us/exchange/recipients-in-exchange-online/manage-mail-contacts). Editing first/last name after creation therefore needs `Set-Contact`, whose parameters I did not read (U15); the CSV export columns `voornaam`/`achternaam` depend on it. |
| `Remove-MailContact` | `-Identity` (mandatory), `-Confirm`, `-WhatIf`. | verified |
| `Get-OrganizationConfig` | **No `-Identity`.** Only `-DomainController` (on-premises only) plus common parameters. | verified; the brief did not rely on `-Identity` but the verification call takes no arguments. |

Brief's parameter checklist:

| Parameter | Exists on |
|---|---|
| `-ResultSize` | `Get-DistributionGroup`, `Get-DistributionGroupMember`, `Get-MailContact` (not on Add/Remove/New/Set/Remove-MailContact) |
| `-Identity` | all except `New-MailContact` and `Get-OrganizationConfig`; mandatory on Get-DistributionGroupMember, Add/Remove-DistributionGroupMember, Set/Remove-MailContact; optional on Get-DistributionGroup, Get-MailContact |
| `-Member` | `Add-DistributionGroupMember`, `Remove-DistributionGroupMember` only |
| `-ExternalEmailAddress` | `New-MailContact` (mandatory), `Set-MailContact` |
| `-DisplayName` | `New-MailContact`, `Set-MailContact` only |
| `-Alias` | `New-MailContact`, `Set-MailContact` only |
| `-Name` | `New-MailContact` (mandatory), `Set-MailContact` |

Group edge cases (claim 4b):

- **Dynamic distribution groups**: separate recipient type; Graph does not support them; membership
  is calculated from a filter, "refreshed at least once every 24 hours"; members cannot be removed
  with `Remove-DistributionGroupMember`
  (https://learn.microsoft.com/en-us/exchange/recipients-in-exchange-online/manage-dynamic-distribution-groups/create-manage-dynamic-distribution-groups).
  `Get-DistributionGroup -RecipientTypeDetails` has no dynamic value, so they will not appear in its
  results (inference from the value list). Show them read-only via the Admin API
  `DynamicDistributionGroupMember` endpoint or its cmdlet (not read; U11).
- **Synced from on-premises**: cloud-side changes fail with "The action '<cmdlet>', '<property>',
  can't be performed on the object '<name>' because the object is being synchronized from your
  on-premises organization" (https://learn.microsoft.com/en-us/troubleshoot/exchange/groups-and-distribution-lists/cannot-manage-dg).
  `IsDirSynced` is a filterable property on `Get-DistributionGroup` and `Get-MailContact`
  (https://learn.microsoft.com/en-us/powershell/exchange/filter-properties?view=exchange-ps#isdirsynced), so
  `-Filter 'IsDirSynced -eq $true'` finds them. Output property name on these two cmdlets is
  assumed identical (UNVERIFIED, U12).
- **M365 groups** are not valid DL members (`Add-DistributionGroupMember`), and the Unified-group
  cmdlets are not usable app-only (3.5).
- **Bulk/time**: REST-backed cmdlets time out after 15 minutes (3.5).

---

## 5. OIDC and token facts for the threat model (claim 5)

### 5.1 ID-token claims (claim 5a)

| Claim | Status | Fact | Source |
|---|---|---|---|
| `aud` | verified | In ID tokens the app's Application (client) ID; "This value should be validated." | https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference |
| `iss` | verified | Issuer URI incl. tenant; v2.0 ends in `/v2.0`. For a single-tenant app the OIDC Core exact match applies: `https://login.microsoftonline.com/{tid}/v2.0`. | id-token-claims-reference; https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens#validate-tokens |
| `tid` | verified | Tenant GUID; "Always check that the `tid` ... matches the tenant ID used to store data"; check `iss` and `tid` agree. Consumer tenant id `9188040d-6c67-4c5b-b112-36a304b66dad`. | https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation |
| `nonce` | verified | Must match the `/authorize` request; reject otherwise. | https://learn.microsoft.com/en-us/entra/identity-platform/id-tokens |
| `oid`, `sub` | verified | Use `oid` (+ `tid`) as the user key; `preferred_username`, `email`, `name` are mutable and "can't be used to make authorization decisions". | id-token-claims-reference |
| Timestamps | verified | `iat`, `nbf`, `exp` validated; ID token lifetime 1 hour by default. | id-tokens page |
| Who validates | verified | "Only confidential clients should validate ID tokens"; use a library, not hand-written checks. The BFF is confidential, so it validates; the browser never sees tokens. | id-tokens page |
| Request shape | verified | `response_type=code` with `code_challenge`/`code_challenge_method=S256` ("recommended for all application types"), `state`, `nonce`, `response_mode=form_post` recommended for web apps, `prompt=login` forces credentials. | https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow, https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc |

### 5.2 `amr` and `acr` (claim 5b: **corrected**)

- `amr` is **not in the default v2.0 ID-token claim table**. It is an optional claim: add
  `"optionalClaims": {"idToken": [{"name": "amr", "essential": false}]}` to the app manifest
  (https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims#amr-claim). `include_granular_amr` is SAML-only.
  The wizard must set this in the app registration, otherwise an MFA gate based on `amr` fails closed
  for everyone.
- Values (OIDC v2.0), from https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference#amr-values-for-microsoft-entra-authentication-methods:
  password `pwd`; Authenticator push `rsa`,`ngcmfa`,`mfa`; Authenticator TOTP `totp`,`mfa`;
  hardware OATH `hotp`,`mfa`; phone sign-in `swk`,`rsa`,`mfa`; SMS `sms`,`mfa`; phone call
  `tel`,`mfa`; email OTP `emailotp`,`mfa`; FIDO2 and passkeys `fido`,`mfa`; Windows Hello for
  Business `hwk`,`mfa`,`ngcmfa`; certificate-based `hwk` (multi-factor) or `x509` (single-factor),
  `mfa`,`rsa`; Temporary Access Pass `otp`,`mfa`; Kerberos `wia`; device X.509 `x509`.
  "`multipleauthn` and `mfa` values are emitted only when the user has completed MFA."
  Learn also notes `otp` is being replaced by `totp`/`hotp`/`sms`/`tel`/`emailotp`/`tap`, and that
  `x509` alone "does not qualify as phishing-resistant MFA".
  **Rule for the code:** treat the array containing `mfa` as the MFA signal; never allow-list the
  whole value set. Access-token reference lists `pwd`, `rsa`, `otp`, `fed`, `wia`, `mfa`,
  `ngcmfa`, `wiaormfa`, `none`.
- `acr` is "a `0` or `1`, **only present in v1.0 tokens**" (access-token reference:
  https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference) and is
  absent from the v2.0 ID-token table. The brief's "amr/acr" should read "`amr` (optional claim)".
  The `acr`/`amr` pair on Learn in the ID-token context belongs to the *external MFA provider*
  protocol (https://learn.microsoft.com/en-us/entra/identity/authentication/concept-authentication-external-method-provider), which is not this product.

### 5.3 Conditional Access and authentication context (claim 5c)

- Conditional Access is evaluated by Entra at sign-in; the app does not re-implement it. The app
  must only be able to react to a **claims challenge** (`401`, `www-authenticate: Bearer ...
  error="insufficient_claims", claims="<base64>"`) by sending the user back to `/authorize` with a
  `claims` parameter (https://learn.microsoft.com/en-us/entra/identity-platform/claims-challenge).
  Graph sends challenges only if the client declares client capability `cp1`
  (`clientCapabilities: ["cp1"]` in MSAL Node, same page).
- Authentication context: IDs `c1` to `c25`, delivered in the **`acrs`** claim; a client asks for it
  with `{"access_token":{"acrs":{"essential":true,"value":"c1"}}}`; ID and access tokens must each
  opt in to the optional `acrs` claim; requires Entra ID P1; "only available to applications that
  sign-in users" (https://learn.microsoft.com/en-us/entra/identity-platform/developer-guide-conditional-access-authentication-context).
  It does not apply to the app-only Graph/Exchange calls.
- Step-up for "sensitive actions" (brief section 6): Learn shows requesting fresh MFA with
  `{"access_token":{"amr":{"essential":true,"values":["ngcmfa"]}}}`, MFA credential then "valid for 10
  minutes" (https://learn.microsoft.com/en-us/graph/api/resources/authenticationmethods-overview?view=graph-rest-1.0, claims-request example).
  `prompt=login` is documented to force credentials. I found `max_age` only in the MSA
  server-side reference, not for Entra v2.0: **UNVERIFIED (U13)**, so do not rely on it. Design
  decision: step-up = new `/authorize` with `prompt=login` plus a `claims` request, then check that
  `amr` contains `mfa` and that the `auth_time` optional claim (listed on the optional-claims page)
  is later than the moment the step-up started (O6).

### 5.4 Group claim limits and overage (claim 5d: verified)

- Limits: **200 groups in JWT, 150 in SAML, 6 (or 5) with the implicit flow**; over the limit
  "Microsoft Entra ID doesn't emit the groups claim". The implicit limit is printed as six on
  https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles and
  https://learn.microsoft.com/en-us/entra/architecture/customize-tokens, but as five on
  https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-fed-group-claims. Irrelevant for
  the code flow (200).
- Detection: no `groups` claim and `_claim_names.groups` present (JWT) or `hasgroups: true`
  (implicit). "Applications must not rely on the actual claim values in the token when
  `_claim_sources` is present", because that endpoint may be an Azure AD Graph URL; "call the
  appropriate Microsoft Graph API". `groups` is not emitted unless `groupMembershipClaims` is set.
  Learn's own advice is to prefer Graph or app roles over the token claim.
- The brief re-evaluates membership via Graph on every login. That is the right design and makes
  the overage case a non-event. Do not request the `groups` claim at all (smaller tokens, nothing to
  trust).
- Graph calls and application permissions:

| Call | Permission (application) | Notes |
|---|---|---|
| `POST /users/{id}/checkMemberGroups` `{ "groupIds": [...] }` | `User.ReadBasic.All` + `GroupMember.Read.All` (least); `User.Read.All` + `GroupMember.Read.All`; `Directory.Read.All` | max **20** group ids; transitive; returns only the ids that match. Best fit: the panel knows the few Entra groups bound to roles. |
| `POST /users/{id}/getMemberGroups` `{ "securityEnabledOnly": ... }` | same combinations | returns all group ids and (when `false`) directory roles. |
| `GET /users/{id}/transitiveMemberOf` | `User.Read.All` (least) | returns groups, directory roles and administrative units. |
| `GET /me/...` forms | delegated only (`User.Read` for `/me/transitiveMemberOf`) | "Application permissions aren't supported when using the `/me` endpoint". Usable only if the login also requests `User.Read` for the user token. |

  Sources: https://learn.microsoft.com/en-us/graph/api/directoryobject-checkmembergroups?view=graph-rest-1.0,
  https://learn.microsoft.com/en-us/graph/api/directoryobject-getmembergroups?view=graph-rest-1.0,
  https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof?view=graph-rest-1.0.
  The recommended set in 1.5 covers all three. Hidden-membership groups are omitted without
  `Member.Read.Hidden` (1.4).

### 5.5 Redirect URI rules (claim 5e: verified)

Source: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url

- Must start with `https`, except `localhost`: `http://localhost` and `http://localhost/abc` are
  valid, `http://contoso.com/...` is not. So a panel base URL over plain HTTP is only registrable
  for `localhost`; any other host needs HTTPS (owner-visible wizard error).
- Loopback: the **port is ignored when matching** `localhost` redirect URIs; do not register two
  localhost URIs that differ only by port (one is chosen arbitrarily); differentiate by path.
  `[::1]` is not supported. Learn prefers `127.0.0.1` to `localhost`, but the portal cannot add an
  `http://127.0.0.1` URI (only via the manifest `replyUrlsWithType`); whether the Graph API accepts
  it under `web.redirectUris` is **UNVERIFIED (U14)**, so register `http://localhost/<path>`.
- Case-sensitive paths; no `! $ ' ( ) , ;`; no internationalised domain names; a URI without a path is
  returned with a trailing slash; wildcards are "currently unsupported" for apps that sign in personal
  Microsoft accounts and work or school accounts, allowed only for apps configured for work or school
  accounts of one organization, and "strongly" discouraged. Do not use wildcards.
- Platform: `Web` (the application object has `web.redirectUris`,
  https://learn.microsoft.com/en-us/graph/api/application-post-applications?view=graph-rest-1.0 response sample).
  Keep "Allow public client flows" disabled on the runtime app: Learn's rule is that it "should be
  disabled unless you or your developer are building a public client application"
  (https://learn.microsoft.com/en-us/entra/identity-platform/msal-client-applications).

### 5.6 Certificate client assertion (claim 5f: verified)

Source: https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials

| Part | Value |
|---|---|
| Request parameters | `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, `client_assertion=<JWT>`, used wherever `client_secret` would be (auth-code redemption and client credentials) |
| Header | `alg` **PS256**, `typ` JWT, **`x5t#S256`** = base64url SHA-256 thumbprint of the certificate DER |
| Claims | `aud` `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`; `iss` = `sub` = client id (GUID); `jti` unique; `iat`, `nbf`; `exp` "5-10 minutes after `nbf` at most" |
| Signature | RSA with PSS padding |
| MSAL Node | `auth.clientCertificate = { thumbprintSha256: "<64 hex>", privateKey: "<PEM>" }` (optional `x5c` for SNI) (https://learn.microsoft.com/en-us/entra/msal/javascript/node/certificate-credentials). MSAL builds the assertion; do not hand-roll it. |
| Upload | `keyCredentials` on the application (`type` `AsymmetricX509Cert`, `usage` `Verify`, `customKeyIdentifier`, `key`) via manifest/PATCH, or `addKey`. `addKey` says "An application doesn't need any specific permission to roll its own keys" (rotation can be done by the runtime app itself). |

---

## 6. Throttling (claim 6)

### 6.1 Microsoft Graph (verified)

Sources: https://learn.microsoft.com/en-us/graph/throttling, https://learn.microsoft.com/en-us/graph/throttling-limits,
https://learn.microsoft.com/en-us/graph/best-practices-concept

- Detect with **HTTP 429**; the response carries `Retry-After`. Wait that many seconds, retry; if
  429 again keep honouring `Retry-After`. "Avoid immediate retries, because all requests accrue
  against your usage limits." If no `Retry-After`, use exponential backoff. `503`: back-off like 429
  and make retries over a **new HTTP connection**. Graph SDKs already implement this; requests inside
  a JSON batch are not retried automatically (Learn's Retry-After page:
  https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/concepts/retry-after-header).
  Retry-After is seconds or an HTTP date on that page; handle both.
- Some resources do not return `Retry-After` (data policy operations, identity protection and
  Conditional Access): use backoff there. Not used by this product.
- Limits of the "identity and access service" ("token bucket", per application + tenant):
  resource units 3,500 / 5,000 / 8,000 per 10 s for tenants under 50 / 50-500 / over 500 users; **write
  quota 3,000 requests per 2 min 30 s per app+tenant** and 18,000 per 5 min per tenant; global limit
  130,000 requests per 10 s per app. "It's possible to receive 429 responses even when the limits
  aren't reached." The page lists the resources these limits cover; I did not read that list, so
  that users and group memberships fall under them is **UNVERIFIED (U16)**. Bulk add of many members
  should use `PATCH /groups/{id}` with `members@odata.bind` (20 per request) and a small concurrency cap.
- Directory replication: add-member can return `400` for freshly created groups and `list/get` carries an eventual-consistency note; retry briefly
  (add-member page; "Designing for eventual consistency").

### 6.2 Exchange Online (partly UNVERIFIED)

| Item | Status | Source |
|---|---|---|
| Admin API: retry on 429 and honour `Retry-After`; default page 1,000; `@odata.nextLink` expires in 5-10 minutes (finish paging within 5 minutes) | verified | https://learn.microsoft.com/en-us/exchange/reference/admin-api-get-started |
| EXO V3 REST cmdlets: "Transient failures use built-in retries"; 15-minute timeout per cmdlet | verified | https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2?view=exchange-ps |
| Numeric throttling limits (budget, concurrency, per-minute) for app-only PowerShell/REST in Exchange Online | **UNVERIFIED (U7)** | None found. The EWS throttling article says Exchange Online limits are "set by default and not discoverable" (EWS-specific, https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/ews-throttling-in-exchange). |
| Exchange Online exposes throttling-policy cmdlets | not available | same EWS article: "Exchange Online does not provide access to the throttling policy cmdlets" |

Design consequence: serialise Exchange calls through one worker with a small concurrency cap, apply
exponential backoff with jitter on transient and throttling errors, page with `-ResultSize`, and
cache reads with a short TTL; do not promise a number.

---

## 7. Register of UNVERIFIED items (copy to `docs/open-points.md`, date 2026-10-10)

| # | Claim | Where used | Tried | Needed to close |
|---|---|---|---|---|
| U1 | `GroupMember.ReadWrite.All` alone lists groups (`GET /groups`) | permissions.md (1.5) | Learn list-groups/get-group pages print `Group-NestingSupport.ReadWrite.All` as least privileged and omit `GroupMember.ReadWrite.All`; overview says `GroupMember.Read.All` | Dev-tenant call with only `GroupMember.ReadWrite.All` |
| U2 | Default client of `Connect-MgGraph` is `14d82eec-...` and is a public client | wizard step 2 | Sign-in report page lists `14d82eec`; `Get-MgContext` sample shows `615e6e7c-...` | Run device code against a dev tenant with each id; keep `BOOTSTRAP_CLIENT_ID` |
| U3 | Behaviour for non-admins / exact consent errors with the Microsoft client | wizard error handling | Not on pages read | Dev-tenant test with a non-admin and with consent disabled |
| U4 | Delay between Entra role assignment and a working Exchange app-only token | wizard retry/backoff | Learn silent; "Directory Role ... returned in the access token" | Measure in dev tenant; keep retry loop |
| U5 | Minimal Exchange role set for DL membership + mail contacts (Exchange Recipient Administrator or custom role group incl. Security Group Creation and Membership) | permissions.md, security.md | Role/cmdlet pages read; no statement of sufficiency | Dev-tenant `Test` run of all 9 cmdlets under each candidate role |
| U6 | `New-ServicePrincipal` parameter set (`-ServiceId` mandatory?); app role id of `Exchange.ManageAsAppV2` | wizard step 3 | Reference and how-to disagree; Admin API page names both ManageAsApp and ManageAsAppV2 | Read tenant SP `appRoles` for `00000002-0000-0ff1-ce00-000000000000`; run cmdlet |
| U7 | Exchange Online throttling limits for app-only PowerShell/REST | security.md, ExchangeClient design | Searched Learn | None; design for unknown limits |
| U8 | Graph behaviour when adding members to an on-premises-synced security group | groups UI | Not on pages read | Dev-tenant test; use `onPremisesSyncEnabled` to show read-only |
| U9 | EXO module on Debian/Alpine/distroless | Dockerfile (pwsh) | Learn lists Ubuntu LTS only | Owner decision O2; test chosen base |
| U10 | Uniqueness of `ExternalEmailAddress` enforced by Exchange | contacts validation | `New-MailContact` page silent | App-side uniqueness check (`Get-MailContact -Filter`) |
| U11 | Cmdlet and parameters for listing dynamic distribution groups | DL list | Admin API endpoint `DynamicDistributionGroupMember` only; cmdlet page not read | Read `Get-DynamicDistributionGroup` page when Phase D starts |
| U12 | Output property name `IsDirSynced` on `Get-DistributionGroup` / `Get-MailContact` | read-only display | Only the filterable property is documented | Inspect output in dev tenant |
| U13 | `max_age` honoured by Entra v2.0 `/authorize` | step-up | Only the MSA reference shows it | Use `prompt=login` + app-side timestamp |
| U14 | Graph accepts `http://127.0.0.1` in `web.redirectUris` | wizard redirect URIs | Learn says the portal cannot; manifest can | Dev-tenant PATCH test; default to `http://localhost` |
| U15 | `Set-Contact` parameters for first/last name (and that it works app-only with the chosen Exchange role) | contacts edit, CSV export | `Set-MailContact` syntax has no `-FirstName`/`-LastName`; `Set-Contact` page not read | Read `Set-Contact` page when Phase D starts |
| U16 | The identity-and-access throttling limits (write quota 3,000 / 2 min 30 s) cover users and group memberships | ExchangeClient/GraphClient backoff | Limits table read; the resource list was not | Read the resource list under "Identity and access service limits" |
| U17 | Permission and shape for reading licence assignments app-only (`assignedLicenses` property, beta `cloudLicensing` APIs) | users list "licenties" column | `licenseDetails` documents "Application: Not supported"; other APIs only as search snippets | Read the `user` resource page and `cloudLicensing` pages in Phase C |

## 8. Owner decisions raised here

O1 Graph permission set (1.5). O2 Exchange execution path: pwsh worker for all Exchange calls
(documented, Ubuntu-based image) vs Admin API Preview for reads only vs unsupported `InvokeCommand`.
O3 Service-principal role: Exchange Administrator (works, broad) vs Exchange Recipient Administrator
vs custom role group (needs pwsh in the wizard). O4 Wizard user: Global Administrator vs Privileged
Role Administrator plus Application Administrator. O5 Bootstrap fallback when device code is
blocked or the Microsoft client is unavailable. O6 MFA policy: rely on Conditional Access only, or
also require `amr` containing `mfa` in the app (needs the optional claim). Details are in the
structured result.
