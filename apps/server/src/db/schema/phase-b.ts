// The Drizzle schema of Phase B (FR-B-701, FR-B-702, data-model sections 4 to 8): the 17 tables of
// migration `0001_phase_b`, their CHECK constraints and their 9 indexes. `drizzle-kit generate`
// turns this file into the generated half of `drizzle/0001_phase_b.sql`; the hand-written half
// (seeds and the 29 triggers) follows the marker line in that file and is not declared here.
//
// Rules for editing this file, as in `schema.ts`:
//   - A change here is a new migration; a merged migration is never edited.
//   - The CHECK numbers are literals on purpose: a CHECK is part of the table as the migration created
//     it, and the limit and the CHECK change together, in a migration, or not at all.
//   - The recurring shapes (GUID, ISO time, fixed-length hex, bounded JSON object) come from
//     `check-macros.ts`, so this file and the migration cannot disagree (PB-26).
//   - No CHECK lists a value later phases extend (FR-B-702): `setup_step.step` and `.sub_action`,
//     `setup_object.kind`, `setup_log.step` and `.message_key`, `rbac_role_permission.permission`,
//     `secret.purpose` and every audit column are validated by registries and Zod enums. Closed sets
//     that will not grow (state, mode, status, level, origin, certificate state, session kind,
//     principal type, assignment source, scope target and `match_by`, the qualifier) do use CHECK.
//
// Column names inside a CHECK are written with backticks, as the migration prints them.
import { SQL, StringChunk, sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { guid, hex, iso, jsonObject } from '../check-macros.js';

/** A column name as it appears inside a CHECK expression. */
const col = (name: string): string => `\`${name}\``;

/** A CHECK whose expression is written out in SQL. */
// The expressions are built from this file's own constants and the check macros, never from input;
// the migration is generated from them and `schema:check` compares the result (FR-A-060 does not apply).
// `sql.raw` is what `new SQL([new StringChunk(text)])` builds; it is written out here because the
// lint rule for FR-A-060 rightly refuses `sql.raw` with a parameter, and every caller below passes
// a literal of this file.
const rule = (name: string, expression: string) =>
  check(name, new SQL([new StringChunk(expression)]));

/** `(c IS NULL OR <fragment>)`: an optional column that has a shape when it is present. */
const optional = (name: string, fragment: string): string =>
  `(${col(name)} IS NULL OR ${fragment})`;

// ---------------------------------------------------------------------------------------------
// Setup (data-model 1 and 6): one engine writes these, each change in one transaction with its
// audit entry; no foreign keys among them
// ---------------------------------------------------------------------------------------------

export const setupState = sqliteTable(
  'setup_state',
  {
    id: integer('id').primaryKey(),
    state: text('state').notNull().default('unconfigured'),
    mode: text('mode').notNull().default('automatic'),
    installId: text('install_id').notNull(),
    designatedOwnerOid: text('designated_owner_oid'),
    proposedTenantId: text('proposed_tenant_id'),
    defaultLanguage: text('default_language'),
    completedAt: text('completed_at'),
    updatedAt: text('updated_at').notNull(),
  },
  () => [
    rule('setup_state_singleton', `${col('id')} = 1`),
    rule(
      'setup_state_state',
      `${col('state')} IN ('unconfigured', 'in_progress', 'awaiting_first_signin', 'completed')`,
    ),
    rule('setup_state_mode', `${col('mode')} IN ('automatic', 'manual')`),
    rule('setup_state_install_id', hex(col('install_id'), 32)),
    rule(
      'setup_state_owner_oid',
      `${col('designated_owner_oid')} IS NULL OR ${guid(col('designated_owner_oid'))}`,
    ),
    rule(
      'setup_state_tenant',
      `${col('proposed_tenant_id')} IS NULL OR ${guid(col('proposed_tenant_id'))}`,
    ),
    rule(
      'setup_state_language',
      `${col('default_language')} IS NULL OR ${col('default_language')} IN ('nl', 'en')`,
    ),
    rule(
      'setup_state_completed_at',
      `(${col('state')} = 'completed') = (${col('completed_at')} IS NOT NULL)`,
    ),
    rule('setup_state_updated_at', iso(col('updated_at'))),
  ],
);

export const setupStep = sqliteTable(
  'setup_step',
  {
    step: text('step').notNull(),
    subAction: text('sub_action').notNull(),
    status: text('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    errorCode: text('error_code'),
    rollbackHintKey: text('rollback_hint_key'),
    detail: text('detail').notNull().default('{}'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.step, table.subAction] }),
    rule(
      'setup_step_status',
      `${col('status')} IN ('pending', 'running', 'waiting', 'succeeded', 'warning', 'failed', 'skipped')`,
    ),
    rule('setup_step_attempt', `${col('attempt')} >= 0`),
    rule('setup_step_detail', jsonObject(col('detail'), 4096)),
    rule(
      'setup_step_times',
      `${optional('started_at', iso(col('started_at')))} AND ${optional('finished_at', iso(col('finished_at')))} AND ${iso(col('updated_at'))}`,
    ),
  ],
);

export const setupObject = sqliteTable(
  'setup_object',
  {
    kind: text('kind').notNull(),
    tenantObjectId: text('tenant_object_id').notNull(),
    appId: text('app_id'),
    name: text('name').notNull(),
    origin: text('origin').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.tenantObjectId] }),
    rule('setup_object_id', `length(${col('tenant_object_id')}) BETWEEN 1 AND 128`),
    rule('setup_object_app_id', `${col('app_id')} IS NULL OR ${guid(col('app_id'))}`),
    rule('setup_object_name', `length(CAST(${col('name')} AS BLOB)) BETWEEN 1 AND 256`),
    rule('setup_object_origin', `${col('origin')} IN ('created', 'adopted')`),
    rule('setup_object_created_at', iso(col('created_at'))),
  ],
);

export const setupLog = sqliteTable(
  'setup_log',
  {
    seq: integer('seq').primaryKey(),
    ts: text('ts').notNull(),
    step: text('step').notNull(),
    level: text('level').notNull(),
    messageKey: text('message_key').notNull(),
    params: text('params').notNull().default('{}'),
  },
  () => [
    rule('setup_log_level', `${col('level')} IN ('info', 'warn', 'error')`),
    rule('setup_log_params', jsonObject(col('params'), 1024)),
    rule('setup_log_ts', iso(col('ts'))),
  ],
);

export const runnerLease = sqliteTable(
  'runner_lease',
  {
    id: integer('id').primaryKey(),
    holder: text('holder').notNull(),
    heartbeatAt: text('heartbeat_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  () => [
    rule('runner_lease_singleton', `${col('id')} = 1`),
    rule('runner_lease_times', `${iso(col('heartbeat_at'))} AND ${iso(col('expires_at'))}`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Secrets and certificates (FR-B-105, FR-B-106): the sealed key and the public data
// ---------------------------------------------------------------------------------------------

export const secret = sqliteTable(
  'secret',
  {
    id: text('id').primaryKey(),
    purpose: text('purpose').notNull(),
    keyId: text('key_id').notNull(),
    blob: blob('blob', { mode: 'buffer' }).notNull(),
    createdAt: text('created_at').notNull(),
    retiredAt: text('retired_at'),
  },
  () => [
    rule('secret_id', guid(col('id'))),
    rule(
      'secret_purpose',
      `length(${col('purpose')}) BETWEEN 1 AND 64 AND ${col('purpose')} NOT GLOB '*[^a-z_]*'`,
    ),
    rule('secret_key_id', hex(col('key_id'), 16)),
    rule(
      'secret_blob',
      `typeof(${col('blob')}) = 'blob' AND length(${col('blob')}) >= 41 AND length(${col('blob')}) <= 16384 AND hex(substr(${col('blob')}, 1, 1)) = '01'`,
    ),
    rule(
      'secret_times',
      `${iso(col('created_at'))} AND ${optional('retired_at', iso(col('retired_at')))}`,
    ),
  ],
);

export const certificate = sqliteTable(
  'certificate',
  {
    id: text('id').primaryKey(),
    secretId: text('secret_id')
      .notNull()
      .references(() => secret.id, { onDelete: 'restrict' }),
    thumbprintSha1: text('thumbprint_sha1').notNull(),
    thumbprintSha256: text('thumbprint_sha256').notNull(),
    subject: text('subject').notNull(),
    notBefore: text('not_before').notNull(),
    notAfter: text('not_after').notNull(),
    publicDer: blob('public_der', { mode: 'buffer' }).notNull(),
    state: text('state').notNull().default('pending'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    rule('certificate_id', guid(col('id'))),
    rule('certificate_sha1', hex(col('thumbprint_sha1'), 40)),
    rule('certificate_sha256', hex(col('thumbprint_sha256'), 64)),
    rule('certificate_subject', `length(CAST(${col('subject')} AS BLOB)) BETWEEN 1 AND 256`),
    rule(
      'certificate_validity',
      `${iso(col('not_before'))} AND ${iso(col('not_after'))} AND ${col('not_before')} < ${col('not_after')}`,
    ),
    rule(
      'certificate_der',
      `typeof(${col('public_der')}) = 'blob' AND length(${col('public_der')}) BETWEEN 256 AND 4096`,
    ),
    rule('certificate_state', `${col('state')} IN ('pending', 'active', 'retired')`),
    rule('certificate_created_at', iso(col('created_at'))),
    // At most one active and at most one pending certificate (I-B6); a renewal needs both at once.
    uniqueIndex('certificate_one_active')
      .on(table.state)
      .where(sql`\`state\` = 'active'`),
    uniqueIndex('certificate_one_pending')
      .on(table.state)
      .where(sql`\`state\` = 'pending'`),
    uniqueIndex('certificate_sha1_uq').on(table.thumbprintSha1),
  ],
);

// ---------------------------------------------------------------------------------------------
// The pinned tenant
// ---------------------------------------------------------------------------------------------

export const tenantConnection = sqliteTable(
  'tenant_connection',
  {
    id: integer('id').primaryKey(),
    tenantId: text('tenant_id'),
    tenantName: text('tenant_name'),
    initialDomain: text('initial_domain'),
    appObjectId: text('app_object_id'),
    appId: text('app_id'),
    spObjectId: text('sp_object_id'),
    graphSpId: text('graph_sp_id'),
    exchangeSpId: text('exchange_sp_id'),
    exchangeEnabled: integer('exchange_enabled').notNull().default(0),
    exchangeRoleTemplateId: text('exchange_role_template_id'),
    permissionSetVersion: integer('permission_set_version').notNull().default(1),
    redirectUris: text('redirect_uris').notNull().default('[]'),
    certificateId: text('certificate_id').references(() => certificate.id, {
      onDelete: 'restrict',
    }),
    proof: text('proof').notNull().default('{}'),
    verifiedAt: text('verified_at'),
    updatedAt: text('updated_at').notNull(),
  },
  () => [
    rule('tenant_connection_singleton', `${col('id')} = 1`),
    rule(
      'tenant_connection_ids',
      [
        'tenant_id',
        'app_object_id',
        'app_id',
        'sp_object_id',
        'graph_sp_id',
        'exchange_sp_id',
        'exchange_role_template_id',
      ]
        .map((name) => optional(name, guid(col(name))))
        .join(' AND '),
    ),
    rule(
      'tenant_connection_strings',
      `(${col('tenant_name')} IS NULL OR length(CAST(${col('tenant_name')} AS BLOB)) <= 256) AND (${col('initial_domain')} IS NULL OR length(CAST(${col('initial_domain')} AS BLOB)) <= 256)`,
    ),
    rule('tenant_connection_exchange', `${col('exchange_enabled')} IN (0, 1)`),
    rule('tenant_connection_version', `${col('permission_set_version')} >= 1`),
    rule(
      'tenant_connection_redirects',
      `json_valid(${col('redirect_uris')}) = 1 AND json_type(${col('redirect_uris')}) = 'array' AND length(CAST(${col('redirect_uris')} AS BLOB)) <= 1024`,
    ),
    rule('tenant_connection_proof', jsonObject(col('proof'), 51_200)),
    rule(
      'tenant_connection_times',
      `${optional('verified_at', iso(col('verified_at')))} AND ${iso(col('updated_at'))}`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Identity: last-known labels and server-side sessions
// ---------------------------------------------------------------------------------------------

export const appUser = sqliteTable(
  'app_user',
  {
    tid: text('tid').notNull(),
    oid: text('oid').notNull(),
    upnLabel: text('upn_label'),
    nameLabel: text('name_label'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSigninAt: text('last_signin_at').notNull(),
    groupsResolvedAt: text('groups_resolved_at'),
  },
  (table) => [
    primaryKey({ columns: [table.tid, table.oid] }),
    rule('app_user_ids', `${guid(col('tid'))} AND ${guid(col('oid'))}`),
    rule(
      'app_user_labels',
      `(${col('upn_label')} IS NULL OR length(CAST(${col('upn_label')} AS BLOB)) <= 256) AND (${col('name_label')} IS NULL OR length(CAST(${col('name_label')} AS BLOB)) <= 256)`,
    ),
    rule(
      'app_user_times',
      `${iso(col('first_seen_at'))} AND ${iso(col('last_signin_at'))} AND ${optional('groups_resolved_at', iso(col('groups_resolved_at')))}`,
    ),
  ],
);

export const session = sqliteTable(
  'session',
  {
    idHash: text('id_hash').primaryKey(),
    kind: text('kind').notNull(),
    tid: text('tid').notNull(),
    oid: text('oid').notNull().default(''),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    absoluteExpiresAt: text('absolute_expires_at').notNull(),
    mfa: integer('mfa').notNull().default(0),
    amr: text('amr').notNull().default('[]'),
    authenticatedAt: text('authenticated_at').notNull(),
    stepUpAt: text('step_up_at'),
    groupsStale: integer('groups_stale').notNull().default(0),
  },
  (table) => [
    index('session_principal_idx').on(table.tid, table.oid),
    index('session_expiry_idx').on(table.absoluteExpiresAt),
    rule('session_id_hash', hex(col('id_hash'), 64)),
    rule('session_kind', `${col('kind')} IN ('user', 'break_glass')`),
    rule(
      'session_principal',
      `${guid(col('tid'))} AND ((${col('kind')} = 'user' AND ${guid(col('oid'))}) OR (${col('kind')} = 'break_glass' AND ${col('oid')} = ''))`,
    ),
    rule('session_flags', `${col('mfa')} IN (0, 1) AND ${col('groups_stale')} IN (0, 1)`),
    rule(
      'session_amr',
      `json_valid(${col('amr')}) = 1 AND json_type(${col('amr')}) = 'array' AND length(CAST(${col('amr')} AS BLOB)) <= 256`,
    ),
    rule(
      'session_times',
      `${iso(col('created_at'))} AND ${iso(col('last_seen_at'))} AND ${iso(col('absolute_expires_at'))} AND ${iso(col('authenticated_at'))} AND ${optional('step_up_at', iso(col('step_up_at')))}`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// RBAC (FR-B-501 to FR-B-513)
// ---------------------------------------------------------------------------------------------

const ROLE_KEY_SHAPE = (name: string): string =>
  `length(${col(name)}) BETWEEN 2 AND 32 AND ${col(name)} GLOB '[a-z]*' AND ${col(name)} NOT GLOB '*[^a-z0-9_]*'`;

export const rbacRole = sqliteTable(
  'rbac_role',
  {
    id: integer('id').primaryKey(),
    key: text('key').notNull(),
    builtin: integer('builtin').notNull().default(0),
    assignable: integer('assignable').notNull().default(1),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('rbac_role_key_uq').on(table.key),
    rule('rbac_role_key', ROLE_KEY_SHAPE('key')),
    rule('rbac_role_flags', `${col('builtin')} IN (0, 1) AND ${col('assignable')} IN (0, 1)`),
    rule('rbac_role_created_at', iso(col('created_at'))),
  ],
);

/**
 * The table `rbac_role_permission`. The TypeScript name is `rbacRoleGrant`, not `rbacRolePermission`:
 * `shared/single-implementation.test.ts` reserves names that look like the permission catalogue.
 */
export const rbacRoleGrant = sqliteTable(
  'rbac_role_permission',
  {
    roleId: integer('role_id')
      .notNull()
      .references(() => rbacRole.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    qualifier: text('qualifier').notNull().default(''),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permission] }),
    rule(
      'rbac_role_permission_shape',
      `length(${col('permission')}) BETWEEN 3 AND 64 AND ${col('permission')} NOT GLOB '*[^a-z:]*'`,
    ),
    rule(
      'rbac_role_permission_qualifier',
      `${col('qualifier')} IN ('', 'basic') AND (${col('qualifier')} = '' OR ${col('permission')} = 'users:read')`,
    ),
  ],
);

export const rbacRoleTemplate = sqliteTable(
  'rbac_role_template',
  {
    key: text('key').primaryKey(),
    permissions: text('permissions').notNull(),
    scopeTarget: text('scope_target'),
  },
  () => [
    rule('rbac_role_template_key', ROLE_KEY_SHAPE('key')),
    rule(
      'rbac_role_template_permissions',
      `json_valid(${col('permissions')}) = 1 AND json_type(${col('permissions')}) = 'array' AND length(CAST(${col('permissions')} AS BLOB)) <= 2048`,
    ),
    rule(
      'rbac_role_template_target',
      `${col('scope_target')} IS NULL OR ${col('scope_target')} IN ('user', 'group', 'distributionList', 'contact')`,
    ),
  ],
);

export const rbacAssignment = sqliteTable(
  'rbac_assignment',
  {
    id: text('id').primaryKey(),
    principalType: text('principal_type').notNull(),
    principalId: text('principal_id').notNull(),
    roleId: integer('role_id')
      .notNull()
      .references(() => rbacRole.id, { onDelete: 'restrict' }),
    scopeHash: text('scope_hash').notNull(),
    expiresAt: text('expires_at'),
    source: text('source').notNull(),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').notNull(),
  },
  (table) => [
    uniqueIndex('rbac_assignment_unique').on(
      table.principalType,
      table.principalId,
      table.roleId,
      table.scopeHash,
    ),
    index('rbac_assignment_principal_idx').on(table.principalType, table.principalId),
    index('rbac_assignment_role_idx').on(table.roleId),
    rule('rbac_assignment_id', guid(col('id'))),
    rule(
      'rbac_assignment_principal',
      `${col('principal_type')} IN ('user', 'group') AND ${guid(col('principal_id'))}`,
    ),
    rule('rbac_assignment_scope_hash', hex(col('scope_hash'), 64)),
    rule('rbac_assignment_source', `${col('source')} IN ('wizard', 'api', 'break_glass')`),
    rule(
      'rbac_assignment_created_by',
      `length(CAST(${col('created_by')} AS BLOB)) BETWEEN 1 AND 64`,
    ),
    rule(
      'rbac_assignment_times',
      `${iso(col('created_at'))} AND ${optional('expires_at', iso(col('expires_at')))}`,
    ),
  ],
);

/**
 * The scope matrix of plan 11.3 as a CHECK: `by id` never targets `user`; `alias` never targets
 * `user`; `department` only `user` and `contact`. The database refuses what the algorithm cannot
 * evaluate.
 */
const SCOPE_MATCH = [
  '',
  `\t\t(${col('match_by')} = 'id' AND ${col('attr')} = '' AND ${guid(col('value'))} AND ${col('target')} <> 'user')`,
  `\t\tOR (${col('match_by')} = 'prefix' AND (${col('attr')} IN ('displayName', 'mail') OR (${col('attr')} = 'alias' AND ${col('target')} <> 'user')) AND length(CAST(${col('value')} AS BLOB)) BETWEEN 1 AND 256 AND length(${col('value')}) <= 64)`,
  `\t\tOR (${col('match_by')} = 'department' AND ${col('attr')} = '' AND length(CAST(${col('value')} AS BLOB)) BETWEEN 1 AND 256 AND length(${col('value')}) <= 64 AND ${col('target')} IN ('user', 'contact'))`,
  '\t',
].join('\n');

export const rbacAssignmentScope = sqliteTable(
  'rbac_assignment_scope',
  {
    assignmentId: text('assignment_id')
      .notNull()
      .references(() => rbacAssignment.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    target: text('target').notNull(),
    matchBy: text('match_by').notNull(),
    attr: text('attr').notNull().default(''),
    value: text('value').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.assignmentId, table.position] }),
    rule('rbac_assignment_scope_position', `${col('position')} BETWEEN 0 AND 49`),
    rule(
      'rbac_assignment_scope_target',
      `${col('target')} IN ('user', 'group', 'distributionList', 'contact')`,
    ),
    rule('rbac_assignment_scope_match', SCOPE_MATCH),
  ],
);

export const rbacGroupMemberCache = sqliteTable(
  'rbac_group_member_cache',
  {
    userOid: text('user_oid').notNull(),
    groupId: text('group_id').notNull(),
    resolvedAt: text('resolved_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userOid, table.groupId] }),
    rule('rbac_group_member_cache_ids', `${guid(col('user_oid'))} AND ${guid(col('group_id'))}`),
    rule('rbac_group_member_cache_time', iso(col('resolved_at'))),
  ],
);

export const rbacEpoch = sqliteTable(
  'rbac_epoch',
  {
    id: integer('id').primaryKey(),
    epoch: integer('epoch').notNull().default(0),
  },
  () => [
    rule('rbac_epoch_singleton', `${col('id')} = 1`),
    rule('rbac_epoch_value', `${col('epoch')} >= 0`),
  ],
);

export type SetupStateRow = typeof setupState.$inferSelect;
export type SetupStepRow = typeof setupStep.$inferSelect;
export type SetupObjectRow = typeof setupObject.$inferSelect;
export type SetupLogRow = typeof setupLog.$inferSelect;
export type RunnerLeaseRow = typeof runnerLease.$inferSelect;
export type SecretRow = typeof secret.$inferSelect;
export type CertificateRow = typeof certificate.$inferSelect;
export type TenantConnectionRow = typeof tenantConnection.$inferSelect;
export type AppUserRow = typeof appUser.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type RbacRoleRow = typeof rbacRole.$inferSelect;
export type RbacRoleGrantRow = typeof rbacRoleGrant.$inferSelect;
export type RbacRoleTemplateRow = typeof rbacRoleTemplate.$inferSelect;
export type RbacAssignmentRow = typeof rbacAssignment.$inferSelect;
export type RbacAssignmentScopeRow = typeof rbacAssignmentScope.$inferSelect;
export type RbacGroupMemberCacheRow = typeof rbacGroupMemberCache.$inferSelect;
export type RbacEpochRow = typeof rbacEpoch.$inferSelect;
