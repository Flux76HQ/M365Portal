# Data Model: M365Portal Phase B

**Spec**: [spec.md](spec.md) (FR-B-104, FR-B-105, FR-B-201, FR-B-209, FR-B-407, FR-B-501 to FR-B-523, FR-B-601, FR-B-701, FR-B-702, Appendix B) | **Plan**: [plan.md](plan.md) (PB-23, PB-26, SB-02, SB-11, SB-15, SB-21, SB-23) | **API**: [contracts/phase-b-api.md](contracts/phase-b-api.md) | **Builds on**: [Phase A data model](../001-m365portal/data-model.md)

This document is the single description of what Phase B persists, how it is protected, how it may change, and what is deliberately kept out of the database. Phase A tables (`branding`, `branding_asset`, `audit_log`) are not touched. Section 5 holds the migration SQL that was executed against a real SQLite while planning (section 13); the implementation commits the same statements as `apps/server/drizzle/0001_phase_b.sql`.

## Samenvatting (Nederlands)

Fase B voegt één migratie toe, `0001_phase_b`: 17 tabellen, 9 indexen en 29 triggers, plus zaaigegevens (de vijf ingebouwde rollen, het sjabloon Bestuur, de epoch-teller). Geen enkele tabel bevat een geheim in leesbare vorm: de privésleutel van het certificaat staat versleuteld in `secret` (XChaCha20-Poly1305, sleutel uit `APP_KEY`, die niet in `/data` staat), sessies worden bewaard als SHA-256 van het cookie, en JSON-kolommen mogen alleen via schema's met een lijst toegestane sleutels worden geschreven. De regels die niet mogen falen zitten óók in SQL: ingebouwde rollen zijn onveranderlijk, de laatste Eigenaar kan niet worden verwijderd of gedegradeerd (in dezelfde transactie, dus ook bij gelijktijdige verzoeken), elke wijziging in rollen, rechten, toewijzingen of scopes verhoogt `rbac_epoch` (zo vervalt de rechtencache direct), de tenant wordt vastgezet en de installatiestatus gaat alleen vooruit. De CHECK-uitdrukkingen komen uit één bron (`db/check-macros.ts`), zodat schema en SQL niet uit elkaar kunnen lopen. De SQL is getest op SQLite 3.53.4 met 59 beweringen en een mutatietest die voor alle 29 triggers laat zien dat het weglaten ervan een test laat falen. De momentopname `0001-phase-b.sql` en een upgradetest (met huisstijl, afbeeldingen en `preview`-auditrijen) worden in dezelfde commit meegeleverd.

## 1. Scope and mapping from the spec

| Group | Table | Role | Rows |
|---|---|---|---|
| Setup | `setup_state` | Installation state machine, mode, install id, designated first Owner, proposed tenant, language | exactly 1 |
| | `setup_step` | One row per (step, sub-action): status, attempts, error code, rollback hint, secret-free detail | at most 25 (registry `STEPS`, plan 9.4) |
| | `setup_object` | Tenant objects the wizard created or adopted (what repair may report) | a handful |
| | `setup_log` | Live log lines of the wizard (catalogue key plus scalar parameters) | at most 1,000 (oldest trimmed) |
| | `runner_lease` | Which process runs the wizard right now | at most 1 |
| Secrets | `secret` | Sealed secrets (Phase B: the certificate private key only) | 1 to 2 |
| | `certificate` | Public data of the panel's certificates and their state | 1 to 3 |
| Tenant | `tenant_connection` | The pinned tenant, the application, service principals, redirect URIs, proof list | exactly 0 or 1 |
| Identity | `app_user` | Last-known labels per `(tid, oid)` and the group-resolution time | one per person who signed in |
| | `session` | Server-side sessions (hashed id) | at most 10 per principal |
| RBAC | `rbac_role` | Roles (five built-in, immutable) | 5 plus custom roles in later phases |
| | `rbac_role_permission` | (role, permission, qualifier) | 47 seeded (15 + 13 + 9 + 6 + 4) |
| | `rbac_role_template` | Templates that prefill a role plus scope (*Bestuur*); not assignable | 1 seeded |
| | `rbac_assignment` | Principal (user or Entra group) holds a role, optionally scoped and expiring | at most 5,000 (service limit) |
| | `rbac_assignment_scope` | Scope items of one assignment | at most 50 per assignment |
| | `rbac_group_member_cache` | Which bound groups a user belongs to (from `checkMemberGroups`) | derived, rebuildable |
| | `rbac_epoch` | Counter bumped by triggers; invalidates the grants memo | exactly 1 |

Tables not created: no `settings` bag (the tenant settings are typed columns of `tenant_connection`), no token table (the product retains no Microsoft token), no `user` table keyed by e-mail (labels never select a principal, FR-B-406), no permission catalogue table (permissions are the shared registry; rows reference them by name and `rbac_role_permission` is validated by the writer).

### Differences from spec Appendix B (recorded as SB-02, SB-11 and SB-15 in plan 18.1)

| Table | Difference | Why |
|---|---|---|
| `setup_state` | new `proposed_tenant_id` | The tenant is learned at `connect` (bootstrap sign-in or manual input) but pinned only after the first app-only read proves it (verification V2) |
| `tenant_connection` | `tenant_id` is nullable until pinned; `updated_at`; trigger forbids change or delete once set | Same reason; I-B7 |
| `setup_step` | `updated_at` | The UI shows "last change" and the runner resets stale `running` rows by it |
| `certificate` | `state` gains `pending`; `created_at`; two partial unique indexes (one `active`, one `pending`); unique SHA-1 | Crash-safe renewal: generate and seal first, upload, prove possession, then swap (PB-13) |
| `rbac_assignment` | `scope_hash` column (the spec names it in the uniqueness rule but not in the column list) | `UNIQUE (principal_type, principal_id, role_id, scope_hash)` needs a real column; it is the SHA-256 (64 lower-case hex) of the canonical scope key, and unscoped assignments carry the hash of the canonical key of the empty list |
| `rbac_assignment_scope` | the `CHECK` encodes the scope matrix (plan 11.3): `by id` never targets `user`; `alias` never targets `user`; `department` only `user` and `contact` | The matrix is the single source for what a scope may match; the database refuses what the algorithm cannot evaluate |
| `setup_object` | `tenant_object_id` is free text (1 to 128 bytes), not a GUID | Grants and directory role assignments have non-GUID ids (SB-11) |

## 2. Storage layout on disk

```text
${DATA_DIR}                         unchanged: /data, uid 65532, directories 0700, files 0600 (umask 077)
├── m365portal.sqlite               Phase A file; Phase B adds tables to it (+ -wal and -shm while open)
├── setup-token                     one line: 32 random bytes, base64url; mode 0600; created with O_EXCL while the state is not
│                                   `completed` and no SETUP_TOKEN is set; unlinked after `completed` (and at start if it lingers)
├── branding/ ...                   Phase A
└── backups/
    ├── pre-migrate-0000-0001.sqlite    taken by the Phase A wrapper before 0001 is applied (the database has applied rows); newest 3 kept
    └── pre-rotate-<UTC>.sqlite         taken by `rotate-app-key` (DM-01); newest 3 kept, counted separately from pre-migrate
```

- `APP_KEY`, `APP_KEY_PREVIOUS` and `SETUP_TOKEN` are environment values or Docker secrets, never files below `/data` (the one exception is the generated `setup-token`, which exists only while setup is open). The key that opens `secret.blob` is therefore never in a copy of `/data` (FR-B-104).
- A `pre-rotate-*` copy holds sealed blobs under the **old** key; it is useless without that key and has the same protection and classification as the live database (section 14).
- Nothing else is written outside the database: no certificate file, no key file, no session file, no log file.

## 3. Entity relationships

```text
setup_state (1)    setup_step (step, sub_action)    setup_log (seq)    runner_lease (1)    setup_object (kind, id)
   no foreign keys among the setup tables: one engine writes them, each change in one transaction with its audit entry

secret (id) <---RESTRICT--- certificate.secret_id
certificate (id) <---RESTRICT--- tenant_connection.certificate_id          (the active certificate; never deleted while pointed at)

app_user (tid, oid)      session (id_hash; tid, oid)      joined by (tid, oid), no foreign key:
                         a break-glass session has oid '' and no app_user row

rbac_role (id) <---CASCADE--- rbac_role_permission.role_id                 (immutable for built-in roles)
rbac_role (id) <---RESTRICT--- rbac_assignment.role_id
rbac_assignment (id) <---CASCADE--- rbac_assignment_scope.assignment_id

rbac_assignment.principal_id        names an Entra user or group: no foreign key (the object lives in the tenant, and an
                                    assignment may exist before the person has ever signed in)
rbac_group_member_cache             (user_oid, group_id): no foreign key, derived data, cleared wholesale by triggers
rbac_epoch (1)                      bumped by triggers on the four RBAC tables
audit_log                           Phase A, append-only, no foreign keys; target_type/target_id are plain text
```

Five foreign keys exist, all inside Phase B: `certificate.secret_id` (RESTRICT), `tenant_connection.certificate_id` (RESTRICT), `rbac_role_permission.role_id` (CASCADE), `rbac_assignment.role_id` (RESTRICT) and `rbac_assignment_scope.assignment_id` (CASCADE). `foreign_keys` is ON at run time (Phase A connection settings), so a certificate cannot lose its sealed key and a role cannot be deleted while assigned.

## 4. How the migration is built

1. **Generated section.** `apps/server/src/db/schema/phase-b.ts` (Drizzle `sqlite-core`) declares the 17 tables, their `check()` constraints and their indexes; `drizzle-kit generate` emits the `CREATE TABLE` and `CREATE INDEX` statements. If 0.45.4 cannot emit a construct (a partial unique index, a multi-line `CHECK`), that statement moves to the hand-written section as Phase A section 4 allows (UNVERIFIED which helpers exist; the parity test of section 12.4 catches any difference).
2. **Hand-written section**, behind the marker line `-- ===== hand-written section (not in schema.ts): seeds and triggers =====`. It holds `INSERT INTO` statements for the four seeded tables and the 29 `CREATE TRIGGER` statements, and nothing else (`server/migrations.test.ts` asserts the marker and that this section contains only those two statement kinds). Application code never runs inside a migration.
3. **Check macros.** Four `CHECK` shapes recur dozens of times (a GUID, a UTC timestamp with milliseconds, fixed-length lower-case hex, a bounded JSON object). They are functions in `apps/server/src/db/check-macros.ts` (`guid`, `iso`, `hex`, `jsonObject`) that return the SQL fragment; the Drizzle `check()` calls use them, so the text drizzle-kit writes into the migration is generated from the same code the schema uses and the two cannot differ (PB-26). The same module exports `expandCheckMacros(text)`, used only by tests, which turns the macro notation of section 5 into the expanded text. The definitions (normative):

```text
GUID(c)         (length(c) = 36 AND c GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
                lower-case canonical GUID text, any version (GLOB is case-sensitive)
ISO(c)          c GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
                the Phase A time shape: UTC, milliseconds, trailing Z
HEX(c, n)       (length(c) = n AND c NOT GLOB '*[^0-9a-f]*')
JSONOBJ(c, m)   (json_valid(c) = 1 AND json_type(c) = 'object' AND length(CAST(c AS BLOB)) <= m)
```

   Macros are exact shape checks, not semantic ones: `ISO` does not reject month 13 (the writers use `Date#toISOString`), and the byte limits count UTF-8 bytes through `CAST(... AS BLOB)` because SQLite cannot count graphemes (the code-point limits are enforced by the shared normalisers, Phase A section 4.1).
4. **No `CHECK` lists values later phases extend** (FR-B-702): `setup_step.step` and `.sub_action`, `setup_object.kind`, `setup_log.step` and `.message_key`, `rbac_role_permission.permission` (shape only), `secret.purpose` (shape only) and every audit column are validated by registries and Zod enums. Closed sets that will not grow do use `CHECK`: `setup_state.state` and `.mode`, step status, log level, `setup_object.origin`, certificate state, session kind, principal type, assignment source, scope target and `match_by`, the qualifier.
5. **Only additions.** The migration contains 17 `CREATE TABLE`, 9 `CREATE INDEX`, 29 `CREATE TRIGGER` and 4 `INSERT INTO` statements (of the new tables) and nothing else: no `ALTER`, no `DROP`, no table rebuild, so none of the Phase A rebuild hazards (Phase A 8.1 item 5) applies and `foreign_key_check` needs no special handling. The upgrade test asserts that the `sqlite_master` text of `branding`, `branding_asset`, `audit_log` and their triggers and indexes is byte-identical before and after.

## 5. The migration (macro notation)

Everything between the two comment markers is compared by `server/migrations.doc.test.ts` with the committed migration: macros expanded, whitespace collapsed, each `CREATE` statement matched by object name, the top-level clauses of each `CREATE TABLE` compared as a set (so constraint order may differ), triggers and seeds compared as text. A difference fails the test and is fixed in this document in the same commit (the document is the design, the committed file is the truth; negative control: the test run against a copy of this block with one changed constant must fail). Statements are separated by `--> statement-breakpoint`, as drizzle-kit writes them.

<!-- migration-0001:begin -->
```sql
-- Migration 0001_phase_b (macros: ISO(col), HEX(col,n), GUID(col), JSONOBJ(col,max))
-- ===== generated section (what drizzle-kit emits from schema.ts) =====
CREATE TABLE `setup_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'unconfigured' NOT NULL,
	`mode` text DEFAULT 'automatic' NOT NULL,
	`install_id` text NOT NULL,
	`designated_owner_oid` text,
	`proposed_tenant_id` text,
	`default_language` text,
	`completed_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `setup_state_singleton` CHECK (`id` = 1),
	CONSTRAINT `setup_state_state` CHECK (`state` IN ('unconfigured', 'in_progress', 'awaiting_first_signin', 'completed')),
	CONSTRAINT `setup_state_mode` CHECK (`mode` IN ('automatic', 'manual')),
	CONSTRAINT `setup_state_install_id` CHECK (HEX(`install_id`, 32)),
	CONSTRAINT `setup_state_owner_oid` CHECK (`designated_owner_oid` IS NULL OR GUID(`designated_owner_oid`)),
	CONSTRAINT `setup_state_tenant` CHECK (`proposed_tenant_id` IS NULL OR GUID(`proposed_tenant_id`)),
	CONSTRAINT `setup_state_language` CHECK (`default_language` IS NULL OR `default_language` IN ('nl', 'en')),
	CONSTRAINT `setup_state_completed_at` CHECK ((`state` = 'completed') = (`completed_at` IS NOT NULL)),
	CONSTRAINT `setup_state_updated_at` CHECK (ISO(`updated_at`))
);
--> statement-breakpoint
CREATE TABLE `setup_step` (
	`step` text NOT NULL,
	`sub_action` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`finished_at` text,
	`error_code` text,
	`rollback_hint_key` text,
	`detail` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`step`, `sub_action`),
	CONSTRAINT `setup_step_status` CHECK (`status` IN ('pending', 'running', 'waiting', 'succeeded', 'warning', 'failed', 'skipped')),
	CONSTRAINT `setup_step_attempt` CHECK (`attempt` >= 0),
	CONSTRAINT `setup_step_detail` CHECK (JSONOBJ(`detail`, 4096)),
	CONSTRAINT `setup_step_times` CHECK ((`started_at` IS NULL OR ISO(`started_at`)) AND (`finished_at` IS NULL OR ISO(`finished_at`)) AND ISO(`updated_at`))
);
--> statement-breakpoint
CREATE TABLE `setup_object` (
	`kind` text NOT NULL,
	`tenant_object_id` text NOT NULL,
	`app_id` text,
	`name` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`kind`, `tenant_object_id`),
	CONSTRAINT `setup_object_id` CHECK (length(`tenant_object_id`) BETWEEN 1 AND 128),
	CONSTRAINT `setup_object_app_id` CHECK (`app_id` IS NULL OR GUID(`app_id`)),
	CONSTRAINT `setup_object_name` CHECK (length(CAST(`name` AS BLOB)) BETWEEN 1 AND 256),
	CONSTRAINT `setup_object_origin` CHECK (`origin` IN ('created', 'adopted')),
	CONSTRAINT `setup_object_created_at` CHECK (ISO(`created_at`))
);
--> statement-breakpoint
CREATE TABLE `setup_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`step` text NOT NULL,
	`level` text NOT NULL,
	`message_key` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `setup_log_level` CHECK (`level` IN ('info', 'warn', 'error')),
	CONSTRAINT `setup_log_params` CHECK (JSONOBJ(`params`, 1024)),
	CONSTRAINT `setup_log_ts` CHECK (ISO(`ts`))
);
--> statement-breakpoint
CREATE TABLE `runner_lease` (
	`id` integer PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT `runner_lease_singleton` CHECK (`id` = 1),
	CONSTRAINT `runner_lease_times` CHECK (ISO(`heartbeat_at`) AND ISO(`expires_at`))
);
--> statement-breakpoint
CREATE TABLE `secret` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`key_id` text NOT NULL,
	`blob` blob NOT NULL,
	`created_at` text NOT NULL,
	`retired_at` text,
	CONSTRAINT `secret_id` CHECK (GUID(`id`)),
	CONSTRAINT `secret_purpose` CHECK (length(`purpose`) BETWEEN 1 AND 64 AND `purpose` NOT GLOB '*[^a-z_]*'),
	CONSTRAINT `secret_key_id` CHECK (HEX(`key_id`, 16)),
	CONSTRAINT `secret_blob` CHECK (typeof(`blob`) = 'blob' AND length(`blob`) >= 41 AND length(`blob`) <= 16384 AND hex(substr(`blob`, 1, 1)) = '01'),
	CONSTRAINT `secret_times` CHECK (ISO(`created_at`) AND (`retired_at` IS NULL OR ISO(`retired_at`)))
);
--> statement-breakpoint
CREATE TABLE `certificate` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_id` text NOT NULL,
	`thumbprint_sha1` text NOT NULL,
	`thumbprint_sha256` text NOT NULL,
	`subject` text NOT NULL,
	`not_before` text NOT NULL,
	`not_after` text NOT NULL,
	`public_der` blob NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`secret_id`) REFERENCES `secret`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `certificate_id` CHECK (GUID(`id`)),
	CONSTRAINT `certificate_sha1` CHECK (HEX(`thumbprint_sha1`, 40)),
	CONSTRAINT `certificate_sha256` CHECK (HEX(`thumbprint_sha256`, 64)),
	CONSTRAINT `certificate_subject` CHECK (length(CAST(`subject` AS BLOB)) BETWEEN 1 AND 256),
	CONSTRAINT `certificate_validity` CHECK (ISO(`not_before`) AND ISO(`not_after`) AND `not_before` < `not_after`),
	CONSTRAINT `certificate_der` CHECK (typeof(`public_der`) = 'blob' AND length(`public_der`) BETWEEN 256 AND 4096),
	CONSTRAINT `certificate_state` CHECK (`state` IN ('pending', 'active', 'retired')),
	CONSTRAINT `certificate_created_at` CHECK (ISO(`created_at`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `certificate_one_active` ON `certificate` (`state`) WHERE `state` = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX `certificate_one_pending` ON `certificate` (`state`) WHERE `state` = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX `certificate_sha1_uq` ON `certificate` (`thumbprint_sha1`);
--> statement-breakpoint
CREATE TABLE `tenant_connection` (
	`id` integer PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`tenant_name` text,
	`initial_domain` text,
	`app_object_id` text,
	`app_id` text,
	`sp_object_id` text,
	`graph_sp_id` text,
	`exchange_sp_id` text,
	`exchange_enabled` integer DEFAULT 0 NOT NULL,
	`exchange_role_template_id` text,
	`permission_set_version` integer DEFAULT 1 NOT NULL,
	`redirect_uris` text DEFAULT '[]' NOT NULL,
	`certificate_id` text,
	`proof` text DEFAULT '{}' NOT NULL,
	`verified_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`certificate_id`) REFERENCES `certificate`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `tenant_connection_singleton` CHECK (`id` = 1),
	CONSTRAINT `tenant_connection_ids` CHECK ((`tenant_id` IS NULL OR GUID(`tenant_id`)) AND (`app_object_id` IS NULL OR GUID(`app_object_id`)) AND (`app_id` IS NULL OR GUID(`app_id`)) AND (`sp_object_id` IS NULL OR GUID(`sp_object_id`)) AND (`graph_sp_id` IS NULL OR GUID(`graph_sp_id`)) AND (`exchange_sp_id` IS NULL OR GUID(`exchange_sp_id`)) AND (`exchange_role_template_id` IS NULL OR GUID(`exchange_role_template_id`))),
	CONSTRAINT `tenant_connection_strings` CHECK ((`tenant_name` IS NULL OR length(CAST(`tenant_name` AS BLOB)) <= 256) AND (`initial_domain` IS NULL OR length(CAST(`initial_domain` AS BLOB)) <= 256)),
	CONSTRAINT `tenant_connection_exchange` CHECK (`exchange_enabled` IN (0, 1)),
	CONSTRAINT `tenant_connection_version` CHECK (`permission_set_version` >= 1),
	CONSTRAINT `tenant_connection_redirects` CHECK (json_valid(`redirect_uris`) = 1 AND json_type(`redirect_uris`) = 'array' AND length(CAST(`redirect_uris` AS BLOB)) <= 1024),
	CONSTRAINT `tenant_connection_proof` CHECK (JSONOBJ(`proof`, 51200)),
	CONSTRAINT `tenant_connection_times` CHECK ((`verified_at` IS NULL OR ISO(`verified_at`)) AND ISO(`updated_at`))
);
--> statement-breakpoint
CREATE TABLE `app_user` (
	`tid` text NOT NULL,
	`oid` text NOT NULL,
	`upn_label` text,
	`name_label` text,
	`first_seen_at` text NOT NULL,
	`last_signin_at` text NOT NULL,
	`groups_resolved_at` text,
	PRIMARY KEY(`tid`, `oid`),
	CONSTRAINT `app_user_ids` CHECK (GUID(`tid`) AND GUID(`oid`)),
	CONSTRAINT `app_user_labels` CHECK ((`upn_label` IS NULL OR length(CAST(`upn_label` AS BLOB)) <= 256) AND (`name_label` IS NULL OR length(CAST(`name_label` AS BLOB)) <= 256)),
	CONSTRAINT `app_user_times` CHECK (ISO(`first_seen_at`) AND ISO(`last_signin_at`) AND (`groups_resolved_at` IS NULL OR ISO(`groups_resolved_at`)))
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`tid` text NOT NULL,
	`oid` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`absolute_expires_at` text NOT NULL,
	`mfa` integer DEFAULT 0 NOT NULL,
	`amr` text DEFAULT '[]' NOT NULL,
	`authenticated_at` text NOT NULL,
	`step_up_at` text,
	`groups_stale` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `session_id_hash` CHECK (HEX(`id_hash`, 64)),
	CONSTRAINT `session_kind` CHECK (`kind` IN ('user', 'break_glass')),
	CONSTRAINT `session_principal` CHECK (GUID(`tid`) AND ((`kind` = 'user' AND GUID(`oid`)) OR (`kind` = 'break_glass' AND `oid` = ''))),
	CONSTRAINT `session_flags` CHECK (`mfa` IN (0, 1) AND `groups_stale` IN (0, 1)),
	CONSTRAINT `session_amr` CHECK (json_valid(`amr`) = 1 AND json_type(`amr`) = 'array' AND length(CAST(`amr` AS BLOB)) <= 256),
	CONSTRAINT `session_times` CHECK (ISO(`created_at`) AND ISO(`last_seen_at`) AND ISO(`absolute_expires_at`) AND ISO(`authenticated_at`) AND (`step_up_at` IS NULL OR ISO(`step_up_at`)))
);
--> statement-breakpoint
CREATE INDEX `session_principal_idx` ON `session` (`tid`, `oid`);
--> statement-breakpoint
CREATE INDEX `session_expiry_idx` ON `session` (`absolute_expires_at`);
--> statement-breakpoint
CREATE TABLE `rbac_role` (
	`id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`builtin` integer DEFAULT 0 NOT NULL,
	`assignable` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `rbac_role_key` CHECK (length(`key`) BETWEEN 2 AND 32 AND `key` GLOB '[a-z]*' AND `key` NOT GLOB '*[^a-z0-9_]*'),
	CONSTRAINT `rbac_role_flags` CHECK (`builtin` IN (0, 1) AND `assignable` IN (0, 1)),
	CONSTRAINT `rbac_role_created_at` CHECK (ISO(`created_at`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rbac_role_key_uq` ON `rbac_role` (`key`);
--> statement-breakpoint
CREATE TABLE `rbac_role_permission` (
	`role_id` integer NOT NULL,
	`permission` text NOT NULL,
	`qualifier` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	FOREIGN KEY (`role_id`) REFERENCES `rbac_role`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `rbac_role_permission_shape` CHECK (length(`permission`) BETWEEN 3 AND 64 AND `permission` NOT GLOB '*[^a-z:]*'),
	CONSTRAINT `rbac_role_permission_qualifier` CHECK (`qualifier` IN ('', 'basic') AND (`qualifier` = '' OR `permission` = 'users:read'))
);
--> statement-breakpoint
CREATE TABLE `rbac_role_template` (
	`key` text PRIMARY KEY NOT NULL,
	`permissions` text NOT NULL,
	`scope_target` text,
	CONSTRAINT `rbac_role_template_key` CHECK (length(`key`) BETWEEN 2 AND 32 AND `key` GLOB '[a-z]*' AND `key` NOT GLOB '*[^a-z0-9_]*'),
	CONSTRAINT `rbac_role_template_permissions` CHECK (json_valid(`permissions`) = 1 AND json_type(`permissions`) = 'array' AND length(CAST(`permissions` AS BLOB)) <= 2048),
	CONSTRAINT `rbac_role_template_target` CHECK (`scope_target` IS NULL OR `scope_target` IN ('user', 'group', 'distributionList', 'contact'))
);
--> statement-breakpoint
CREATE TABLE `rbac_assignment` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`role_id` integer NOT NULL,
	`scope_hash` text NOT NULL,
	`expires_at` text,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `rbac_role`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `rbac_assignment_id` CHECK (GUID(`id`)),
	CONSTRAINT `rbac_assignment_principal` CHECK (`principal_type` IN ('user', 'group') AND GUID(`principal_id`)),
	CONSTRAINT `rbac_assignment_scope_hash` CHECK (HEX(`scope_hash`, 64)),
	CONSTRAINT `rbac_assignment_source` CHECK (`source` IN ('wizard', 'api', 'break_glass')),
	CONSTRAINT `rbac_assignment_created_by` CHECK (length(CAST(`created_by` AS BLOB)) BETWEEN 1 AND 64),
	CONSTRAINT `rbac_assignment_times` CHECK (ISO(`created_at`) AND (`expires_at` IS NULL OR ISO(`expires_at`)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rbac_assignment_unique` ON `rbac_assignment` (`principal_type`, `principal_id`, `role_id`, `scope_hash`);
--> statement-breakpoint
CREATE INDEX `rbac_assignment_principal_idx` ON `rbac_assignment` (`principal_type`, `principal_id`);
--> statement-breakpoint
CREATE INDEX `rbac_assignment_role_idx` ON `rbac_assignment` (`role_id`);
--> statement-breakpoint
CREATE TABLE `rbac_assignment_scope` (
	`assignment_id` text NOT NULL,
	`position` integer NOT NULL,
	`target` text NOT NULL,
	`match_by` text NOT NULL,
	`attr` text DEFAULT '' NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`assignment_id`, `position`),
	FOREIGN KEY (`assignment_id`) REFERENCES `rbac_assignment`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `rbac_assignment_scope_position` CHECK (`position` BETWEEN 0 AND 49),
	CONSTRAINT `rbac_assignment_scope_target` CHECK (`target` IN ('user', 'group', 'distributionList', 'contact')),
	CONSTRAINT `rbac_assignment_scope_match` CHECK (
		(`match_by` = 'id' AND `attr` = '' AND GUID(`value`) AND `target` <> 'user')
		OR (`match_by` = 'prefix' AND (`attr` IN ('displayName', 'mail') OR (`attr` = 'alias' AND `target` <> 'user')) AND length(CAST(`value` AS BLOB)) BETWEEN 1 AND 256 AND length(`value`) <= 64)
		OR (`match_by` = 'department' AND `attr` = '' AND length(CAST(`value` AS BLOB)) BETWEEN 1 AND 256 AND length(`value`) <= 64 AND `target` IN ('user', 'contact'))
	)
);
--> statement-breakpoint
CREATE TABLE `rbac_group_member_cache` (
	`user_oid` text NOT NULL,
	`group_id` text NOT NULL,
	`resolved_at` text NOT NULL,
	PRIMARY KEY(`user_oid`, `group_id`),
	CONSTRAINT `rbac_group_member_cache_ids` CHECK (GUID(`user_oid`) AND GUID(`group_id`)),
	CONSTRAINT `rbac_group_member_cache_time` CHECK (ISO(`resolved_at`))
);
--> statement-breakpoint
CREATE TABLE `rbac_epoch` (
	`id` integer PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `rbac_epoch_singleton` CHECK (`id` = 1),
	CONSTRAINT `rbac_epoch_value` CHECK (`epoch` >= 0)
);
--> statement-breakpoint
-- ===== hand-written section (not in schema.ts): seeds and triggers =====
INSERT INTO `rbac_epoch` (`id`, `epoch`) VALUES (1, 0);
--> statement-breakpoint
INSERT INTO `rbac_role` (`id`, `key`, `builtin`, `assignable`, `created_at`) VALUES
	(1, 'owner', 1, 1, '2026-01-01T00:00:00.000Z'),
	(2, 'admin', 1, 1, '2026-01-01T00:00:00.000Z'),
	(3, 'operator', 1, 1, '2026-01-01T00:00:00.000Z'),
	(4, 'helpdesk', 1, 1, '2026-01-01T00:00:00.000Z'),
	(5, 'reader', 1, 1, '2026-01-01T00:00:00.000Z');
--> statement-breakpoint
INSERT INTO `rbac_role_permission` (`role_id`, `permission`, `qualifier`) VALUES
	(1, 'users:read', ''), (1, 'groups:read', ''), (1, 'groups:members:write', ''), (1, 'distributionlists:read', ''), (1, 'distributionlists:members:write', ''), (1, 'distributionlists:export', ''), (1, 'contacts:read', ''), (1, 'contacts:create', ''), (1, 'contacts:update', ''), (1, 'contacts:delete', ''), (1, 'audit:read', ''), (1, 'audit:export', ''), (1, 'settings:branding', ''), (1, 'settings:connection', ''), (1, 'rbac:manage', ''),
	(2, 'users:read', ''), (2, 'groups:read', ''), (2, 'groups:members:write', ''), (2, 'distributionlists:read', ''), (2, 'distributionlists:members:write', ''), (2, 'distributionlists:export', ''), (2, 'contacts:read', ''), (2, 'contacts:create', ''), (2, 'contacts:update', ''), (2, 'contacts:delete', ''), (2, 'audit:read', ''), (2, 'audit:export', ''), (2, 'settings:branding', ''),
	(3, 'users:read', ''), (3, 'groups:read', ''), (3, 'groups:members:write', ''), (3, 'distributionlists:read', ''), (3, 'distributionlists:members:write', ''), (3, 'contacts:read', ''), (3, 'contacts:create', ''), (3, 'contacts:update', ''), (3, 'contacts:delete', ''),
	(4, 'users:read', ''), (4, 'groups:read', ''), (4, 'groups:members:write', ''), (4, 'distributionlists:read', ''), (4, 'distributionlists:members:write', ''), (4, 'contacts:read', ''),
	(5, 'users:read', ''), (5, 'groups:read', ''), (5, 'distributionlists:read', ''), (5, 'contacts:read', '');
--> statement-breakpoint
INSERT INTO `rbac_role_template` (`key`, `permissions`, `scope_target`) VALUES
	('board', '[{"permission":"contacts:create"},{"permission":"contacts:read"},{"permission":"distributionlists:read"},{"permission":"distributionlists:members:write"},{"permission":"users:read","qualifier":"basic"}]', 'distributionList');
--> statement-breakpoint
CREATE TRIGGER `rbac_role_builtin_no_update` BEFORE UPDATE ON `rbac_role` WHEN OLD.`builtin` = 1
BEGIN SELECT RAISE(ABORT, 'built-in roles are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `rbac_role_builtin_no_delete` BEFORE DELETE ON `rbac_role` WHEN OLD.`builtin` = 1
BEGIN SELECT RAISE(ABORT, 'built-in roles are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `rbac_role_builtin_no_insert_flag` BEFORE INSERT ON `rbac_role` WHEN NEW.`builtin` = 1 AND (SELECT count(*) FROM `rbac_role` WHERE `builtin` = 1) >= 5
BEGIN SELECT RAISE(ABORT, 'built-in roles are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `rbac_role_permission_builtin_no_insert` BEFORE INSERT ON `rbac_role_permission` WHEN (SELECT `builtin` FROM `rbac_role` WHERE `id` = NEW.`role_id`) = 1
BEGIN SELECT RAISE(ABORT, 'permissions of built-in roles are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `rbac_role_permission_builtin_no_update` BEFORE UPDATE ON `rbac_role_permission` WHEN (SELECT `builtin` FROM `rbac_role` WHERE `id` = OLD.`role_id`) = 1 OR (SELECT `builtin` FROM `rbac_role` WHERE `id` = NEW.`role_id`) = 1
BEGIN SELECT RAISE(ABORT, 'permissions of built-in roles are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `rbac_role_permission_builtin_no_delete` BEFORE DELETE ON `rbac_role_permission` WHEN (SELECT `builtin` FROM `rbac_role` WHERE `id` = OLD.`role_id`) = 1
BEGIN SELECT RAISE(ABORT, 'permissions of built-in roles are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `rbac_assignment_owner_no_expiry_ins` BEFORE INSERT ON `rbac_assignment` WHEN NEW.`expires_at` IS NOT NULL AND (SELECT `key` FROM `rbac_role` WHERE `id` = NEW.`role_id`) = 'owner'
BEGIN SELECT RAISE(ABORT, 'owner assignments cannot expire'); END;
--> statement-breakpoint
CREATE TRIGGER `rbac_assignment_owner_no_expiry_upd` BEFORE UPDATE ON `rbac_assignment` WHEN NEW.`expires_at` IS NOT NULL AND (SELECT `key` FROM `rbac_role` WHERE `id` = NEW.`role_id`) = 'owner'
BEGIN SELECT RAISE(ABORT, 'owner assignments cannot expire'); END;
--> statement-breakpoint
CREATE TRIGGER `rbac_assignment_last_owner_delete` BEFORE DELETE ON `rbac_assignment`
WHEN OLD.`principal_type` = 'user' AND (SELECT `key` FROM `rbac_role` WHERE `id` = OLD.`role_id`) = 'owner'
	AND NOT EXISTS (SELECT 1 FROM `rbac_assignment` a JOIN `rbac_role` r ON r.`id` = a.`role_id` WHERE r.`key` = 'owner' AND a.`principal_type` = 'user' AND a.`id` <> OLD.`id`)
BEGIN SELECT RAISE(ABORT, 'last_owner_protected'); END;
--> statement-breakpoint
CREATE TRIGGER `rbac_assignment_last_owner_update` BEFORE UPDATE ON `rbac_assignment`
WHEN OLD.`principal_type` = 'user' AND (SELECT `key` FROM `rbac_role` WHERE `id` = OLD.`role_id`) = 'owner'
	AND (NEW.`principal_type` <> 'user' OR NEW.`role_id` <> OLD.`role_id` OR NEW.`principal_id` <> OLD.`principal_id`)
	AND NOT EXISTS (SELECT 1 FROM `rbac_assignment` a JOIN `rbac_role` r ON r.`id` = a.`role_id` WHERE r.`key` = 'owner' AND a.`principal_type` = 'user' AND a.`id` <> OLD.`id`)
BEGIN SELECT RAISE(ABORT, 'last_owner_protected'); END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_role_ins` AFTER INSERT ON `rbac_role` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_role_upd` AFTER UPDATE ON `rbac_role` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_role_del` AFTER DELETE ON `rbac_role` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_role_permission_ins` AFTER INSERT ON `rbac_role_permission` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_role_permission_upd` AFTER UPDATE ON `rbac_role_permission` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_role_permission_del` AFTER DELETE ON `rbac_role_permission` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_assignment_ins` AFTER INSERT ON `rbac_assignment` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_assignment_upd` AFTER UPDATE ON `rbac_assignment` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_assignment_del` AFTER DELETE ON `rbac_assignment` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_assignment_scope_ins` AFTER INSERT ON `rbac_assignment_scope` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_assignment_scope_upd` AFTER UPDATE ON `rbac_assignment_scope` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_epoch_assignment_scope_del` AFTER DELETE ON `rbac_assignment_scope` BEGIN UPDATE `rbac_epoch` SET `epoch` = `epoch` + 1 WHERE `id` = 1; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_group_cache_assignment_ins` AFTER INSERT ON `rbac_assignment` WHEN NEW.`principal_type` = 'group'
BEGIN DELETE FROM `rbac_group_member_cache`; UPDATE `app_user` SET `groups_resolved_at` = NULL; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_group_cache_assignment_del` AFTER DELETE ON `rbac_assignment` WHEN OLD.`principal_type` = 'group'
BEGIN DELETE FROM `rbac_group_member_cache`; UPDATE `app_user` SET `groups_resolved_at` = NULL; END;
--> statement-breakpoint
CREATE TRIGGER `rbac_group_cache_assignment_upd` AFTER UPDATE OF `principal_type`, `principal_id` ON `rbac_assignment` WHEN OLD.`principal_type` = 'group' OR NEW.`principal_type` = 'group'
BEGIN DELETE FROM `rbac_group_member_cache`; UPDATE `app_user` SET `groups_resolved_at` = NULL; END;
--> statement-breakpoint
CREATE TRIGGER `tenant_connection_tenant_pinned` BEFORE UPDATE OF `tenant_id` ON `tenant_connection` WHEN OLD.`tenant_id` IS NOT NULL AND NEW.`tenant_id` IS NOT OLD.`tenant_id`
BEGIN SELECT RAISE(ABORT, 'tenant_id is pinned'); END;
--> statement-breakpoint
CREATE TRIGGER `tenant_connection_no_delete` BEFORE DELETE ON `tenant_connection` WHEN OLD.`tenant_id` IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'tenant_id is pinned'); END;
--> statement-breakpoint
CREATE TRIGGER `setup_state_transition` BEFORE UPDATE OF `state` ON `setup_state`
WHEN NEW.`state` <> OLD.`state` AND NOT (
	(OLD.`state` = 'unconfigured' AND NEW.`state` = 'in_progress')
	OR (OLD.`state` = 'in_progress' AND NEW.`state` = 'awaiting_first_signin')
	OR (OLD.`state` = 'awaiting_first_signin' AND NEW.`state` IN ('completed', 'in_progress'))
	OR (OLD.`state` = 'completed' AND NEW.`state` = 'in_progress'))
BEGIN SELECT RAISE(ABORT, 'setup state may only move forward'); END;
--> statement-breakpoint
CREATE TRIGGER `setup_state_no_delete` BEFORE DELETE ON `setup_state`
BEGIN SELECT RAISE(ABORT, 'setup_state is never deleted'); END;
```
<!-- migration-0001:end -->

## 6. Table notes

Writers are the only code that inserts or updates (repositories under `apps/server/src/{setup,connection,secrets,auth,rbac}`); every write that changes configuration or access commits together with its audit entry in one `BEGIN IMMEDIATE` transaction (I-B8). No transaction contains a network call.

| Table | Written by | Lifecycle, bounds and rules |
|---|---|---|
| `setup_state` | start-up `INSERT OR IGNORE` (state `unconfigured`, `install_id` = 16 random bytes as 32 hex); setup engine; `finish`; sign-in callback (completion); CLI `setup-reopen` | Never deleted. `designated_owner_oid` is set at `finish`. `proposed_tenant_id` is set by `connect` (the tenant of the bootstrap sign-in) or by `PUT /setup/manual` and copied to `tenant_connection.tenant_id` by verification V2. `completed_at` is non-null exactly when the state is `completed` (`CHECK`), so a reopen sets `state` and clears `completed_at` in one `UPDATE`. The edges are in section 8 |
| `setup_step` | runner, in the transaction that records the result of a sub-action | Key (`step`, `sub_action`); `detail` is a JSON object of at most 4,096 bytes written only through the step-detail schema (closed key list, no secret-looking key, FR-B-210). At start every `running` and `waiting` row returns to `pending`, and while the state is not `completed` so does every `connect` row of an automatic run (the bootstrap token lived in memory only, plan 6.1 step 7) |
| `setup_object` | runner, after a mutating Graph call returned, in the same transaction as the step row, the `tenant_connection` field and the audit entry `setup.object.change` | Kinds `application`, `service_principal`, `app_role_assignment`, `directory_role_assignment`; `origin` `created` or `adopted`. A crash between call and transaction is repaired by the next run finding the object and recording `adopt` (spec 6.9.6 rule 5). Rows are never deleted: they are the record of what the panel put in the tenant |
| `setup_log` | runner, in the transaction of the step row it describes | `seq` is `MAX(seq) + 1` assigned in the transaction (no `AUTOINCREMENT`); rows older than the newest 1,000 are deleted in the same transaction; `message_key` comes from `LOG_KEYS` (plan Appendix A), `params` are scalars validated by the secret-free schema (at most 1,024 bytes) |
| `runner_lease` | runner | Holder = run id; heartbeat every 15 s, expiry 120 s; a lease past expiry is taken over in the transaction that writes the new holder; released at the end of a run and at shutdown |
| `secret` | `CertificateService`, `rotate-app-key` | `blob` = version byte `0x01` (`CHECK`), 24-byte nonce, ciphertext with the 16-byte tag, so at least 41 bytes (`CHECK`); `key_id` names the `APP_KEY` that sealed it (16 hex); the associated data binds id, purpose and key id, so a blob moved to another row or purpose does not open (plan 7.2). Rotation re-seals in place under the same `id`. `retired_at` is set when its certificate retires; the row is deleted after the replacement is proven (plan 9.11 step 7) |
| `certificate` | `CertificateService`, renewal | `pending` -> `active` -> `retired`; at most one `active` and one `pending` (partial unique indexes); `thumbprint_sha1` unique (Entra shows SHA-1; the SHA-256 is what the assertion header carries); `public_der` 256 to 4,096 bytes; `not_before < not_after`. The sealed key is referenced by `secret_id` (RESTRICT) |
| `tenant_connection` | runner, repair, manual mode | One row, created by the first step that learns an id. `tenant_id` is pinned by V2 and then immutable and undeletable (trigger). `certificate_id` points at the active certificate (RESTRICT). `redirect_uris` is a JSON array of at most 1,024 bytes. `proof` is the verification list (plan 9.8), a JSON object of at most 51,200 bytes, replaced as a whole. `exchange_enabled` is 0 or 1; `permission_set_version` rises when the desired permission set changes and tells repair what to reconcile |
| `app_user` | sign-in callback (upsert in the sign-in transaction), revalidation | Labels (`upn_label`, `name_label`, at most 256 bytes each) are overwritten at every sign-in and are for display only; the key is `(tid, oid)`; `groups_resolved_at` is null after any group-assignment change (trigger) and tells the first request to refresh the memberships |
| `session` | sign-in, step-up, break-glass, sweeper | Primary key `id_hash` = SHA-256 of the cookie value as 64 lower-case hex; `kind` `user` (with a GUID `oid`) or `break_glass` (with `oid = ''`); no IP address and no user agent are stored; `amr` is a JSON array of at most 256 bytes; `groups_stale` is set when membership refresh failed. Hourly purge by `session_expiry_idx`; at most 10 per principal (oldest by `created_at` evicted at creation) |
| `rbac_role` | seeds; Phase D (custom roles) | `key` unique, 2 to 32 characters `[a-z][a-z0-9_]*`; `builtin = 1` rows are the five seeds and are immutable (triggers). Display names come from the message catalogue, never from the table |
| `rbac_role_permission` | seeds; Phase D | `permission` has the shape `[a-z:]{3,64}` and is validated against the shared registry by the writer; `qualifier` is `''` (full) or `basic`, and `basic` exists only for `users:read` (`CHECK`) |
| `rbac_role_template` | seeds | Read-only in Phase B (no write route): `permissions` is a JSON array of at most 2,048 bytes of `{permission, qualifier?}`; `scope_target` is the resource type the scope picker offers. Not assignable, so not an input to effective permissions and not covered by the epoch triggers |
| `rbac_assignment` | assignment service; first-Owner creation at `finish` (actor `setup`, source `wizard`); `restore-owner` (source `break_glass`) | `principal_id` is an Entra object id (user or group, lower-case GUID); `created_by` is the creating `oid`, or `setup` or `break_glass` (1 to 64 bytes); `expires_at` is null for every `owner` assignment (trigger) and at most 730 days ahead for others (service rule); unique on (`principal_type`, `principal_id`, `role_id`, `scope_hash`); at most 5,000 rows, 200 distinct bound groups and 100 roles (service limits, checked inside the write transaction) |
| `rbac_assignment_scope` | assignment service | Key (`assignment_id`, `position`) with `position` 0 to 49; values are normalised by `normalizeScopeItem` before insert (GUIDs lower-case, text NFC and trimmed, 1 to 64 code points); deleted with the assignment (CASCADE) |
| `rbac_group_member_cache` | membership refresh | Replaced per user in the transaction that sets `app_user.groups_resolved_at`; cleared wholesale when a group assignment is created, deleted or re-pointed (triggers). Losing the table loses nothing: the next request rebuilds it |
| `rbac_epoch` | triggers only | One row (`id = 1`, seeded `epoch = 0`); read on every authenticated request through the primary key; the application never writes it |

## 7. Seeds

The migration seeds data the policy layer must be able to trust without code: `rbac_epoch (1, 0)`, five built-in roles (ids 1 to 5, `created_at` the fixed instant `2026-01-01T00:00:00.000Z` so the seed is deterministic), their 47 permission rows (all with qualifier `''`) and one template. `BUILTIN_ROLES` and `TEMPLATES` in `packages/shared/src/rbac/roles.ts` are the typed source for code and for `docs/permissions.md`; start-up compares the rows with them (`rbac/builtin-check.ts`, mismatch exits with `builtin_roles_mismatch`) and `server/rbac/builtin-roles.test.ts` compares the freshly migrated database with them (negative control: one permission changed in the constant fails).

| Permission | owner | admin | operator | helpdesk | reader |
|---|---|---|---|---|---|
| `users:read` | x | x | x | x | x |
| `groups:read` | x | x | x | x | x |
| `groups:members:write` | x | x | x | x | |
| `distributionlists:read` | x | x | x | x | x |
| `distributionlists:members:write` | x | x | x | x | |
| `distributionlists:export` | x | x | | | |
| `contacts:read` | x | x | x | x | x |
| `contacts:create` | x | x | x | | |
| `contacts:update` | x | x | x | | |
| `contacts:delete` | x | x | x | | |
| `audit:read` | x | x | | | |
| `audit:export` | x | x | | | |
| `settings:branding` | x | x | | | |
| `settings:connection` | x | | | | |
| `rbac:manage` | x | | | | |
| **Rows** | **15** | **13** | **9** | **6** | **4** |

Template `board` (*Bestuur*, scope target `distributionList`): `contacts:create`, `contacts:read`, `distributionlists:read`, `distributionlists:members:write`, and `users:read` with qualifier `basic`. Its Dutch and English names come from the catalogue.

A later phase that must change a built-in role writes a migration that drops the immutability trigger, changes the rows and recreates the trigger, with an ADR; `BUILTIN_ROLES`, `docs/permissions.md` and the start-up comparison change in the same commit.

## 8. Triggers

All 29 are in the hand-written section. Each is exercised by at least one case of `server/migrations.phase-b.test.ts`, and the mutation test of section 13 drops them one at a time to prove it. Messages are stable strings; the application maps `last_owner_protected` to 409 and treats the others as defects (the route layer has refused the request earlier).

| Trigger (group) | Fires | Effect |
|---|---|---|
| `rbac_role_builtin_no_update`, `_no_delete` | before update or delete of a role with `builtin = 1` | abort `built-in roles are immutable` |
| `rbac_role_builtin_no_insert_flag` | before insert of a role with `builtin = 1` when five built-in roles exist | abort (no sixth built-in role) |
| `rbac_role_permission_builtin_no_insert`, `_no_update`, `_no_delete` | before change of a permission row of a built-in role (update also checks the target role) | abort `permissions of built-in roles are immutable` |
| `rbac_assignment_owner_no_expiry_ins`, `_upd` | before insert, or update, giving an `owner` assignment an `expires_at` | abort `owner assignments cannot expire` |
| `rbac_assignment_last_owner_delete` | before delete of a user-principal `owner` assignment when no other user-principal `owner` assignment exists | abort `last_owner_protected` |
| `rbac_assignment_last_owner_update` | before an update that would turn the last user-principal `owner` assignment into another role, another principal type or another principal id | abort `last_owner_protected` |
| `rbac_epoch_role_ins`, `_upd`, `_del` and the same three for `_role_permission`, `_assignment`, `_assignment_scope` (12) | after any insert, update or delete, including rows removed by `ON DELETE CASCADE` | `rbac_epoch.epoch = epoch + 1` in the same transaction |
| `rbac_group_cache_assignment_ins`, `_del`, `_upd` | after insert or delete of a group assignment, or an update of `principal_type` or `principal_id` involving a group | delete all `rbac_group_member_cache` rows and set every `app_user.groups_resolved_at` to null |
| `tenant_connection_tenant_pinned` | before an update that changes a non-null `tenant_id` (including to null) | abort `tenant_id is pinned` |
| `tenant_connection_no_delete` | before delete of a row whose `tenant_id` is set | abort `tenant_id is pinned` |
| `setup_state_transition` | before an update that changes `state` along any edge not in the list below | abort `setup state may only move forward` |
| `setup_state_no_delete` | before any delete | abort `setup_state is never deleted` |

Allowed `setup_state` edges: `unconfigured` -> `in_progress`; `in_progress` -> `awaiting_first_signin`; `awaiting_first_signin` -> `completed` or `in_progress`; `completed` -> `in_progress`. The HTTP routes can perform only the first three (plan 9.1); the last two exist for `setup-reopen --confirm`.

Notes that explain the design:

- **Last owner and concurrency.** The trigger runs inside the writer's transaction. SQLite has one writer, and the application starts every write with `BEGIN IMMEDIATE`, so two requests that each remove "the other" owner serialise and the second finds only itself (`server/rbac/last-owner.concurrency.test.ts`, two connections). Only user principals count: a group holding `owner` does not keep the panel reachable (probe case "group owner does not count"). An owner assignment of a user who was deleted in Entra still counts, because SQL cannot know; break-glass `restore-owner` is the recovery.
- **The epoch is the revocation channel.** Because the triggers live in the database, a change made by any path (repository, CLI, a hand-run SQL statement) invalidates every cached grant set at the next request. `rbac_role_template` has no trigger because it feeds no effective permission.
- **Group cache triggers clear everything**, not only one user's rows: group assignments change rarely and the rebuild costs `ceil(G / 20)` calls per active user, so the simple rule wins.
- **Not enforced in SQL, on purpose:** the row-count limits (5,000 assignments, 100 roles, 200 bound groups) and the 730-day expiry horizon are service rules checked in the write transaction, because a trigger would hide the reason code from the caller; `server/rbac/limits.test.ts` covers them.

## 9. Invariants

| ID | Invariant | Maintained by | Checked by |
|---|---|---|---|
| I-B1 | The built-in roles and their permissions equal `BUILTIN_ROLES` and cannot be changed | seeds; the six built-in triggers; start-up comparison | `server/rbac/builtin-roles.test.ts`, `server/migrations.upgrade.test.ts`, `server/migrations.phase-b.test.ts` |
| I-B2 | At least one user-principal `owner` assignment exists once the first Owner was created | `rbac_assignment_last_owner_*` triggers; service pre-check for a clear reason | `server/rbac/last-owner.test.ts`, `server/rbac/last-owner.concurrency.test.ts` |
| I-B3 | Every change to roles, role permissions, assignments or scopes bumps `rbac_epoch` in the same transaction | 12 epoch triggers | `server/rbac/epoch.test.ts`, `server/migrations.phase-b.test.ts` |
| I-B4 | No table holds a plaintext secret, token or password; `session.id_hash` is a hash; `secret.blob` is sealed | `CHECK` on the blob shape; sealed-box code; secret-free detail schemas | `server/secrets/no-plaintext.test.ts`, `server/auth/session-store.test.ts`, `server/auth/no-token-retained.test.ts` |
| I-B5 | `setup_state.state` moves only along the edges of section 8, and only the CLI moves it backwards | `setup_state_transition` trigger; the state machine | `server/setup/state-machine.test.ts`, `server/migrations.phase-b.test.ts` |
| I-B6 | At most one `active` certificate, and at most one `pending` one | partial unique indexes `certificate_one_active`, `certificate_one_pending` | `server/connection/repair.test.ts`, `server/migrations.upgrade.test.ts`, `server/migrations.phase-b.test.ts` |
| I-B7 | The pinned tenant never changes and its row is never deleted | `tenant_connection_*` triggers | `server/setup/tenant-pin.test.ts` |
| I-B8 | A change and its audit entry commit together or not at all | one `BEGIN IMMEDIATE` transaction per change | `server/setup/audit-setup.test.ts`, `server/rbac/audit-rbac.test.ts` |
| I-B9 | JSON `detail`, `params` and `proof` columns are written only through schemas that reject secret-looking keys | writer schemas; `JSONOBJ` size caps | `server/setup/step-model.test.ts`, `server/setup/log.test.ts` |
| I-B10 | A group-assignment change leaves no stale membership: the cache is empty and every `groups_resolved_at` is null | `rbac_group_cache_assignment_*` triggers | `server/rbac/membership.test.ts`, `server/migrations.phase-b.test.ts` |
| I-B11 | No `owner` assignment has an expiry | `rbac_assignment_owner_no_expiry_*` triggers; service rule | `server/rbac/last-owner.test.ts`, `server/migrations.phase-b.test.ts` |
| I-B12 | A session of kind `break_glass` has an empty `oid`; a session of kind `user` has a GUID `oid`; both have a GUID `tid` | `session_principal` `CHECK` | `server/auth/session-store.test.ts`, `server/migrations.phase-b.test.ts` |

I-B1 to I-B9 are those of spec Appendix B; I-B10 to I-B12 are added here (SB-15) and go into the spec at its next edit. **Note on I-B6.** The spec says "at most one active certificate". Renewal needs a second, not yet active certificate to exist while the old one still signs (PB-13), so the schema allows one `active` plus one `pending`; the pending one never signs anything until verification proves possession, and the swap (retire, activate, repoint `tenant_connection.certificate_id`) is one transaction. A third row can exist for the length of that transaction (`retired`, pending deletion).

## 10. Audit log: vocabulary and detail allow-list

`audit_log` is unchanged (Phase A section 4.3 and 7). Phase B adds values to columns that deliberately have no `CHECK` (`actor_kind`, `action`, `reason_code`, `target_type`), writes them through the same writer, and extends its Zod enums.

**Actor kinds.** `anonymous`, `user` (`actor_id` = `oid`), `setup` (`setup`), `break_glass` (`break_glass`; the username never appears), `system` (`system`), `cli` (`cli`); `preview` is no longer written but stays readable (old rows) and stays in the read enum (DM-05). `outcome` keeps the Phase A set (`success`, `denied`, `rejected`, `error`); a step that ends in warning is `success` with detail `status` `warning`.

**Denials.** A denied write, or a denied permissioned read of an authenticated actor, is recorded with `action` = the route id (contracts file), `outcome` `denied` and `reason_code` one of `permission_missing`, `scope_mismatch`, `step_up_required`, `escalation_denied`, `last_owner_protected`; `origin_not_allowed` and `csrf_invalid` are unchanged; Phase A rows keep `permission_denied`. A denial of an anonymous visitor is a 401 and is not audited.

| Action | Target (type / id) | Outcomes | Actor kinds | Detail keys |
|---|---|---|---|---|
| `setup.unlock` | `setup` / empty | `success`; `denied` when a lock starts | `setup`; `anonymous` | `reason`, `lockScope` |
| `setup.step.run` | `setup_step` / step key | `success`, `error`, `denied` | `setup` or `user` | `step`, `subAction`, `status`, `attempt`, `codes`, `mode` |
| `setup.object.change` | `setup_object` / object kind | `success`, `error` | `setup` or `user` | `kind`, `op`, `objectId` (GUID ids only, SB-11), `appId`, `name`, `confirmed` |
| `setup.tenant.pin` | `tenant` / `tid` | `success`, `rejected` | `setup` | `tid`, `mode` |
| `setup.complete` | `setup` / empty | `success` | `user` | `mode` |
| `setup.reopen` | `setup` / empty | `success` | `cli` | `fromState` |
| `connection.repair` | `setup_step` / sub-action key | `success`, `error`, `denied` | `user` | `subAction`, `drift`, `status`, `codes` |
| `connection.verify` | `connection` / empty | `success`, `error`, `denied` | `user` | `checks`, `codes` |
| `secrets.certificate.create` | `certificate` / SHA-1 thumbprint | `success` | `setup` or `user` | `thumbprintSha1`, `notAfter` |
| `secrets.app_key.rotate` | `secret` / empty | `success`, `error` | `cli` | `rows`, `fromKeyId`, `toKeyId` |
| `auth.signin` | `app_user` / `oid` | `success`, `denied` | `user`; `anonymous` before the token validated | `reason`, `check`, `mfa`, `groupsResolved`, `purpose` |
| `auth.stepup` | `app_user` / `oid` | `success`, `denied` | `user` | `reason`, `check`, `mfa` |
| `auth.signout` | `session` / empty | `success` | `user`, `break_glass` | `scope`, `sessions` |
| `auth.session.revoked` | `app_user` / `oid` | `success` | `system` | `reason`, `sessions` |
| `breakglass.signin` | `break_glass` / empty | `success`, `denied` | `break_glass`; `anonymous` | `reason` |
| `breakglass.signout` | `break_glass` / empty | `success` | `break_glass` | `reason` |
| `rbac.assignment.create` | `rbac_assignment` / id | `success`, `denied` | `user`, `setup` (SB-21: the first-Owner and Beheerder assignments written at `finish`) | `principalType`, `principalId`, `role`, `scopeTargets`, `scopeItems`, `expiresAt`, `source` |
| `rbac.assignment.delete` | `rbac_assignment` / id | `success`, `denied` | `user` | `principalType`, `principalId`, `role`, `reason` |
| `rbac.owner.restore` | `app_user` / `oid` | `success`, `denied` | `break_glass` | `assignmentId`, `graphChecked` |

That is 19 actions. Each is declared once in `apps/server/src/audit/vocabulary.ts`; `server/audit-b-coverage.test.ts` iterates the route table and this list and fails when a route declares an action that is not here, or an action here has no route or code path (`setup.reopen` and `secrets.app_key.rotate` are CLI paths, `auth.session.revoked` is the revalidation path, `setup.tenant.pin` is verification V2).

**Detail allow-list** (`audit/allowlist.ts`). The writer accepts the 37 keys below, the Phase A keys (`permission`, `method`, the route template) and nothing else; an unknown key, a wrong value type or a key whose name matches `secret`, `token`, `key`, `password`, `assertion`, `pem` or `credential` (case-insensitive) is rejected, and the audit append fails the surrounding transaction. `fromKeyId` and `toKeyId` are key **ids** (FR-B-104) and are on the list by exact name.

| Value rule | Keys |
|---|---|
| GUID, lower case | `objectId`, `appId`, `tid`, `principalId`, `assignmentId` |
| 40 lower-case hex | `thumbprintSha1` |
| 16 lower-case hex (key id) | `fromKeyId`, `toKeyId` |
| UTC instant with milliseconds | `notAfter`, `expiresAt` |
| integer | `attempt`, `rows`, `sessions`, `scopeItems` |
| boolean | `confirmed`, `mfa`, `groupsResolved`, `graphChecked` |
| array of at most 16 strings of at most 64 bytes (DM-02) | `codes`, `drift`, `checks`, `scopeTargets` |
| value from a shared registry (enumeration) | `step`, `subAction`, `status`, `mode`, `kind`, `op`, `reason`, `check`, `purpose`, `scope`, `lockScope`, `fromState`, `source`, `principalType`, `role` |
| string of at most 256 bytes, NFC, no control characters | `name` |

Rules: the break-glass username, UPN, display name, client secrets, authorization codes, `state` and tokens never appear (`server/no-leak.test.ts` canaries over a full fake-tenant run); `detail` stays at most 4,096 bytes (Phase A); a tenant-changing call is audited in the same transaction as its `setup_object` row after the call returned. The coverage and fault-injection controls are `server/audit-b-coverage.test.ts`, `server/setup/audit-setup.test.ts`, `server/rbac/audit-rbac.test.ts` and `server/audit-integration.test.ts`.

## 11. State that is deliberately not in the database

| Item | Where it lives | What a restart does |
|---|---|---|
| Setup sessions (256-bit ids, idle 60 min, absolute 8 h, at most 5), unlock failure counters, lock timers | process memory | Locks are forgotten (an operator can retry sooner than 15 minutes after a restart; accepted, the token is the control); the operator unlocks again |
| Bootstrap object (device-code client, its tokens, device and user code) | process memory, discarded by FR-B-215 | The operator repeats the device sign-in; step rows return to `pending` |
| Run context (role ids, service principal ids, desired state), cancel flag | process memory | A new run reads the tenant again (idempotent) |
| Login transactions (`state`, `nonce`, PKCE verifier, return target; at most 600 s) | process memory | A sign-in in flight fails with `cookies_missing_or_expired`; the user starts again |
| Last-seen memo of sessions | process memory, written to `session.last_seen_at` at most every 60 s | Idle window can be up to 60 s longer after a restart |
| Grants memo (LRU 1,000), single-flight refresh maps, Graph response cache (LRU 1,000), JWKS cache | process memory | Rebuilt on demand from the database and Microsoft |
| Rate-limit buckets, break-glass failure counters and queue | process memory | Reset (documented; the break-glass hash makes guessing offline-expensive regardless) |
| Application and Exchange access tokens | MSAL in-memory cache | Re-acquired with the certificate assertion |
| `APP_KEY`, `APP_KEY_PREVIOUS`, `SETUP_TOKEN`, `BREAK_GLASS_PASSWORD_HASH` | environment or Docker secrets | Read again at start; see section 14 for loss |
| Certificate private key in clear | only inside the `CertificateHolder` closure as a `KeyObject` | Opened again from `secret` at start |

## 12. Migration, snapshot, upgrade test and parity

### 12.1 Files and policy (Phase A section 8 applies in full)

- `apps/server/drizzle/0001_phase_b.sql` and the journal entry (tag `0001_phase_b`, `when` strictly greater than that of `0000_init`), plus drizzle-kit's own `meta/0001_snapshot.json`. Forward-only, immutable once merged, checksum-guarded by the Phase A wrapper.
- `apps/server/schema-snapshots/0001-phase-b.sql`: the DDL of a database produced by applying `0000` and `0001` to an empty database, taken from `sqlite_master` (tables, indexes, triggers, each sorted by name; `__drizzle_migrations` and `sqlite_%` excluded), with the Phase A header (`-- schema-version: 1`, `-- last-migration: 0001_phase_b`). It is committed in the same commit as the migration (baseline section 2; SB-23). `apps/server/schema-snapshots/migrations.json` gains the entry (tag, SHA-256, schema version 1). `pnpm schema:snapshot` regenerates both; `pnpm schema:check` is the CI step "Schema snapshot check"; "Schema drift check" runs `drizzle-kit generate` into a clean copy and fails on any new file.
- The seed instants and rows are part of the snapshot only through the triggers and tables; seeds themselves are checked by `server/rbac/builtin-roles.test.ts`.
- The wrapper takes `backups/pre-migrate-0000-0001.sqlite` before applying `0001` to any database that already has applied migrations (every Phase A install). The first install on an empty database takes none.

### 12.2 Upgrade test (FR-B-701; `server/migrations.upgrade.test.ts`)

1. Build a database from the committed Phase A snapshot (`0000-init.sql`) and insert the `__drizzle_migrations` row for `0000`.
2. Seed it: the `branding` row with every asset it references (`branding_asset` rows and files), one staged asset (`unreferenced_at` set), and an audit chain of at least 6 entries including `actor_kind = 'preview'` rows and a denial with reason `permission_denied`.
3. Run the **real** start-up wrapper (not the stock migrator).
4. Compare tables, columns (name, type, not-null, default, primary key), indexes, foreign keys and trigger SQL with a database built from snapshot 1.
5. Assert `PRAGMA foreign_key_check` is empty; the `branding` row and its assets are intact and the files still hash to their names; `verifyChain` passes on the old chain (the `preview` rows included) and an appended Phase B entry (`setup.unlock`) extends it; `sqlite_master` text of the Phase A objects is byte-identical; `backups/pre-migrate-0000-0001.sqlite` exists and opens; the built-in roles equal `BUILTIN_ROLES`; `rbac_epoch` is `(1, 0)`; the 29 triggers exist; a second start applies nothing.
6. The synthetic drifting pair of Phase A (a fixture migration whose SQL default differs from its snapshot) stays and must still fail: a guard nobody has seen fail is an assumption with a green tick.

### 12.3 Behaviour test of the migration (`server/migrations.phase-b.test.ts`)

Ports the 59 assertions of section 13 and adds the table-driven trigger cases and the single-trigger mutation test (drop each of the 29 triggers in turn; at least one case must fail). A new trigger without a case fails the completeness check (the test lists `sqlite_master` triggers and requires every name to appear in the case table).

### 12.4 Parity test (FR-B-702; `server/schema-parity.test.ts`, extended)

Builds database A from the TypeScript schema (`drizzle-kit export`) and database B from the migrations and compares tables, columns, types, not-null flags, defaults, indexes and foreign keys, ignoring triggers and seeds. Phase B additions: partial indexes are compared by their `WHERE` text, and `CHECK` clauses by their normalised text (so a macro edited in `check-macros.ts` but not regenerated, or a hand-edited migration, shows). Negative control (kept from Phase A): a fixture migration whose default differs from the schema's `.default()`; Phase B adds a second one whose `CHECK` constant differs.

### 12.5 Document agreement (`server/migrations.doc.test.ts`)

Section 5 against the committed migration, as described there. Without it this document would be a second source that can drift; with it the document is a review aid that CI keeps honest.

## 13. Evidence

Executed on 2026-10-10 in the planning environment: Node 22.22.0, `better-sqlite3` 13.0.3 (SQLite 3.53.4), `foreign_keys = ON`. The macro notation of section 5 was expanded by a 10-line script (the model of `expandCheckMacros`) and the result executed statement by statement. Probe code lived in the session scratchpad and is not repository code; its assertions are the specification of `server/migrations.phase-b.test.ts`.

| Result | Value |
|---|---|
| Objects created | 17 tables, 9 indexes, 29 triggers; `PRAGMA foreign_key_check` empty |
| Statement kinds | 17 `CREATE TABLE`, 4 + 5 `CREATE INDEX`/`CREATE UNIQUE INDEX`, 29 `CREATE TRIGGER`, 4 `INSERT INTO`; no other kind; no reference to a Phase A table |
| Assertions | **59 pass, 0 fail** |
| Trigger cases | 40 table-driven cases pass on the intact schema |
| Mutation | 29 mutants (each trigger dropped alone): **29 killed, 0 survivors** |

The 59 assertions by area: seeds (matrix counts 15/13/9/6/4, template with 5 permissions, epoch seeded) 3; built-in immutability (update and delete role, insert, update and delete permission, sixth built-in, aborted statements leave the epoch unchanged) 7; custom roles and epoch (insert, permission insert/update/delete, qualifier only on `users:read`) 3; assignments and last owner (duplicate, owner with expiry, delete, demote, convert to group, group owner does not count, one owner remains, delete the remaining one) 8; scope rows (epoch bumps on insert, `by id` on `user`, `department` on `group`, `prefix` with a bad attribute, `alias` on `user`, position 50, cascade delete, epoch bumps on cascade) 8; group cache (insert clears, `groups_resolved_at` reset, user assignment keeps the cache, delete clears) 4; sessions (break-glass with `oid`, user without `oid`, upper-case hash) 3; `setup_state` (second row, unconfigured to completed, unconfigured to awaiting, in progress to completed, completed to unconfigured, reopen allowed, completed without `completed_at`, delete) 8; tenant pin (change, clear, delete) 3; secrets and certificates (version byte, text blob, second pending, second active, swap active, secret referenced by a certificate, upper-case thumbprint) 7; logs, steps, objects (array in `params`, oversize `params`, bad step status, oversize `detail`, bad origin) 5. Total 59.

One probe finding changed the SQL and is recorded because it shows why the probe exists: the first draft of the scope `CHECK` accepted `alias` as a `prefix` attribute on a `user` target (a user has no alias, plan 11.3); the assertion "alias on user" failed, the `CHECK` was tightened to the form in section 5 and all assertions were re-run.

**What this evidence does not cover** (and which control does): the drizzle-kit output of the generated section (section 12.4 parity test and 12.5 document test), the real wrapper and backup behaviour (12.2), the concurrent last-owner race (`server/rbac/last-owner.concurrency.test.ts`), and anything involving Microsoft (the owner-verified ledger OV-01 to OV-23 of the spec).

## 14. Backup, restore, retention and classification

- **Backup.** Phase A rule: stop the container and copy all of `/data` including `-wal` and `-shm`. **Also keep `APP_KEY` (and the Compose secret file) in a place that is not the backup of `/data`.** Both are needed to restore.
- **Restore.** Copy `/data` back with ownership uid 65532 while the container is stopped, set the same `APP_KEY`, start. The start-up wrapper applies any pending migration (with its own pre-migrate copy).
- **Lost `APP_KEY`.** The database starts; `/readyz` reports the check `secrets` as `app_key_missing` (or `app_key_invalid`, `certificate_unreadable`); sign-in answers 503 `secrets_unavailable` with an explanation on `/signin`, and break-glass and the Settings pages that need no Graph still work (plan 6.5); the repair wizard with an administrator creates a new certificate and seals it under a new key. There is no backdoor (RB-07).
- **Wrong `APP_KEY` after a rotation.** `rotate-app-key` is idempotent and refuses to proceed when a row opens under neither key (nothing changes). Keep the pre-rotate copy until the new key is verified in service.
- **Retention.** `audit_log`: indefinite until Phase D defines retention (OD-10). `session`: expired rows purged hourly. `setup_log`: newest 1,000. `rbac_group_member_cache`: rebuilt within `GROUP_CACHE_TTL_SECONDS`. `app_user`: kept indefinitely (DM-03). Backups: newest 3 `pre-migrate-*` and newest 3 `pre-rotate-*`.
- **Classification.**

| Data | Class | Where |
|---|---|---|
| Sealed certificate key | Secret (encrypted at rest; key outside `/data`) | `secret.blob` |
| Session id hash | Credential-derived (not reversible, useless without the cookie value) | `session.id_hash` |
| `oid`, `tid`, group ids | Personal data (identifiers of people and groups in the tenant) | `app_user`, `session`, `rbac_*`, `audit_log.actor_id/target_id` |
| UPN and display-name labels | Personal data | `app_user.upn_label`, `.name_label` |
| Client IP | Personal data, audit table only (Phase A) | `audit_log.client_ip` |
| Tenant, application and service principal ids, thumbprints, redirect URIs, proof list | Configuration, not secret | `tenant_connection`, `setup_object`, `certificate` |
| Public certificate | Public | `certificate.public_der` |
| Wizard log | Configuration, secret-free by schema | `setup_log`, `setup_step.detail` |

  Logs never carry any of these (FR-B-715); the database and its backups are personal-data stores and are protected as such (`docs/security.md`).

## 15. What Phases C and D add

| Phase | Additive change | Why Phase B already allows it |
|---|---|---|
| C | Cache tables for Graph data, if any; nothing in RBAC | New tables only; scope columns and `PERMISSION_RESOURCE` already name `user` and `group` targets |
| D | `rbac_role` and `rbac_role_permission` rows for custom roles (`builtin = 0`); an editor for assignments and scopes; templates become assignable through a service, not a table change; audit filter indexes on `ts`, `actor_id`, `action`, `outcome`; retention job; `addKey` certificate self-rotation uses the existing `pending` state; Exchange worker credentials, if any, reuse `secret` with a new `purpose` | Roles and permissions are rows validated by the registry, the epoch triggers cover custom roles already, `secret.purpose` is a shape check, indexes are additive migrations, and no `CHECK` lists audit values |

## 16. Decisions taken in this document

| ID | Decision | Revisit when |
|---|---|---|
| DM-01 | `rotate-app-key` keeps the newest 3 `pre-rotate-*` copies, counted apart from `pre-migrate-*` | An operator reports disk pressure |
| DM-02 | Audit detail arrays hold at most 16 strings of at most 64 bytes | A Phase C or D action needs more |
| DM-03 | `app_user` rows are kept indefinitely; labels are overwritten at each sign-in; the audit log carries `oid` only. Phase B ships no erase tool; `docs/security.md` says so and names it as input to OD-10 | Phase D retention |
| DM-04 | No `CHECK` on `setup_step.step`, `.sub_action`, `setup_object.kind`, `setup_log.step`, `.message_key` (registries move with the wizard) | Never; this is FR-B-702 |
| DM-05 | `preview` stays in the read enum of `actor_kind` forever; it is never written after Phase B | Never |
| DM-06 | Every trigger needs a case in `server/migrations.phase-b.test.ts`, proven by the mutation test | Never |
| DM-07 | This document's SQL is compared with the committed migration by `server/migrations.doc.test.ts` | If the specs directory is archived, the test moves with it |
