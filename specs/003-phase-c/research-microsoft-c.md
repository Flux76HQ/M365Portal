# Research: Microsoft facts for Phase C (users and groups, read only)

Date of reading: 2026-10-12 (Microsoft Learn, Graph v1.0). Every row names the page, what it says and what the spec does with it. A statement that Learn does not make is not here; it is an UNVERIFIED row `U66` and up in spec section 8.3 and in `docs/open-points.md`. Nothing below comes from memory. Phase C is read only, so only the read pages were consulted.

The panel's application holds these Graph application roles (Phase B, spec B 8.2, decision ODB-02): `User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All` (granted, unused in Phase C), `Organization.Read.All`. It does **not** hold `Group.Read.All`, `Directory.Read.All` or `Member.Read.Hidden`. Phase C must work with these and asks for no new permission.

## R-C-01 List users

Page: https://learn.microsoft.com/graph/api/user-list?view=graph-rest-1.0

- Application permission: least privileged `User.Read.All`. The panel holds it. (Read in full.)
- Supported query options: `$count`, `$expand`, `$filter`, `$orderby`, `$search`, `$select`, `$top`. `$skip` is **not** supported. Default page size 100, maximum 999 (500 when `signInActivity` is selected or filtered, which Phase C never does).
- By default only a limited property set is returned (`businessPhones`, `displayName`, `givenName`, `id`, `jobTitle`, `mail`, `mobilePhone`, `officeLocation`, `preferredLanguage`, `surname`, `userPrincipalName`); other properties need `$select`.
- `ConsistencyLevel: eventual` and `$count` are required for `$search` and for "specific usage of `$filter`". Examples on the page: `$filter=startswith(displayName,'a')&$orderby=displayName&$count=true&$top=1` with the header (filter plus orderby), and `$search="displayName:wa"&$orderby=displayName&$count=true` with the header.
- `$count` and `$search` are not available in Azure AD B2C tenants (the panel connects to a workforce tenant; recorded as an assumption).
- Used by: FR-C-101, FR-C-102, FR-C-201, FR-C-202.

## R-C-02 Advanced queries and which properties filter how

Page: https://learn.microsoft.com/graph/aad-advanced-queries

- Advanced query = header `ConsistencyLevel: eventual` and, except for `$search`, `$count=true`.
- `$filter` and `$orderby` together are supported only with advanced queries. `$expand` is not supported with advanced queries.
- The `not`/`ne` operators and `endsWith` need advanced queries. `in` works wherever `eq` works.
- User properties: `accountEnabled` (eq, default and advanced), `displayName`, `mail` (eq and startsWith, default and advanced), `userPrincipalName` (eq, startsWith), `department` (eq, startsWith), `userType` (eq, default and advanced; eq null needs advanced). Group properties: `displayName`, `mail`, `mailNickname` (eq, startsWith), `mailEnabled`, `securityEnabled` (eq), `groupTypes/any(p:p)` (eq), `onPremisesSyncEnabled` (eq), `membershipRule` (eq, startsWith).
- The page lists the relationships that support advanced queries, among them `group` members, transitiveMembers, memberOf, transitiveMemberOf, owners, and `user` memberOf, transitiveMemberOf.
- Used by: FR-C-102, FR-C-202, FR-C-301.

## R-C-03 List groups

Page: https://learn.microsoft.com/graph/api/group-list?view=graph-rest-1.0

- Lists all groups "excluding dynamic distribution groups" (those are managed in the Exchange admin center). So the Graph list never shows dynamic distribution lists.
- Application permission: **least privileged `Group-NestingSupport.ReadWrite.All`; higher privileged include `Group.ReadBasic.All`, `Directory.Read.All`, `Group.Read.All`, `GroupMember.Read.All`**. `GroupMember.Read.All` is therefore accepted by the page (this closes the "is it listed" half of U36; which properties it returns stays U36).
- Supported options as for users; default and maximum page size 100 and 999; `$skip` not supported. Replication delay note: recently created or changed groups may not appear at once.
- Group type filters given on the page: Microsoft 365 `groupTypes/any(c:c+eq+'Unified')`; security `mailEnabled eq false and securityEnabled eq true`; mail-enabled security `NOT groupTypes/any(c:c eq 'Unified') and mailEnabled eq true and securityEnabled eq true` (with `$count=true` and the header); distribution `NOT groupTypes/any(c:c eq 'Unified') and mailEnabled eq true and securityEnabled eq false` (same).
- `$search` tokenises only `displayName` and `description`.
- Used by: FR-C-301, FR-C-302, FR-C-304.

## R-C-04 Group types

Page: https://learn.microsoft.com/graph/api/resources/groups-overview?view=graph-rest-1.0

| Type | groupTypes | mailEnabled | securityEnabled | Via Graph |
|---|---|---|---|---|
| Microsoft 365 | `["Unified"]` | true | true or false | managed |
| Security | `[]` | false | true | managed |
| Mail-enabled security | `[]` | true | true | read-only |
| Distribution | `[]` | true | false | read-only |

Dynamic distribution groups are not supported by Graph. The panel derives `kind` from exactly these three properties (FR-C-303); a group whose properties were not returned has kind `unknown` (U36).

## R-C-05 Group members and hidden membership

Pages: https://learn.microsoft.com/graph/api/group-list-members?view=graph-rest-1.0, https://learn.microsoft.com/graph/api/group-list-transitivemembers?view=graph-rest-1.0, https://learn.microsoft.com/graph/api/resources/group?view=graph-rest-1.0 (visibility), https://learn.microsoft.com/graph/permissions-overview (limited information)

- `GET /groups/{id}/members`: application least privileged `GroupMember.ReadBasic.All`; `GroupMember.Read.All` is listed as higher privileged, so the panel's role is accepted. Default and maximum page size 100 and 999.
- "The use of query parameters with this API, except for `$expand`, is supported only with advanced query parameters" and the header `ConsistencyLevel: eventual` plus `$count` is required "when using `$search`, `$filter`, `$orderby`, or OData cast". The spec therefore always sends the advanced pair on member and owner lists (cheap, and it makes `$top` and `$select` safe).
- Members are a `directoryObject` collection. If the app cannot read an object type, the object is returned with only `id` and `@odata.type`, other properties `null`. With `GroupMember.Read.All` alone: users come back limited unless `User.ReadBasic.All` or `User.Read.All` is held (the panel holds `User.Read.All`), groups are returned with basic properties (`GroupMember.Read.All`), devices, service principals and contacts come back limited. The UI must therefore treat every non-id property as possibly `null`.
- "To list the members of a hidden membership group, the `Member.Read.Hidden` permission is also required." The panel does not hold it. Group `visibility` values: `Private`, `Public`, `HiddenMembership`; "Nonmembers can't see the members" of a hidden-membership group. What Graph answers to an app without the permission (empty list, 403, error) is not stated: U67. The spec avoids the question: a group with `visibility = HiddenMembership` is not asked for members; the page says membership is hidden (FR-C-108).
- Transitive members exist (`/transitiveMembers`); Phase C lists direct members only (slim; deferred).
- Used by: FR-C-108, FR-C-306, FR-C-402.

## R-C-06 Group owners

Pages: https://learn.microsoft.com/graph/api/group-list-owners?view=graph-rest-1.0 and the Microsoft Graph PowerShell page for `Get-MgGroupOwner` (permissions table, application: `GroupMember.Read.All`, `Directory.Read.All`, `Group.Read.All`, `Group.ReadWrite.All`, `GroupMember.ReadWrite.All`)

- `GET /groups/{id}/owners`; the same advanced-query rule as members (query parameters other than `$expand` need the header and `$count`).
- "Owners are currently not available in Microsoft Graph for groups that were created in Exchange, distribution groups, or groups that are synchronized from an on-premises environment." So an empty owner list for such a group is expected and the UI says so (FR-C-307). Owners may be users or service principals.
- The permission table of the REST page itself was shown only in part by the search tool; the PowerShell page lists `GroupMember.Read.All` for application. The first live call settles it (U68).

## R-C-07 Manager

Page: https://learn.microsoft.com/graph/api/user-list-manager?view=graph-rest-1.0

- `GET /users/{id | userPrincipalName}/manager`; a user without a manager gives **404 Not Found**.
- **The permission table of this page says: Application: "Not supported."** Delegated is `User.Read.All`. The sibling page for `agentUser` lists `User.Read.All` for application. So an app-only manager read may fail with the panel's application. This is U66, and the reason the manager is best effort (FR-C-107): the user detail works without it and says "not available", never an error page.
- `$expand=manager($select=id,displayName)` on a user is documented on the same page (for `/me` and `/users/{id}`); `$levels` needs the header. Whether `$expand` is allowed app-only is part of U66.

## R-C-08 A user's memberships

Pages: https://learn.microsoft.com/graph/api/user-list-memberof?view=graph-rest-1.0 and https://learn.microsoft.com/graph/api/user-list-transitivememberof?view=graph-rest-1.0

- `memberOf` for another user, application: **only `Directory.Read.All`** (and `Directory.ReadWrite.All`). The panel does not hold it. This confirms the Phase B decision to avoid it.
- `transitiveMemberOf` for another user, application: least privileged `User.Read.All`; higher privileged `Directory.Read.All`, `Directory.ReadWrite.All`, `Group.Read.All`, `GroupMember.Read.All`. The panel holds `User.Read.All` and `GroupMember.Read.All`. Phase C uses `GET /users/{id}/transitiveMemberOf/microsoft.graph.group` (OData cast; the advanced-queries page shows `transitiveMemberOf/microsoft.graph.group?$count=true` with the header). The list is transitive (nested groups included) and the UI labels it so (FR-C-206).
- "To list the members of a group with hidden membership, the `Member.Read.Hidden` permission is required": groups with hidden membership are probably absent from a user's list. Whether they are is U67; the page states a note that such groups may be missing (FR-C-206).
- Used by: FR-C-101, FR-C-206.

## R-C-09 Permissions reference

Page: https://learn.microsoft.com/graph/permissions-reference

- `GroupMember.Read.All` (application, id `98830695-27a2-44f7-8c18-0c3ebc9698f6`): "Allows the app to read memberships and basic group properties for all groups without a signed-in user." The wording "basic group properties" is the origin of U36.
- `User.Read.All` (application): "read user profiles without a signed in user".
- `Member.Read.Hidden` (application): "read the memberships of hidden groups and administrative units without a signed-in user". Not held, not requested (decision ODC-04 default).
- `User.ReadBasic.All` (application): basic profile (`displayName`, `givenName`, `id`, `mail`, `photo`, `securityIdentifier`, `surname`, `userPrincipalName`). Not held.

## R-C-10 What was not read

- Throttling cost of the list calls beyond the Phase B reading (U16 closed in Phase B).
- Behaviour for guest users in `userType` filters (`Guest`, `Member`): the property is filterable with `eq` (R-C-02); the literal values are those of the `user` resource and are carried as U72.
- Anything about `assignedLicenses`: not touched (owner decision 3; U17 and U48 stay open).
