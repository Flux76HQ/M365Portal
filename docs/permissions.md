# Permissions

> **Status:** Phase D step D1. Part 1 is the panel's own catalogue and exists in code. Part 2 lists what the
> panel asks of Microsoft in Phases B to D (written in Phase A); Part 3 is the Phase B role matrix and the
> permissions the running panel holds, and wins where the two differ; Part 4 is what Phase C (users and
> groups, read only) reads, route by route, and what it deliberately leaves out; Part 5 is what Phase D step
> D1 (distribution lists, contacts, group members: the first writes) needs, route by route, and wins over
> Parts 2 to 4 on step D1. Part 2 is seeded only
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
| `groups:members:write` | Add and remove members of groups that Microsoft Graph can manage. | C (not built in the read-only first version; unused in Phase C, see Part 4); built in Phase D step D1 (P53 and P54, FR-D-352) |
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
and the runtime base image were owner decision OD-07, decided on 2026-10-13 as ODB-01 A: a `pwsh` worker in the
same container on an Ubuntu 24.04 base, built in Phase D step D1 (Part 5, ADR-0180, ADR-0181).

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
| Exchange Online module on Debian, Alpine or distroless | Learn lists Ubuntu LTS only, and PowerShell 7.4 or 7.6 and newer. Decides the runtime base if a PowerShell worker is chosen (U9); decided: Ubuntu 24.04 (ADR-0180), whose build and start are still unmeasured. | D | UNVERIFIED | Register U9 |
| Exchange and Graph throttling limits | Graph: 429 with `Retry-After`. No page publishes Exchange Online limits for app-only use (U7), and whether the identity and access write quota covers users and group memberships was not read (U16). | B | UNVERIFIED | Registers U7, U16 |

## Part 3: Phase B, the role matrix and the runtime application

> **Status:** Phase B (2026-10-12). Part 3 is normative for the roles and for what the running panel holds
> at Microsoft. Where it differs from Part 2, which was seeded in Phase A from the research alone, Part 3
> wins: the owner decision about the Graph set (ODB-02) is implemented with its default, the reduced set of
> four application roles, and awaits the owner's confirmation at the gate. Every id below was re-read on
> Microsoft Learn on 2026-10-10 (`specs/002-phase-b/research-microsoft-b.md`); the wizard still resolves the
> role ids from the tenant at run time (FR-B-302) and never trusts this table.

### Built-in roles

The panel ships six immutable roles and one template (the sixth, *Distribution List Editor*, `dl_editor`, comes with migration `0002`, ADR-0183: contacts in full, distribution lists read and member write, and `users:read` so that the member search works). A role is a set of the 15 permissions of Part 1;
an assignment binds a role to a user or an Entra group, optionally with a scope (FR-B-501 to FR-B-513).
`x` means the role holds the permission. *Bestuur* is a template, not a role: assigning it creates an
assignment of the read roles with the qualifier `basic` for `users:read`. The matrix is identical to
the table in section 6.9.4 of the Phase B spec and `docs-contract.test.ts` compares the two cell by cell.
Totals: *Eigenaar* 15, *Beheerder* 13, *Operator* 9, *Helpdesk* 6, *Lezer* 4, *Bestuur* 5, *Distribution List Editor* 7.

| Permission | Resource type | Eigenaar (`owner`) | Beheerder (`admin`) | Operator (`operator`) | Helpdesk (`helpdesk`) | Lezer (`reader`) | Bestuur (template) | Distribution List Editor (`dl_editor`) |
|---|---|---|---|---|---|---|---|---|
| `users:read` | `user` | x | x | x | x | x | basic | x |
| `groups:read` | `group` | x | x | x | x | x | |  |
| `groups:members:write` | `group` | x | x | x | x | | |  |
| `distributionlists:read` | `distributionList` | x | x | x | x | x | x | x |
| `distributionlists:members:write` | `distributionList` | x | x | x | x | | x | x |
| `distributionlists:export` | `distributionList` | x | x | | | | |  |
| `contacts:read` | `contact` | x | x | x | x | x | x | x |
| `contacts:create` | `contact` | x | x | x | | | x | x |
| `contacts:update` | `contact` | x | x | x | | | | x |
| `contacts:delete` | `contact` | x | x | x | | | | x |
| `audit:read` | none (global-only) | x | x | | | | |  |
| `audit:export` | none (global-only) | x | x | | | | |  |
| `settings:branding` | none (global-only) | x | x | | | | |  |
| `settings:connection` | none (global-only) | x | | | | | |  |
| `rbac:manage` | none (global-only) | x | | | | | |  |

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
| `GroupMember.ReadWrite.All` | `dbaae8cf-10b5-4b86-a4a1-f871c94c6695` | Membership writes. Granted in Phase B so that one consent covers it (ODB-02); **granted, unused in Phase C** (read only, D-C1): no code path uses it, see Part 4. **Used from Phase D step D1** (FR-D-352): add and remove members of Microsoft 365 and security groups, `groups.members.add` and `groups.members.remove`. | [group-post-members](https://learn.microsoft.com/en-us/graph/api/group-post-members?view=graph-rest-1.0) |
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
members, mail contacts) was not built in Phase B (ADR-0102 records the decision, ODB-01); it is built in Phase D
step D1 (Part 5, ADR-0180, ADR-0181).

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
| `GroupMember.ReadWrite.All` | granted, unused | Granted in Phase B (ODB-02, one consent). Phase C is read only (D-C1). Used from Phase D step D1 (FR-D-352). |
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

## Part 5: Phase D step D1, distribution lists, contacts and group members

> **Status:** Phase D step D1 (2026-10-13), the first step that **writes**. Normative for what the
> distribution list, contact and group-member routes (P40 to P45, P47 to P54) need at Microsoft. Where it
> differs from Parts 2 to 4 on step D1, Part 5 wins. Sources: [`research-microsoft-d.md`](../specs/004-phase-d/research-microsoft-d.md)
> (Microsoft Learn, read 2026-10-13, R-D-01 to R-D-09), the gate notes `specs/004-phase-d/gate-notes/GD1-*.md`
> and the allow-list `packages/shared/src/exchange/allow-list.ts`. **Nothing in this part has been run
> against a real tenant.** Every claim that rests on Learn alone is marked; the open ones have a row in
> [open-points.md](open-points.md) and a check in [owner-test-phase-d1.md](owner-test-phase-d1.md).

### What changed at Microsoft, and what did not

Step D1 asks Microsoft for **no new permission**: no new Graph application role (the runtime application
still holds the four of set version 1), no new Exchange role, no new delegated scope for the wizard. What
changes is that two things granted earlier are now **used**:

| Item | Before | From step D1 |
|---|---|---|
| `GroupMember.ReadWrite.All` (`dbaae8cf-10b5-4b86-a4a1-f871c94c6695`) | Granted in Phase B (ODB-02, one consent); **granted, unused in Phase C** (Part 4) | **Used** by `groups.members.add` and `groups.members.remove` (FR-D-352). It is the least privileged application permission for adding a user to a group (R-D-08, verified) |
| `Exchange.ManageAsApp` and the Entra role Exchange Administrator of the service principal (ODB-03) | Granted by the wizard; used by the verification probe only | **Used** by every call of the Exchange worker: the reads of lists, members and contacts and all writes |
| `Exchange.ManageAsAppV2` | Granted where the tenant exposes it (the wizard skips it silently if not) | Not needed by the worker (it connects with the module and `Exchange.ManageAsApp`); only the Admin API probe uses it. Its existence is still UNVERIFIED (U77) |

Never granted, by any code path or setting, and the reason step D1 works around it (`FORBIDDEN_APP_ROLES`):
`RoleManagement.ReadWrite.Directory`, `AppRoleAssignment.ReadWrite.All`, `Application.ReadWrite.All`. A
role-assignable group needs `RoleManagement.ReadWrite.Directory` for a member write (Learn); the panel does not
hold it, so Graph answers 403 and the panel shows "no permission for this change" for that member (U96).
`User.ReadWrite.All` and `Directory.ReadWrite.All` are not held, which is why the delete path of a member
must always end in `/$ref`: without it, Learn warns, Graph would delete the member object itself where the
application may manage it.

### Group members through Graph (P53, P54)

| Route (id) | Panel permission | Graph call | Application role | Open claims |
|---|---|---|---|---|
| P53 `groups.members.add` | `groups:members:write` on that group (scoped `group`), step-up above 20 members | First `GET /groups/{id}/members` (direct, `$select`, 999 per page, at most 50 pages) to decide "already"; then one `POST /groups/{id}/members/$ref` with `{ "@odata.id": ".../directoryObjects/{id}" }` per member, `204` | `GroupMember.Read.All` (read), `GroupMember.ReadWrite.All` (write) | U92, U96 |
| P54 `groups.members.remove` | the same | The same read, then one `DELETE /groups/{id}/members/{id}/$ref` per member, `204` | the same | U93, U96 |

- Users only. A group, device, service principal or organizational contact as a member needs further
  permissions (`Device.ReadWrite.All`, `Application.ReadWrite.All`, `OrgContact.Read.All`) that the panel
  does not hold and does not request.
- Supported only for security and Microsoft 365 groups with assigned membership. A dynamic group, a group
  synchronised from on-premises, a distribution or mail-enabled security group (their members are managed in
  Exchange), a group of unknown kind and a group with hidden membership answer 409 `read_only_object` before
  any call.
- The bulk form (`PATCH` with `members@odata.bind`, 20 at most) is all-or-nothing and gives no result per
  member, so it is not used (R-D-08, verified).
- Graph answers `400` alike for a member that is already there, an unsupported member type and a group that
  has not replicated yet (U92). The panel therefore reads the membership first and decides "already" itself;
  a bare `400` after a failed pre-check is `rejected`, never `already`. What Graph answers for removing a
  non-member is not stated (U93): the panel treats a `404` as "already".

### Distribution lists and contacts through the Exchange worker (P40 to P45, P47 to P52)

All Exchange calls run in the `pwsh` worker, which connects with the application id, the tenant's
`.onmicrosoft.com` domain and the certificate (app-only). The certificate reaches the worker in memory
(`EXCHANGE_KEY_HANDOVER=memory`), or through a short-lived file on a tmpfs (`tmpfs`, the fallback); whether the
in-memory path works on Linux is U75, and the hand-over is PEM, built but not proven against a real `pwsh` or a tenant (see
[open-points.md](open-points.md), finding FD-01). The worker may call **ten cmdlets and nothing else**, each
with a closed set of parameters (ADR-0181):

| Cmdlet | Used by | Parameters the panel passes | Learn |
|---|---|---|---|
| `Get-DistributionGroup` | P40, P41, P51, P52 | `Identity`, `Filter` (`Name`, `DisplayName`, `Alias` and `PrimarySmtpAddress` with `-like 'prefix*'`; `Members -eq '<DN>'` for the lists of a contact), `ResultSize`; the allow-list also permits `SortBy`, `RecipientTypeDetails` and `IncludeManagedByWithDisplayNames` | verified (cmdlet page). The filter properties and the `Members` filter: UNVERIFIED (U97). `SortBy` and `RecipientTypeDetails` values: UNVERIFIED (U99) |
| `Get-Recipient` | P40, P41 (dynamic lists) | `RecipientTypeDetails` (`DynamicDistributionGroup`), `Filter`, `Identity`, `ResultSize` | verified as a cmdlet; the value list: UNVERIFIED (U99). `Get-DistributionGroup` does not return dynamic lists |
| `Get-DistributionGroupMember` | P41 (count), P42, P43, P44 (read first and read back), P45 (`alreadyMember`) | `Identity` (mandatory, never empty: a null identity returns everything), `ResultSize` (`Unlimited` or a number) | verified. Default `ResultSize` and paging: U79 |
| `Add-DistributionGroupMember` | P43 | `Identity`, `Member` (required by the panel although Learn calls it optional), `BypassSecurityGroupManagerCheck` (always) | verified. Behaviour for an existing member: U94 |
| `Remove-DistributionGroupMember` | P44 | the same; the script appends `-Confirm:$false` | verified. Behaviour for a non-member: U94 |
| `Get-MailContact` | P45, P47, P48, P49 (duplicate check and read-back), P50, P51 | `Identity` (a GUID, never empty: a null or unknown identity returns all contacts), `ANR` for the prefix search and for the duplicate check of a new address or alias, `ResultSize`; the allow-list also permits `Filter`, `SortBy` and `RecipientTypeDetails` | verified. Default result size: U79 (the page says 1,000 in the description and "None" in the table). That `-ANR` matches the external address, on which the duplicate check relies: UNVERIFIED (U97) |
| `New-MailContact` | P49 | `Name` (derived: alias cut to 57 characters, a hyphen, 6 hexadecimal characters), `ExternalEmailAddress`, `Alias`, `DisplayName`, `FirstName`, `LastName` | verified. Uniqueness of `-Name` is UNVERIFIED (U95) |
| `Set-MailContact` | P50 | `Identity`, and at least one of `DisplayName`, `Alias`, `ExternalEmailAddress` (the allow-list also permits `Name` and `HiddenFromAddressListsEnabled`; no route sends them) | verified. It has no first or last name (U15 answered for this cmdlet; `Set-Contact` was not read and is not used) |
| `Remove-MailContact` | P51 | `Identity`; the script appends `-Confirm:$false` | verified |
| `Get-OrganizationConfig` | the wizard's verification probe, the worker's ping of the owner test | none | verified |

What the panel never sends, by construction of the allow-list: `-Confirm` and `-WhatIf` as caller
parameters (the script adds `-Confirm:$false` itself, on the two `Remove-` cmdlets only), any parameter that
is not in the table, an empty `Identity`, any cmdlet outside the ten, and any value that does not match the
pattern of its parameter. A call is validated on the server before it is written to the worker and again
by the worker script against the same table (ADR-0181).

| Route (id) | Panel permission | Cmdlets | Exchange authorisation | Open claims |
|---|---|---|---|---|
| P40, P41 `distributionlists.list`, `.get` | `distributionlists:read` | `Get-DistributionGroup`, `Get-Recipient`, `Get-DistributionGroupMember` | Entra role Exchange Administrator through `Exchange.ManageAsApp` | U75, U79, U80, U97, U99 |
| P42 `distributionlists.members` | `distributionlists:read` on that list | `Get-DistributionGroupMember` | the same | U79, U98 |
| P43, P44 `distributionlists.members.add`, `.remove` | `distributionlists:members:write` on that list | `Get-DistributionGroupMember`, `Add-` or `Remove-DistributionGroupMember` | the same, and `-BypassSecurityGroupManagerCheck`, which Learn says is for administrators who are not in `ManagedBy` (R-D-02); that the service principal's role satisfies it is U78 | U78, U82, U94 |
| P45 `distributionlists.search` | `distributionlists:members:write`, `users:read`, `contacts:read` | Graph `GET /users` (`User.Read.All`), `Get-MailContact`, `Get-DistributionGroupMember` | the same, and `User.Read.All` | U70 |
| P47, P48 `contacts.list`, `.get` | `contacts:read` | `Get-MailContact` | the same | U12, U79, U80 |
| P49 `contacts.create` | `contacts:create` | `Get-MailContact`, `New-MailContact` | the same | U95, U97 |
| P50 `contacts.update` | `contacts:update` | `Get-MailContact`, `Set-MailContact` | the same | U15 (answered), U80 |
| P51 `contacts.delete` | `contacts:delete` | `Get-DistributionGroup`, `Remove-MailContact` | the same | U97 |
| P52 `contacts.memberships` | `contacts:read`, `distributionlists:read` | `Get-DistributionGroup -Filter "Members -eq ..."` | the same | U97 |

- **The Exchange role.** The default is Exchange Administrator (`EXCHANGE_ROLES` key `exchange_administrator`),
  which Learn says provides the permissions for any task and satisfies the manager check. Whether Exchange
  Recipient Administrator or a custom role group would be enough for the cmdlets of step D1 is U76 (and U5);
  ODB-03 says to narrow only after OV-D1. The panel treats a refusal as 503 `exchange_permission_missing`.
- **A new role can take minutes to take effect.** Until it does, the first connect or call fails with the
  detail code `exchange_role_pending` (503 `exchange_unavailable`), and the page says so.
- **Throttling.** Exchange Online publishes no numbers for app-only use (U81). The panel retries a throttled
  or transient call at most 3 times with a doubling wait (1 s to 15 s, jitter, `Retry-After` first), then
  503 `exchange_throttled` or `exchange_unavailable`. The numbers are ours.
- **Read-back.** Exchange writes are eventually consistent (U82); P43 and P44 report `readBackPending` when
  the change is not visible yet.
- **Exchange audit.** Learn: the admin audit log is on by default, 180 days, up to 30 minutes of delay, and
  `Get-`, `Search-` and `Test-` cmdlets are not logged. Whether a run by a service principal is logged, and
  how it is identified, is U89; that each write cmdlet of step D1 is in the logged set is U90 (OV-D4).
- **Synchronised objects** (`IsDirSynced`) are shown read-only; the output property name is assumed (U12), and
  how to detect synchronised groups and contacts is U80.

### Not requested, not used, not built in step D1

| Item | State | Why |
|---|---|---|
| New Graph application role, new Exchange role, new wizard scope | not requested | Step D1 uses what the wizard already grants |
| `Device.ReadWrite.All`, `Application.ReadWrite.All`, `OrgContact.Read.All`, `RoleManagement.ReadWrite.Directory`, `Member.Read.Hidden` | not requested | Users only as group members; hidden membership stays read-only (ODC-04) |
| `Set-Contact`, `Set-DistributionGroup`, owner or manager edits, creating or deleting lists or groups | not built | Names of a contact are set on creation only (U15); lists and groups are not created |
| `Get-DynamicDistributionGroupMember` | not on the allow-list | Dynamic lists have no member list in the panel (finding FD-05) |
| The Exchange Admin API (Preview) for reads | not used for lists | It covers group membership reads only; step D1 reads through the worker so there is one path (FR-D-108) |
| Licences | deferred | U17, U48 |

What the owner closes against a real tenant: U75 to U85, U89 and U90, and U92 to U100 with the checks OV-D1, OV-D2, OV-D4 and
OV-D5 (the rows of [open-points.md](open-points.md), Phase D), step by step in
[owner-test-phase-d1.md](owner-test-phase-d1.md).

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
  en alle mailcontact-cmdlets vallen erbuiten. Het uitvoeringspad en het basisbeeld waren beslissing OD-07, besloten op 2026-10-13 als ODB-01 A: een
  `pwsh`-worker in dezelfde container op Ubuntu 24.04, gebouwd in Fase D stap D1 (Deel 5).
  Voor app-only toegang is `Exchange.ManageAsApp` met een Entra-rol (Exchange Administrator werkt) of een
  eigen rolgroep nodig; de minimale rolgroep is ONGEVERIFIEERD (U5).
- **Cmdlets.** De negen cmdlets bestaan en hun parameters zijn gecontroleerd, met uitzondering van
  `Set-Contact` (voor voor- en achternaam; U15), de lijst met dynamische distributiegroepen (U11) en de
  uitvoer-eigenschap `IsDirSynced` (U12).

### Deel 3: de rollenmatrix van Fase B en de draaiende applicatie

De rollenmatrix hierboven (Deel 3, Built-in roles) is normatief en gelijk aan sectie 6.9.4 van de spec van
Fase B: zes vaste rollen (Eigenaar, Beheerder, Operator, Helpdesk, Lezer, Distribution List Editor) en het sjabloon Bestuur, dat data is
en geen rol. Totalen: Eigenaar 15, Beheerder 13, Operator 9, Helpdesk 6, Lezer 4, Bestuur 5, Distribution List Editor 7 (contacten volledig beheren, distributielijsten lezen en leden wijzigen, gebruikers lezen om leden te zoeken). Een scope beperkt een
toewijzing per resourcetype; rechten zonder resourcetype (audit, instellingen, RBAC) komen alleen uit
toewijzingen zonder scope. Rollen met `rbac:manage` of `settings:connection` kunnen niet aan een Entra-groep
worden gekoppeld.

De draaiende applicatie krijgt alleen applicatierechten, vier in totaal: `User.Read.All`,
`GroupMember.Read.All`, `GroupMember.ReadWrite.All` en `Organization.Read.All`. `Group.Read.All` en
`Directory.Read.All` worden niet gegeven. `RoleManagement.ReadWrite.Directory`,
`AppRoleAssignment.ReadWrite.All` en `Application.ReadWrite.All` krijgt de applicatie nooit
(`FORBIDDEN_APP_ROLES`). Voor Exchange is `Exchange.ManageAsApp` nodig met de Entra-rol Exchange Administrator
(standaard); de smallere rol Exchange Recipient Administrator is ONGEVERIFIEERD (U5). Het schrijfpad voor
distributielijsten en contacten is niet gebouwd in Fase B (ADR-0102, ODB-01) en komt in Fase D stap D1 (Deel 5,
ADR-0180, ADR-0181). `GroupMember.ReadWrite.All` is verleend in Fase B, ongebruikt in Fase C en gebruikt vanaf
Fase D stap D1 (Deel 5).

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

### Deel 5: Fase D stap D1, distributielijsten, contacten en groepsleden

Stap D1 is de eerste stap die **schrijft**. Zij vraagt Microsoft om **geen nieuw recht**: geen nieuwe
Graph-applicatierol (de draaiende applicatie heeft nog dezelfde vier van set 1), geen nieuwe Exchange-rol en
geen nieuw delegated scope voor de wizard. Wat verandert is dat twee eerder verleende rechten nu **gebruikt**
worden. Deel 5 wint van de Delen 2 tot en met 4 waar het over stap D1 gaat. Bronnen:
[`research-microsoft-d.md`](../specs/004-phase-d/research-microsoft-d.md) (Microsoft Learn, 2026-10-13),
de gate-notities `specs/004-phase-d/gate-notes/GD1-*.md` en `packages/shared/src/exchange/allow-list.ts`.
**Niets hiervan is tegen een echte tenant gedraaid**; wat alleen op Learn rust, is gemarkeerd en heeft een rij
in [open-points.md](open-points.md) en een controle in [owner-test-phase-d1.md](owner-test-phase-d1.md).

| Recht | Tot nu toe | Vanaf stap D1 |
|---|---|---|
| `GroupMember.ReadWrite.All` | Verleend in Fase B (ODB-02, één toestemming); **verleend, ongebruikt in Fase C** (Deel 4) | **Gebruikt** door `groups.members.add` en `groups.members.remove` (FR-D-352): het minst bevoorrechte applicatierecht om een gebruiker aan een groep toe te voegen (R-D-08, geverifieerd) |
| `Exchange.ManageAsApp` en de Entra-rol Exchange Administrator van de service principal (ODB-03) | Door de wizard verleend; alleen door de verificatieprobe gebruikt | **Gebruikt** door elke aanroep van de Exchange-worker: lezen van lijsten, leden en contacten, en alle schrijfacties |
| `Exchange.ManageAsAppV2` | Verleend waar de tenant hem toont | De worker heeft hem niet nodig; alleen de Admin API-probe gebruikt hem. Of hij bestaat is nog ONGEVERIFIEERD (U77) |

Nooit verleend (`FORBIDDEN_APP_ROLES`): `RoleManagement.ReadWrite.Directory`,
`AppRoleAssignment.ReadWrite.All`, `Application.ReadWrite.All`. Een groep die aan een rol toegewezen kan worden
vraagt voor een ledenwijziging `RoleManagement.ReadWrite.Directory`; het panel heeft dat niet, Graph antwoordt 403
en het panel toont "geen recht voor deze wijziging" voor dat lid (U96). Het verwijderpad van een lid eindigt
altijd op `/$ref`: zonder dat verwijdert Graph (waarschuwing op de Learn-pagina) het lid zelf als de applicatie dat
object mag beheren.

**Groepsleden via Graph (P53, P54).** Eerst `GET /groups/{id}/members` (direct, per 999, hoogstens 50
pagina's, `GroupMember.Read.All`) om "already" te bepalen, daarna per lid één `POST /groups/{id}/members/$ref`
of `DELETE /groups/{id}/members/{id}/$ref` (`204`, `GroupMember.ReadWrite.All`). Alleen gebruikers. Alleen
beveiligings- en Microsoft 365-groepen met toegewezen lidmaatschap: dynamisch, gesynchroniseerd, distributie,
e-mailbeveiligd, onbekend soort of verborgen lidmaatschap geeft 409 `read_only_object` vóór elke aanroep. De
bulkvorm (`PATCH` met `members@odata.bind`, 20 stuks) is alles-of-niets en wordt niet gebruikt. Graph geeft
`400` voor een bestaand lid, een niet-ondersteund type en een nog niet gerepliceerde groep alle drie (U92):
het panel leest dus eerst. Het antwoord op het verwijderen van een niet-lid staat niet beschreven (U93): een
`404` telt als "already".

**Distributielijsten en contacten via de Exchange-worker (P40 tot en met P45, P47 tot en met P52).** Alle
Exchange-aanroepen lopen via de `pwsh`-worker (app-only, applicatie-id, `.onmicrosoft.com`-domein en
certificaat). Het certificaat komt in het geheugen bij de worker (`EXCHANGE_KEY_HANDOVER=memory`) of via een
kortlevend bestand op een tmpfs (`tmpfs`, de terugval); of het geheugenpad op Linux werkt is U75, en de
overdracht is PEM, gebouwd maar niet bewezen tegen een echte `pwsh` of een tenant (bevinding FD-01). De worker mag **tien cmdlets
en niets anders**, elk met een gesloten parameterset (ADR-0181):

| Cmdlet | Gebruikt door | Learn |
|---|---|---|
| `Get-DistributionGroup` | P40, P41, P51, P52 | geverifieerd; de filtereigenschappen en het `Members`-filter: ONGEVERIFIEERD (U97), de waarden van `SortBy` en `RecipientTypeDetails` (U99) |
| `Get-Recipient` | P40, P41 (dynamische lijsten) | geverifieerd als cmdlet; waardenlijst ONGEVERIFIEERD (U99). `Get-DistributionGroup` geeft dynamische lijsten niet terug |
| `Get-DistributionGroupMember` | P41, P42, P43, P44 (vooraf lezen en teruglezen), P45 | geverifieerd; standaard `ResultSize` en paginering: U79 |
| `Add-DistributionGroupMember`, `Remove-DistributionGroupMember` | P43, P44 | geverifieerd; `Member` is bij Learn optioneel maar door het panel verplicht gemaakt; `-BypassSecurityGroupManagerCheck` altijd; gedrag bij een bestaand lid of een niet-lid: U94 |
| `Get-MailContact` | P45, P47 tot en met P51 | geverifieerd; standaard resultaatgrootte U79; dat `-ANR` het externe adres vindt (nodig voor de dubbelcontrole) is ONGEVERIFIEERD (U97) |
| `New-MailContact`, `Set-MailContact`, `Remove-MailContact` | P49, P50, P51 | geverifieerd; `-Name` wordt afgeleid (alias op 57 tekens, streepje, 6 hexadecimale tekens), uniciteit ONGEVERIFIEERD (U95); `Set-MailContact` heeft geen voor- of achternaam (U15 voor deze cmdlet beantwoord) |
| `Get-OrganizationConfig` | verificatieprobe van de wizard en de ping van de eigenaarstest | geverifieerd |

Wat het panel nooit stuurt, door de opbouw van de toegestane lijst: `-Confirm` of `-WhatIf` als parameter van de
aanroeper (het script voegt zelf `-Confirm:$false` toe, alleen bij de twee `Remove-`-cmdlets), een parameter die
niet in de tabel staat, een lege `Identity`, een cmdlet buiten de tien en een waarde die niet bij het patroon
van zijn parameter past. De server controleert elke aanroep voordat hij naar de worker gaat en het script
controleert hem opnieuw tegen dezelfde tabel.

- **Exchange-rol.** Standaard Exchange Administrator (`exchange_administrator`): volgens Learn voldoende voor
  elke taak en voor de beheerderscontrole. Of Exchange Recipient Administrator of een eigen rolgroep volstaat
  is U76 (en U5); ODB-03 zegt: pas smaller maken na OV-D1. Een weigering geeft 503 `exchange_permission_missing`.
  Dat de rol van de service principal de beheerderscontrole van `-BypassSecurityGroupManagerCheck` vervult, is
  U78.
- **Een nieuwe rol kan minuten duren.** Tot dan faalt de eerste verbinding met de detailcode
  `exchange_role_pending` (503 `exchange_unavailable`) en zegt de pagina dat.
- **Throttling.** Exchange Online publiceert geen getallen voor app-only gebruik (U81). Het panel herhaalt een
  gethrottlede of tijdelijk falende aanroep hoogstens 3 keer met oplopende wachttijd (1 s tot 15 s,
  `Retry-After` eerst) en geeft dan 503 `exchange_throttled` of `exchange_unavailable`; de getallen zijn van
  ons. Schrijven in Exchange is uiteindelijk consistent (U82): P43 en P44 melden `readBackPending`.
- **Exchange-audit.** Volgens Learn staat het beheerauditlog standaard aan, 180 dagen, tot 30 minuten
  vertraging, en `Get-`, `Search-` en `Test-` worden niet gelogd. Of een uitvoering door een service principal
  wordt gelogd en hoe ze te herkennen is, is U89; dat elke schrijf-cmdlet van stap D1 gelogd wordt, is U90
  (OV-D4). Gesynchroniseerde objecten (`IsDirSynced`) zijn alleen lezen; de uitvoernaam is aangenomen (U12).

**Niet aangevraagd, niet gebruikt, niet gebouwd in stap D1:** nieuwe Graph- of Exchange-rollen; de rechten voor
apparaten, service principals en organisatiecontacten en `Member.Read.Hidden`; `Set-Contact`, `Set-DistributionGroup`,
eigenaars- en managerwijzigingen, aanmaken of verwijderen van lijsten en groepen;
`Get-DynamicDistributionGroupMember` (dynamische lijsten hebben in het panel geen ledenlijst, bevinding FD-05);
licenties (U17, U48 uitgesteld).

Wat de eigenaar tegen een echte tenant sluit: U75 tot en met U85, U89 en U90, en U92 tot en met U100 met de controles OV-D1, OV-D2,
OV-D4 en OV-D5, stap voor stap in [owner-test-phase-d1.md](owner-test-phase-d1.md).
