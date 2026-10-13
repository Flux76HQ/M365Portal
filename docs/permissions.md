# Permissions

> **Status:** Phase C. Part 1 is the panel's own catalogue and exists in code. Part 2 lists what the
> panel asks of Microsoft in Phases B to D (written in Phase A); Part 3 is the Phase B role matrix and the
> permissions the running panel holds, and wins where the two differ; Part 4 is what Phase C (users and
> groups, read only) reads, route by route, and what it deliberately leaves out. Part 2 is seeded only
> from [`research-microsoft.md`](../specs/001-m365portal/research-microsoft.md) (Microsoft Learn,
> 2026-10-10); a fact that file does not contain is marked UNVERIFIED and has a register row in
> [open-points.md](open-points.md). Nederlandse versie: zie [Nederlands](#nederlands).

## Part 1: the panel catalogue

The panel works with one powerful application identity, so the panel itself is the only place where
rights are enforced. A right has the form `resource:action`. The catalogue is the typed list
`PERMISSIONS` in `packages/shared/src/permissions.ts`; this table is compared with it by
`docs-contract.test.ts`, and a second list anywhere else in the code is a defect. A role (Phase B) is a
set of these permissions. In Phase A the **anonymous** actor holds none and the **preview** actor holds
all fifteen; "Phase" says where the permission starts to matter (A: it already gates a route or a
navigation entry; the later letter is the phase with the real feature).

| Permission | Reason | Phase |
|---|---|---|
| `users:read` | See users (name, e-mail, state, groups). Also the minimal read right for a role that adds members. | A (gates the Users page), C |
| `groups:read` | See Microsoft 365 and security groups and their members. | A (gates the Groups page), C |
| `groups:members:write` | Add and remove members of groups that Microsoft Graph can manage. | C (not built in the read-only first version; unused in Phase C, see Part 4) |
| `distributionlists:read` | See distribution lists and their members. | A (gates the page), D |
| `distributionlists:members:write` | Add and remove members of distribution lists (through Exchange). | D |
| `distributionlists:export` | Export a distribution list as CSV, inside the role's scope. | D |
| `contacts:read` | See mail contacts. | A (gates the page), D |
| `contacts:create` | Create mail contacts. | D |
| `contacts:update` | Edit mail contacts. | D |
| `contacts:delete` | Delete mail contacts, after a confirmation naming the object. | D |
| `audit:read` | Read the audit log. | A (gates the page), D |
| `audit:export` | Export the audit log. | D |
| `settings:branding` | Change the organisation name, accent colour and logos, and import or export them. The one permission with a feature in Phase A (Appearance). | A |
| `settings:connection` | Manage the connection to the Microsoft 365 tenant (the setup wizard, certificates, secrets). | B |
| `rbac:manage` | Manage roles, assignments and scopes. | B |

Deny by default: an empty set of held permissions never satisfies a requirement, and a route that
asks for "any of nothing" is not satisfiable. Navigation in the web app is hidden or disabled by the
same list, but the server enforces every permission on every route.

## Part 2: Microsoft Graph and Exchange

Status vocabulary (exactly one per row): **verified** means Microsoft Learn states it as written;
**corrected** means the product brief was wrong or incomplete and the Learn-backed wording is used;
**UNVERIFIED** means Learn does not state it, the row carries its register id (`U<n>`), and
open-points.md says what was tried and what closes it. Phase is the first phase that needs the row (B:
setup wizard, sign-in and RBAC foundation; C: users and groups; D: distribution lists and contacts).

### Graph application permissions (the running panel)

| Permission or operation | Reason | Phase | Status | Learn source and note |
|---|---|---|---|---|
| `User.Read.All` | List and read users, `accountEnabled`, and the groups of a user. Replaces the brief's `User.ReadWrite.All`; no phase writes user properties. | C | corrected | [user-list](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0) |
| `GroupMember.Read.All` | List groups and read memberships. Requested next to the write permission because the Learn pages for listing groups do not name `GroupMember.ReadWrite.All` (U1). | C | UNVERIFIED | Register U1: whether `GroupMember.ReadWrite.All` alone lists groups; the overview page names `GroupMember.Read.All` |
| `GroupMember.ReadWrite.All` | Add and remove members of security and Microsoft 365 groups. Replaces the brief's `Group.ReadWrite.All`, which is higher privileged for these calls. | C | corrected | [group-post-members](https://learn.microsoft.com/en-us/graph/api/group-post-members?view=graph-rest-1.0), [group-delete-members](https://learn.microsoft.com/en-us/graph/api/group-delete-members?view=graph-rest-1.0) |
| `Organization.Read.All` | Show the tenant name, verified domains and SKUs; verification step of the wizard. | B | verified | [organization-get](https://learn.microsoft.com/en-us/graph/api/organization-get?view=graph-rest-1.0) |
| `User.ReadBasic.All` | With `GroupMember.Read.All`, resolve a signed-in user's membership of the panel's role groups with `checkMemberGroups` (at most 20 group ids, transitive). | B | verified | [checkMemberGroups](https://learn.microsoft.com/en-us/graph/api/directoryobject-checkmembergroups?view=graph-rest-1.0) |
| `Member.Read.Hidden` | Not requested by default. Without it, groups with hidden membership are omitted from `checkMemberGroups` and member lists, so a role bound to such a group never matches (fails closed). Documented, not granted. | B | verified | checkMemberGroups page, "Important" |
| `User.ReadWrite.All` | Not requested. Higher privileged than `User.Read.All` for every read the product makes. | C | corrected | [permissions-reference](https://learn.microsoft.com/en-us/graph/permissions-reference) |
| `Group.ReadWrite.All` | Not requested. Also grants access to group content of Microsoft 365 groups. | C | corrected | permissions-reference |
| `Directory.Read.All` | Not requested. Learn: "Whenever possible, choose permissions specific to these resources and avoid using directory permissions." | C | corrected | permissions-reference |
| `RoleManagement.ReadWrite.Directory` | Never granted to the running panel: it lets an app "grant additional privileges to itself, other applications, or any user". Role-assignable groups are therefore shown read-only; adding a member to one needs this permission, otherwise Graph answers 403. | C | verified | group-post-members page; groups overview (`isAssignableToRole`) |
| Group types Graph cannot manage | Mail-enabled security groups and distribution groups are read-only in Graph; dynamic distribution groups are not supported; dynamic-membership groups cannot have members changed. This is why distribution lists go through Exchange. | C | verified | [groups-overview](https://learn.microsoft.com/en-us/graph/api/resources/groups-overview?view=graph-rest-1.0) |
| Members of on-premises-synced security groups | Treated as read-only by reading `onPremisesSyncEnabled`; the Graph behaviour of adding a member was not found on Learn (U8). | C | UNVERIFIED | Register U8 |
| Licence column of the users list | `GET /users/{id}/licenseDetails` documents "Application: Not supported", so there is no app-only source verified for licences (U17). | C | UNVERIFIED | Register U17 |

### The brief's five application permissions against the smaller four

Shown without deciding it: the choice is owner decision OD-06, due at the Phase B gate (default: the
smaller set).

| Graph application role | In the brief ("minimaal") | In the smaller set | Learn says |
|---|---|---|---|
| `User.ReadWrite.All` | yes | no (`User.Read.All` instead) | higher privileged for every read |
| `Group.ReadWrite.All` | yes | no (`GroupMember.ReadWrite.All` instead) | higher privileged for add and remove member |
| `GroupMember.ReadWrite.All` | yes | yes | least privileged for add and remove member |
| `Directory.Read.All` | yes | no | broad; Learn advises against it |
| `Organization.Read.All` | yes | yes | least privileged for reading the organisation |
| `User.Read.All` | no | yes | least privileged for reading users |
| `GroupMember.Read.All` | no | yes | listing groups (U1) |

### Setup wizard: delegated scopes of the signed-in administrator

The wizard signs in an administrator with device code and creates the app registration, its service
principal and the grants. The scopes need admin consent.

| Permission or operation | Reason | Phase | Status | Learn source and note |
|---|---|---|---|---|
| `Application.ReadWrite.All` | Create the service principal, upload the certificate, set redirect URIs and optional claims. | B | verified | application-post-applications, serviceprincipal-post-serviceprincipals, application-update, application-addkey |
| `AppRegistration.Create` | Least privileged scope for creating the registration alone, but not needed because `Application.ReadWrite.All` is required anyway. | B | corrected | application-post-applications |
| `AppRoleAssignment.ReadWrite.All` | Grant the Graph application permissions and `Exchange.ManageAsApp` (with `Application.Read.All`). | B | verified | serviceprincipal-post-approleassignedto |
| `RoleManagement.ReadWrite.Directory` | Assign an Entra role to the service principal; the only documented option. | B | verified | rbacapplication-post-roleassignments |
| `Directory.Read.All` | Listed by the brief; no wizard call needs it. | B | corrected | permissions-reference |
| Entra role of the signed-in user | Global Administrator is sufficient, not required. The documented minimum is Privileged Role Administrator (consent for Graph app roles, Entra role assignment) plus a role allowed to register apps. | B | corrected | appRoleAssignedTo and roleAssignments pages; delegate-by-task |
| Device code with the Microsoft client `14d82eec-204b-4c2f-b7e8-296a70dab67e` | That the id is a first-party app is verified; that it is what `Connect-MgGraph` uses and that it is a public client is not (U2). A tenant can block device code with Conditional Access, so a `BOOTSTRAP_CLIENT_ID` override ships. | B | UNVERIFIED | Register U2 |
| Errors shown to a non-admin or when consent is disabled | Not on the pages read (U3). | B | UNVERIFIED | Register U3 |
| Delay between role assignment and a working Exchange token | Learn is silent (U4); the wizard retries with a fresh token. | B | UNVERIFIED | Register U4 |
| `http://127.0.0.1` in `web.redirectUris` | Learn says the portal cannot register it and the manifest can; Graph behaviour not found (U14). The default stays `http://localhost`. | B | UNVERIFIED | Register U14 |
| `max_age` on the Entra v2.0 `/authorize` request | Step-up sign-in; only the consumer-account reference shows it (U13). The fallback is `prompt=login` plus an application timestamp. | B | UNVERIFIED | Register U13 |

### Exchange Online (distribution lists and mail contacts)

The panel manages distribution lists and mail contacts through Exchange, because Graph cannot. The
brief's "REST `InvokeCommand` endpoint" is **not documented** on Learn (corrected); the execution path
and the runtime base image are owner decision OD-07.

| Permission or operation | Reason | Phase | Status | Learn source and note |
|---|---|---|---|---|
| `Exchange.ManageAsApp` (resource `00000002-0000-0ff1-ce00-000000000000`, app role `dc50a0fb-09a3-484d-be87-e023b12c6440`) | App-only access of the Exchange Online PowerShell module; admin consent required. | B | verified | [app-only-auth-powershell-v2](https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2?view=exchange-ps) |
| `Exchange.ManageAsAppV2` | The Admin API (Preview) uses a different app role; its id is not given and the same page also names `ManageAsApp`. Do not mix the two. | D | UNVERIFIED | Register U6 |
| Entra role Exchange Administrator for the service principal | Works for every task incl. `-BypassSecurityGroupManagerCheck` (equivalent to Organization Management); broad. | B | verified | app-only-auth-powershell-v2, step 5 |
| Entra role Exchange Recipient Administrator, or a custom role group | Narrower options. Whether they cover `Add-DistributionGroupMember` on lists the service principal does not own, and the minimal custom role set (it needs the Security Group Creation and Membership role), is not stated (U5). | D | UNVERIFIED | Register U5 |
| `New-ServicePrincipal` parameter set | The how-to uses `-AppId -ObjectId -DisplayName`; the reference lists `-ServiceId` as mandatory too (U6). | B | UNVERIFIED | Register U6 |
| Certificate for app-only | X.509 with exportable private key; CNG not supported; on Linux use `-Certificate` or `-CertificateFilePath`, not `-CertificateThumbprint`; `-Organization` is the `.onmicrosoft.com` domain. | B | verified | app-only-auth-powershell-v2, step 3 |
| Exchange Online Admin API (Preview), six endpoints | Documented scope is read of organization config, accepted domains, distribution group membership and dynamic distribution group membership, mailbox, mailbox folder permissions. `Get-DistributionGroup`, `Add-` and `Remove-DistributionGroupMember` and every `*-MailContact` cmdlet are outside it. A Preview. | D | verified | [admin-api-endpoints-reference](https://learn.microsoft.com/en-us/exchange/reference/admin-api-endpoints-reference) |
| `Get-DistributionGroup` | List lists. No `-DisplayName`; search with `-Anr` or `-Filter`; a null or unknown `-Identity` returns all objects, so validate first. | D | verified | [get-distributiongroup](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/get-distributiongroup?view=exchange-ps) |
| `Get-DistributionGroupMember` | List members; `-Identity` mandatory; no `-Member`. | D | verified | cmdlet page |
| `Add-DistributionGroupMember`, `Remove-DistributionGroupMember` | Add or remove one member; `-BypassSecurityGroupManagerCheck` is needed unless the caller manages the list. Microsoft 365 groups and non-mail-enabled users are not valid members. | D | verified | cmdlet pages |
| `Get-MailContact` | List contacts; `-Anr`, `-Filter`, `-ResultSize`. | D | verified | cmdlet page |
| `New-MailContact` | Create a contact: `-Name` and `-ExternalEmailAddress` are mandatory; `-PrimarySmtpAddress` is on-premises only. Uniqueness of the external address is not documented (U10): the app checks it. | D | verified | cmdlet page |
| `Set-MailContact` | Edit mail-related properties. It has no `-FirstName` or `-LastName`. | D | verified | cmdlet page; manage-mail-contacts |
| `Set-Contact` | Needed to change first and last name after creation (and for the CSV columns); parameters not read (U15). | D | UNVERIFIED | Register U15 |
| `Remove-MailContact` | Delete a contact (`-Confirm:$false` to skip the prompt). | D | verified | cmdlet page |
| `Get-OrganizationConfig` | Verification call of the wizard; takes no `-Identity`. The brief's `Get-DistributionGroup -ResultSize 1` cannot use the Preview API. | B | verified | cmdlet page |
| Listing dynamic distribution groups | The cmdlet and parameters were not read; only the Admin API endpoint is documented (U11). Members cannot be removed with `Remove-DistributionGroupMember`. | D | UNVERIFIED | Register U11 |
| `IsDirSynced` in the output of `Get-DistributionGroup` and `Get-MailContact` | Only the filterable property is documented; the output name is assumed (U12). Used to show synced objects read-only. | D | UNVERIFIED | Register U12 |
| Exchange Online module on Debian, Alpine or distroless | Learn lists Ubuntu LTS only, and PowerShell 7.4 or 7.6 and newer. Decides the runtime base if a PowerShell worker is chosen (U9). | D | UNVERIFIED | Register U9 |
| Exchange and Graph throttling limits | Graph: 429 with `Retry-After`. No page publishes Exchange Online limits for app-only use (U7), and whether the identity and access write quota covers users and group memberships was not read (U16). | B | UNVERIFIED | Registers U7, U16 |

## Part 3: Phase B, the role matrix and the runtime application

> **Status:** Phase B (2026-10-12). Part 3 is normative for the roles and for what the running panel holds
> at Microsoft. Where it differs from Part 2, which was seeded in Phase A from the research alone, Part 3
> wins: the owner decision about the Graph set (ODB-02) is implemented with its default, the reduced set of
> four application roles, and awaits the owner's confirmation at the gate. Every id below was re-read on
> Microsoft Learn on 2026-10-10 (`specs/002-phase-b/research-microsoft-b.md`); the wizard still resolves the
> role ids from the tenant at run time (FR-B-302) and never trusts this table.

### Built-in roles

The panel ships five immutable roles and one template. A role is a set of the 15 permissions of Part 1;
an assignment binds a role to a user or an Entra group, optionally with a scope (FR-B-501 to FR-B-513).
`x` means the role holds the permission. *Bestuur* is a template, not a role: assigning it creates an
assignment of the read roles with the qualifier `basic` for `users:read`. The matrix is identical to
the table in section 6.9.4 of the Phase B spec and `docs-contract.test.ts` compares the two cell by cell.
Totals: *Eigenaar* 15, *Beheerder* 13, *Operator* 9, *Helpdesk* 6, *Lezer* 4, *Bestuur* 5.

| Permission | Resource type | Eigenaar (`owner`) | Beheerder (`admin`) | Operator (`operator`) | Helpdesk (`helpdesk`) | Lezer (`reader`) | Bestuur (template) |
|---|---|---|---|---|---|---|---|
| `users:read` | `user` | x | x | x | x | x | basic |
| `groups:read` | `group` | x | x | x | x | x | |
| `groups:members:write` | `group` | x | x | x | x | | |
| `distributionlists:read` | `distributionList` | x | x | x | x | x | x |
| `distributionlists:members:write` | `distributionList` | x | x | x | x | | x |
| `distributionlists:export` | `distributionList` | x | x | | | | |
| `contacts:read` | `contact` | x | x | x | x | x | x |
| `contacts:create` | `contact` | x | x | x | | | x |
| `contacts:update` | `contact` | x | x | x | | | |
| `contacts:delete` | `contact` | x | x | x | | | |
| `audit:read` | none (global-only) | x | x | | | | |
| `audit:export` | none (global-only) | x | x | | | | |
| `settings:branding` | none (global-only) | x | x | | | | |
| `settings:connection` | none (global-only) | x | | | | | |
| `rbac:manage` | none (global-only) | x | | | | | |

How a scope works. The "Resource type" column is the permission-to-resource-type map. A scope restricts
an assignment per resource type: a scoped assignment of a role applies only to objects of the scope for
every permission of that resource type, and it adds nothing for other types. The permissions marked
"none (global-only)" (`audit:read`, `audit:export`, `settings:branding`, `settings:connection`,
`rbac:manage`) come from unscoped assignments only: a scoped assignment never grants them. "Read
everything, write only Sales" is therefore two assignments (*Lezer* unscoped and a members-write role
scoped). The qualifier `basic` on `users:read` limits the answer to display name and e-mail address
(`projectUser`). A role that holds `rbac:manage` or `settings:connection` cannot be bound to an Entra
group (FR-B-515, ODB-16). The setup session holds exactly `settings:branding` and `settings:connection`
(PB-06); the break-glass session holds only the restore-owner action (FR-B-523).

### The runtime application at Microsoft Graph

The running panel is granted application permissions only, four of them (set version 1,
`GRAPH_APP_ROLES`). No call of Phases B to D was found that needs `Group.Read.All` or
`Directory.Read.All`; `Group.Read.All` is not granted, and neither is `Directory.Read.All` (dropped).

| Application role | Application role id (Microsoft Graph) | Used for | Learn source |
|---|---|---|---|
| `User.Read.All` | `df021288-bdef-4463-88db-98f22de89214` | Read users and their `accountEnabled`; sign-in lookup; `transitiveMemberOf` in Phase C. Replaces `User.ReadWrite.All`. | [user-get](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0), permissions-reference |
| `GroupMember.Read.All` | `98830695-27a2-44f7-8c18-0c3ebc9698f6` | `checkMemberGroups`, `getGroup`, `searchGroups`. Described as "memberships and basic group properties"; which group properties it returns is U36 (OV-19). | [directoryobject-checkmembergroups](https://learn.microsoft.com/en-us/graph/api/directoryobject-checkmembergroups?view=graph-rest-1.0) |
| `GroupMember.ReadWrite.All` | `dbaae8cf-10b5-4b86-a4a1-f871c94c6695` | Membership writes. Granted in Phase B so that one consent covers it (ODB-02); **granted, unused in Phase C** (read only, D-C1): no code path uses it, see Part 4. | [group-post-members](https://learn.microsoft.com/en-us/graph/api/group-post-members?view=graph-rest-1.0) |
| `Organization.Read.All` | `498476ce-e0fe-48b0-b801-37ba7e2685c6` | Verification and the tenant display name. | [organization-get](https://learn.microsoft.com/en-us/graph/api/organization-get?view=graph-rest-1.0) |

Delta against the five permissions of the brief: `User.ReadWrite.All` is replaced by `User.Read.All`
(no user write is planned), `Group.ReadWrite.All` is dropped (its only planned use was creating the
administrators group, and `Group.*` also opens group content), `Directory.Read.All` is dropped (Learn:
avoid directory permissions where resource-specific ones exist; `memberOf` is replaced by
`transitiveMemberOf`), `GroupMember.ReadWrite.All` and `Organization.Read.All` are kept, and
`GroupMember.Read.All` and `User.Read.All` are added. Four permissions instead of five. A later write
need is a new decision with its own evidence; the fallback ladder for U36 (add `ConsistencyLevel`, then
`Group.ReadBasic.All` if it exists for applications, U46, then `Group.Read.All`) is in the plan, section 8.8.

Never granted to the runtime application, by any code path or setting (`FORBIDDEN_APP_ROLES`):
`RoleManagement.ReadWrite.Directory`, `AppRoleAssignment.ReadWrite.All` and `Application.ReadWrite.All`.
Wizard step 4 reads what the service principal holds and fails when a forbidden role is present.

### Exchange Online

| Item | Value | Note |
|---|---|---|
| Application role `Exchange.ManageAsApp` | `dc50a0fb-09a3-484d-be87-e023b12c6440` on the resource `00000002-0000-0ff1-ce00-000000000000` | Required; admin consent through the wizard. |
| Application role `Exchange.ManageAsAppV2` | granted when the tenant exposes it; its id is resolved at run time | Only the Admin API probe uses it (U6). |
| `EXCHANGE_ROLES` key `exchange_administrator` | Entra role template `29232cdf-9323-42fd-ade2-1d097af3e4de` (Exchange Administrator; "Exchange Service Administrator" in the Graph API) | The default (B-03). Learn: it provides the permissions for any task in Exchange Online PowerShell. |
| `EXCHANGE_ROLES` key `exchange_recipient_administrator` | Entra role template `31392ffb-586c-42d1-9346-e59415a2cc4e` (Exchange Recipient Administrator) | Selectable for the OV-13 experiment. Whether it suffices for list and contact writes is UNVERIFIED (U5). |

No other template id is accepted: `EXCHANGE_ROLES` is the whole list, so a privileged role such as Global
Administrator can never be assigned through the setting. The Exchange write path (distribution list
members, mail contacts) is not built in Phase B; ADR-0102 records the decision (ODB-01).

### What the wizard asks the administrator for (delegated, bootstrap token only)

| Delegated scope | Why |
|---|---|
| `Application.ReadWrite.All` | Create the application and the service principal, upload the certificate, set redirect URIs and optional claims. |
| `AppRoleAssignment.ReadWrite.All` | Grant the Graph application roles and `Exchange.ManageAsApp`. |
| `RoleManagement.ReadWrite.Directory` | Assign the Entra role of Exchange to the service principal. |

`Directory.Read.All` is not needed by any wizard call. The administrator is a Global Administrator, or a
Privileged Role Administrator plus an Application Administrator or Cloud Application Administrator (or
Application Developer when members may register applications). Consent is per user, never "on behalf of
your organization". The token lives in memory and is discarded at the end of the wizard (FR-B-215).

### Open items of this part

U5 (the narrower Exchange role), U6 (`ManageAsApp` against `ManageAsAppV2`), U36 and U37 (group
properties and `$filter` with `GroupMember.Read.All` alone), U46 (`Group.ReadBasic.All`) and U48
(`assignedLicenses`) stay UNVERIFIED and have rows in [open-points.md](open-points.md); the owner-verified
ledger OV-01 to OV-23 lists the checks that close them.

## Part 4: Phase C, users and groups (read only)

> **Status:** Phase C (2026-10-13). Normative for what the Users and Groups pages read at Microsoft.
> Where it differs from Parts 2 and 3 on Phase C, Part 4 wins. The map of the code is
> `apps/server/src/integrations/graph/permissions-map.ts` (`GRAPH_METHOD_PERMISSIONS`, one row per method of
> the Graph port); `permissions-map.test.ts` proves that every permission in it is one of the four granted
> roles and none is a write role. Sources: [`research-microsoft-c.md`](../specs/003-phase-c/research-microsoft-c.md)
> (Microsoft Learn, read 2026-10-12) and the gate notes `specs/003-phase-c/gate-notes/`.

Phase C needs **no new Graph permission**, neither read nor write. It uses two of the four application
roles the running panel already holds (set version 1): `User.Read.All` and `GroupMember.Read.All`.
`Organization.Read.All` is not used by Phase C (wizard and Settings only). `GroupMember.ReadWrite.All` is
**granted, unused in Phase C**: no method of the Graph port, no route and no job uses a write permission,
and a test fails when a Phase C route is anything but GET or a write method appears on the Graph client
(`read-only.test.ts`, `routes-table.test.ts`). The Connection page (Settings, Connection) lists the four
roles the application holds ("Granted: ..."); it does not say which of them a feature uses, so the sentence
"granted, unused" lives here and in [open-points.md](open-points.md) only. The first version of Phase C does
not change the Connection text.

### The seven routes and what they read at Microsoft

All seven routes are `GET`, class `read`, answer `Cache-Control: no-store`, are declared with `defineRoute`
and ask the policy layer before they touch data. A success is not audited; every refusal of an authenticated
actor is (route id as action, reason `permission_missing` or `scope_mismatch`). The Graph column lists the
calls the route makes; all go to `https://graph.microsoft.com/v1.0` through the one outbound client and are
never cached (lists) or cached for 60 seconds (one user, one group).

| Route (id) | Panel permission | Graph call | Application role | Open claims |
|---|---|---|---|---|
| P33 `users.list`, `GET /api/v1/users` | `users:read` (scoped `user`; qualifier `full` or `basic`) | `GET /users` with `$filter`, `$orderby=displayName`, `$select`, `$top`, `$count=true` and `ConsistencyLevel: eventual` | `User.Read.All` | U70, U72 |
| P34 `users.get`, `GET /api/v1/users/{id}` | `users:read` on that user | `GET /users/{id}`, and `GET /users/{id}/manager` (full qualifier only) | `User.Read.All` | U66 (manager) |
| P35 `users.groups`, `GET /api/v1/users/{id}/groups` | `users:read` on that user (full) **and** `groups:read` | `GET /users/{id}/transitiveMemberOf/microsoft.graph.group` | `User.Read.All` | U67, U74 |
| P36 `groups.list`, `GET /api/v1/groups` | `groups:read` (scoped `group`) | `GET /groups` with the filter of the kind, `$orderby`, `$count=true` and the header | `GroupMember.Read.All` | U36, U69 |
| P37 `groups.get`, `GET /api/v1/groups/{id}` | `groups:read` on that group | `GET /groups/{id}` | `GroupMember.Read.All` | U36 |
| P38 `groups.owners`, `GET /api/v1/groups/{id}/owners` | `groups:read` on that group | `GET /groups/{id}/owners` with `$select` and `$count=true` and the header | `GroupMember.Read.All` | U68, U71 |
| P39 `groups.members`, `GET /api/v1/groups/{id}/members` | `groups:read` on that group | `GET /groups/{id}/members` with `$select` and `$count=true` and the header (not called for a group with hidden membership) | `GroupMember.Read.All` | U67, U71 |

Notes on the table.

- Owners and members of a group are users, groups or other objects. Whether the actor sees such a row in
  full is decided by the actor's own `users:read` and `groups:read` (scope and qualifier); it is not a
  Graph permission. A row the actor may not see is a **restricted row**: its kind and the fact, no id, no
  name, no address (ADR-0179). The manager of a user is treated the same way. A user that the actor sees
  only through a `basic` grant shows id, name and e-mail address, never the principal name.
- `users:read` with the qualifier `basic` (template *Bestuur*) gets id, display name and e-mail address from
  the list and the detail, no manager and no group memberships (P35 answers 403 `permission_denied`), and may
  not use the state or type filter: 422 `validation_failed` with `errors[0].code` `filter_not_allowed`. The
  same refusal applies to an actor who sees some users only as `basic` and not every user in full.
- A single user or group outside the actor's visible scope is 403 `permission_denied` (audited
  `scope_mismatch`), an unknown id is 404 `not_found` (ODB-11, closed by the owner on 2026-10-13). Lists
  contain only what the actor may see.
- Application permissions on the **manager** call: the Learn page "List manager" marks application
  permissions as "Not supported" (U66). The panel therefore reads the manager with a separate call and
  shows "not available" when Graph refuses (403, 400 or an unexpected answer); a user without a manager
  (404) shows "no manager". The user page works either way.
- `memberOf` is not used: for another user it needs `Directory.Read.All`, which is not granted.
  `transitiveMemberOf` works with `User.Read.All`, so the groups of a user are **transitive** (nested
  groups included), and the page says so. Groups with hidden membership may be missing from that list (U67).
- Members of a group with `visibility` `HiddenMembership` need `Member.Read.Hidden`, which the panel does
  not hold and does not request (ODC-04). The panel does not call Graph for them and the page says the
  membership is hidden; owners are still listed.
- Objects Graph returns with limited information (devices, service principals, contacts the application
  cannot read as such) arrive with an id only. They are counted and shown as "other", without a name.
- The group kind (Microsoft 365, security, mail-enabled security, distribution) is derived by one function
  from `groupTypes`, `mailEnabled` and `securityEnabled`; a property Graph did not return gives the kind
  `unknown` (U36). Mail-enabled security and distribution groups are shown read-only (Graph cannot manage
  them). Dynamic distribution groups are not returned by Graph and are not in the list; the page says so.
- Owners are not available from Graph for distribution, mail-enabled security and on-premises-synced
  groups: an empty first page then answers `ownersState: not_available`, and the page says the owners are
  not available for this kind.

### Not requested, not used, not built in Phase C

| Item | State | Why |
|---|---|---|
| `GroupMember.ReadWrite.All` | granted, unused | Granted in Phase B (ODB-02, one consent). Phase C is read only (D-C1). |
| `Organization.Read.All` | granted, not used by Phase C | Wizard and Settings only. |
| `Member.Read.Hidden` | not requested | Hidden-membership groups show "hidden" (ODC-04). Decided after OV-C5. |
| `Group.Read.All`, `Directory.Read.All`, `User.ReadBasic.All` | not requested | The two roles held are enough for every Phase C call. |
| Licences: `assignedLicenses`, `licenseDetails`, a licence column | not built, deferred by the owner on 2026-10-13 | U17 and U48 stay open. No request, field, filter or column mentions licences; a source scan fails if one appears (`no-licences.test.ts`). |
| Create, update, delete of users or groups; enable or disable; password reset | not built | Read only (D-C1). |
| Membership and owner changes | not built | `groups:members:write` stays in the catalogue and is unused in Phase C. |
| Transitive members of a group, nested-group expansion, direct reports, photos, sign-in activity, phone numbers and addresses | not built | Smallest safe first version (AC-04). |
| Membership rule of a dynamic group | not shown | The wire has no field for it; `membershipType` says `dynamic`. |
| Audit of successful reads | not built | Denials only (ODC-01, default). |

What the owner closes against a real tenant: U66 to U74 (the Phase C rows of [open-points.md](open-points.md))
with the checks OV-C1 to OV-C6, step by step in [owner-test-phase-c.md](owner-test-phase-c.md).

## Nederlands

### Deel 1: de panel-catalogus

Het panel werkt met één krachtige applicatie-identiteit; het panel zelf is dus de enige plek waar rechten
worden afgedwongen. Een recht heeft de vorm `resource:actie`. De catalogus (15 rechten) staat in
`packages/shared/src/permissions.ts` en de tabel hierboven wordt daarmee vergeleken door
`docs-contract.test.ts`. Een rol (Fase B) is een verzameling van deze rechten. In Fase A heeft de
anonieme actor geen enkel recht en de preview-actor alle vijftien. De kolom Phase noemt de fase waarin het
recht betekenis krijgt: A betekent dat het al een route of menu-item afschermt, de latere letter is de fase
met de echte functie. Standaard geen toegang: een lege verzameling voldoet nooit aan een eis. De server
dwingt elk recht af; de UI verbergt alleen.

### Deel 2: Microsoft Graph en Exchange

Alles in dit deel komt uit `research-microsoft.md` (Microsoft Learn, 2026-10-10). Status: **verified**
(Learn zegt het zoals geschreven), **corrected** (de briefing klopte niet of was onvolledig) of
**UNVERIFIED** (niet op Learn gevonden; de rij noemt een register-id `U<n>` dat in
[open-points.md](open-points.md) staat met wat is geprobeerd en wat nodig is om het te sluiten).

- **Graph-applicatierechten.** De briefing noemt vijf rechten (`User.ReadWrite.All`, `Group.ReadWrite.All`,
  `GroupMember.ReadWrite.All`, `Directory.Read.All`, `Organization.Read.All`). Learn toont dat voor de
  handelingen van het product kleinere rechten volstaan: `User.Read.All`, `GroupMember.Read.All`,
  `GroupMember.ReadWrite.All` en `Organization.Read.All`. De vergelijking staat in de tabel hierboven; de
  keuze is eigenaarsbeslissing OD-06 bij de Fase B-poort (standaard de kleinere set).
  `RoleManagement.ReadWrite.Directory` wordt nooit aan het draaiende panel gegeven; groepen die aan een rol
  toegewezen kunnen worden zijn daarom alleen-lezen.
- **Wizard.** De beheerder meldt zich aan met device code. Nodig zijn `Application.ReadWrite.All`,
  `AppRoleAssignment.ReadWrite.All` en `RoleManagement.ReadWrite.Directory`; `Directory.Read.All` is niet
  nodig. Global Administrator volstaat maar is niet vereist (minimaal Privileged Role Administrator plus
  een rol die apps mag registreren). Of de Microsoft-client standaard gebruikt wordt, is ONGEVERIFIEERD
  (U2), daarom is er een `BOOTSTRAP_CLIENT_ID`-override.
- **Exchange.** Een REST-endpoint `InvokeCommand` is op Learn niet gedocumenteerd. De Exchange Admin API
  (Preview) dekt alleen leden van distributiegroepen lezen en enkele andere leesacties; wijzigen van lijsten
  en alle mailcontact-cmdlets vallen erbuiten. Het uitvoeringspad en het basisbeeld zijn beslissing OD-07.
  Voor app-only toegang is `Exchange.ManageAsApp` met een Entra-rol (Exchange Administrator werkt) of een
  eigen rolgroep nodig; de minimale rolgroep is ONGEVERIFIEERD (U5).
- **Cmdlets.** De negen cmdlets bestaan en hun parameters zijn gecontroleerd, met uitzondering van
  `Set-Contact` (voor voor- en achternaam; U15), de lijst met dynamische distributiegroepen (U11) en de
  uitvoer-eigenschap `IsDirSynced` (U12).

### Deel 3: de rollenmatrix van Fase B en de draaiende applicatie

De rollenmatrix hierboven (Deel 3, Built-in roles) is normatief en gelijk aan sectie 6.9.4 van de spec van
Fase B: vijf vaste rollen (Eigenaar, Beheerder, Operator, Helpdesk, Lezer) en het sjabloon Bestuur, dat data is
en geen rol. Totalen: Eigenaar 15, Beheerder 13, Operator 9, Helpdesk 6, Lezer 4, Bestuur 5. Een scope beperkt een
toewijzing per resourcetype; rechten zonder resourcetype (audit, instellingen, RBAC) komen alleen uit
toewijzingen zonder scope. Rollen met `rbac:manage` of `settings:connection` kunnen niet aan een Entra-groep
worden gekoppeld.

De draaiende applicatie krijgt alleen applicatierechten, vier in totaal: `User.Read.All`,
`GroupMember.Read.All`, `GroupMember.ReadWrite.All` en `Organization.Read.All`. `Group.Read.All` en
`Directory.Read.All` worden niet gegeven. `RoleManagement.ReadWrite.Directory`,
`AppRoleAssignment.ReadWrite.All` en `Application.ReadWrite.All` krijgt de applicatie nooit
(`FORBIDDEN_APP_ROLES`). Voor Exchange is `Exchange.ManageAsApp` nodig met de Entra-rol Exchange Administrator
(standaard); de smallere rol Exchange Recipient Administrator is ONGEVERIFIEERD (U5). Het schrijfpad voor
distributielijsten en contacten is niet gebouwd in Fase B (ADR-0102, ODB-01).

### Deel 4: Fase C, gebruikers en groepen (alleen lezen)

Fase C heeft **geen nieuw Graph-recht** nodig, niet om te lezen en niet om te schrijven. Het gebruikt twee van
de vier applicatierollen die het draaiende panel al heeft: `User.Read.All` (gebruikers, manager,
`transitiveMemberOf`) en `GroupMember.Read.All` (groepenlijst, groep, eigenaren, leden).
`Organization.Read.All` gebruikt Fase C niet (alleen wizard en Instellingen). `GroupMember.ReadWrite.All` is
**verleend, ongebruikt in Fase C**: geen methode van de Graph-poort, geen route en geen taak gebruikt een
schrijfrecht, en een test faalt zodra een Fase C-route iets anders dan GET is of er een schrijfmethode op de
Graph-client verschijnt. De pagina Instellingen, Verbinding toont de vier verleende rollen ("Granted: ...")
zonder te zeggen welke een functie gebruikt; de zin "verleend, ongebruikt" staat daarom alleen hier en in
[open-points.md](open-points.md). De Verbinding-tekst zelf verandert in Fase C niet.

De zeven routes zijn allemaal `GET`, klasse `read`, met `Cache-Control: no-store`, en vragen eerst de
beleidslaag. Een geslaagde leesactie wordt niet geaudit; elke weigering van een ingelogde aanvrager wel.

| Route | Panelrecht | Graph-aanroep | Applicatierol |
|---|---|---|---|
| `users.list` (`GET /api/v1/users`) | `users:read` (met scope; kwalificatie `full` of `basic`) | `GET /users` met `$filter`, `$orderby`, `$count=true` en `ConsistencyLevel: eventual` | `User.Read.All` |
| `users.get` (`GET /api/v1/users/{id}`) | `users:read` op die gebruiker | `GET /users/{id}` en `GET /users/{id}/manager` (alleen `full`) | `User.Read.All` |
| `users.groups` (`GET /api/v1/users/{id}/groups`) | `users:read` (`full`) en `groups:read` | `GET /users/{id}/transitiveMemberOf/microsoft.graph.group` | `User.Read.All` |
| `groups.list` (`GET /api/v1/groups`) | `groups:read` (met scope) | `GET /groups` met filter op soort | `GroupMember.Read.All` |
| `groups.get` (`GET /api/v1/groups/{id}`) | `groups:read` op die groep | `GET /groups/{id}` | `GroupMember.Read.All` |
| `groups.owners` (`GET /api/v1/groups/{id}/owners`) | `groups:read` op die groep | `GET /groups/{id}/owners` | `GroupMember.Read.All` |
| `groups.members` (`GET /api/v1/groups/{id}/members`) | `groups:read` op die groep | `GET /groups/{id}/members` (niet voor een groep met verborgen lidmaatschap) | `GroupMember.Read.All` |

Wat dit voor de gebruiker betekent.

- Eén object buiten het zicht van de aanvrager geeft 403 `permission_denied`, een onbekend id 404.
  Lijsten bevatten alleen wat de aanvrager mag zien.
- Leden, eigenaren en de manager die de aanvrager als gebruiker of groep niet mag zien, komen terug als
  "beperkt": alleen het soort, geen id, naam of adres (ADR-0179). Een gebruiker die alleen via een
  `basic`-recht zichtbaar is, toont id, naam en e-mailadres, nooit de principalnaam.
- Een aanvrager met `users:read` met kwalificatie `basic` (sjabloon *Bestuur*) ziet id, naam en
  e-mailadres, geen manager en geen groepslidmaatschappen, en mag niet filteren op status of type (422
  `validation_failed`, code `filter_not_allowed`). Hetzelfde geldt voor wie sommige gebruikers alleen als
  `basic` ziet.
- De manager is een bonus: Learn noemt voor applicatierechten "Not supported" (U66). Weigert Graph de
  aanroep, dan staat er "niet beschikbaar"; zonder manager staat er "geen manager". De pagina werkt altijd.
- De groepen van een gebruiker zijn transitief (geneste groepen inbegrepen). Groepen met verborgen
  lidmaatschap kunnen ontbreken (U67). Voor zulke groepen vraagt Graph `Member.Read.Hidden`; dat recht heeft
  het panel niet en vraagt het niet aan (ODC-04): de pagina zegt dat het lidmaatschap verborgen is.
- Eigenaren zijn bij Graph niet beschikbaar voor distributie-, e-mailbeveiligings- en gesynchroniseerde
  groepen; de pagina zegt dat. Dynamische distributiegroepen geeft Graph niet terug; de groepenlijst zegt dat
  ook.
- Niet gebouwd en uitgesteld door de eigenaar (2026-10-13): licenties (U17 en U48 blijven open, geen kolom,
  geen veld, geen filter), aanmaken, wijzigen of verwijderen, in- of uitschakelen, wachtwoordreset, leden- en
  eigenaarsbeheer, transitieve leden, directe medewerkers, foto's, aanmeldactiviteit, de lidmaatschapsregel van
  een dynamische groep en een auditregel voor geslaagde leesacties (ODC-01).

Wat de eigenaar tegen een echte tenant sluit: U66 tot en met U74 met de controles OV-C1 tot en met OV-C6,
stap voor stap in [owner-test-phase-c.md](owner-test-phase-c.md).
