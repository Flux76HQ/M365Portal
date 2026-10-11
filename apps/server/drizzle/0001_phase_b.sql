CREATE TABLE `app_user` (
	`tid` text NOT NULL,
	`oid` text NOT NULL,
	`upn_label` text,
	`name_label` text,
	`first_seen_at` text NOT NULL,
	`last_signin_at` text NOT NULL,
	`groups_resolved_at` text,
	PRIMARY KEY(`tid`, `oid`),
	CONSTRAINT "app_user_ids" CHECK((length(`tid`) = 36 AND `tid` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]') AND (length(`oid`) = 36 AND `oid` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "app_user_labels" CHECK((`upn_label` IS NULL OR length(CAST(`upn_label` AS BLOB)) <= 256) AND (`name_label` IS NULL OR length(CAST(`name_label` AS BLOB)) <= 256)),
	CONSTRAINT "app_user_times" CHECK(`first_seen_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND `last_signin_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND (`groups_resolved_at` IS NULL OR `groups_resolved_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))
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
	CONSTRAINT "certificate_id" CHECK((length(`id`) = 36 AND `id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "certificate_sha1" CHECK((length(`thumbprint_sha1`) = 40 AND `thumbprint_sha1` NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "certificate_sha256" CHECK((length(`thumbprint_sha256`) = 64 AND `thumbprint_sha256` NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "certificate_subject" CHECK(length(CAST(`subject` AS BLOB)) BETWEEN 1 AND 256),
	CONSTRAINT "certificate_validity" CHECK(`not_before` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND `not_after` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND `not_before` < `not_after`),
	CONSTRAINT "certificate_der" CHECK(typeof(`public_der`) = 'blob' AND length(`public_der`) BETWEEN 256 AND 4096),
	CONSTRAINT "certificate_state" CHECK(`state` IN ('pending', 'active', 'retired')),
	CONSTRAINT "certificate_created_at" CHECK(`created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `certificate_one_active` ON `certificate` (`state`) WHERE `state` = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `certificate_one_pending` ON `certificate` (`state`) WHERE `state` = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `certificate_sha1_uq` ON `certificate` (`thumbprint_sha1`);--> statement-breakpoint
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
	CONSTRAINT "rbac_assignment_id" CHECK((length(`id`) = 36 AND `id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "rbac_assignment_principal" CHECK(`principal_type` IN ('user', 'group') AND (length(`principal_id`) = 36 AND `principal_id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "rbac_assignment_scope_hash" CHECK((length(`scope_hash`) = 64 AND `scope_hash` NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "rbac_assignment_source" CHECK(`source` IN ('wizard', 'api', 'break_glass')),
	CONSTRAINT "rbac_assignment_created_by" CHECK(length(CAST(`created_by` AS BLOB)) BETWEEN 1 AND 64),
	CONSTRAINT "rbac_assignment_times" CHECK(`created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND (`expires_at` IS NULL OR `expires_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rbac_assignment_unique` ON `rbac_assignment` (`principal_type`,`principal_id`,`role_id`,`scope_hash`);--> statement-breakpoint
CREATE INDEX `rbac_assignment_principal_idx` ON `rbac_assignment` (`principal_type`,`principal_id`);--> statement-breakpoint
CREATE INDEX `rbac_assignment_role_idx` ON `rbac_assignment` (`role_id`);--> statement-breakpoint
CREATE TABLE `rbac_assignment_scope` (
	`assignment_id` text NOT NULL,
	`position` integer NOT NULL,
	`target` text NOT NULL,
	`match_by` text NOT NULL,
	`attr` text DEFAULT '' NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`assignment_id`, `position`),
	FOREIGN KEY (`assignment_id`) REFERENCES `rbac_assignment`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rbac_assignment_scope_position" CHECK(`position` BETWEEN 0 AND 49),
	CONSTRAINT "rbac_assignment_scope_target" CHECK(`target` IN ('user', 'group', 'distributionList', 'contact')),
	CONSTRAINT "rbac_assignment_scope_match" CHECK(
		(`match_by` = 'id' AND `attr` = '' AND (length(`value`) = 36 AND `value` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]') AND `target` <> 'user')
		OR (`match_by` = 'prefix' AND (`attr` IN ('displayName', 'mail') OR (`attr` = 'alias' AND `target` <> 'user')) AND length(CAST(`value` AS BLOB)) BETWEEN 1 AND 256 AND length(`value`) <= 64)
		OR (`match_by` = 'department' AND `attr` = '' AND length(CAST(`value` AS BLOB)) BETWEEN 1 AND 256 AND length(`value`) <= 64 AND `target` IN ('user', 'contact'))
	)
);
--> statement-breakpoint
CREATE TABLE `rbac_epoch` (
	`id` integer PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rbac_epoch_singleton" CHECK(`id` = 1),
	CONSTRAINT "rbac_epoch_value" CHECK(`epoch` >= 0)
);
--> statement-breakpoint
CREATE TABLE `rbac_group_member_cache` (
	`user_oid` text NOT NULL,
	`group_id` text NOT NULL,
	`resolved_at` text NOT NULL,
	PRIMARY KEY(`user_oid`, `group_id`),
	CONSTRAINT "rbac_group_member_cache_ids" CHECK((length(`user_oid`) = 36 AND `user_oid` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]') AND (length(`group_id`) = 36 AND `group_id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "rbac_group_member_cache_time" CHECK(`resolved_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
--> statement-breakpoint
CREATE TABLE `rbac_role` (
	`id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`builtin` integer DEFAULT 0 NOT NULL,
	`assignable` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "rbac_role_key" CHECK(length(`key`) BETWEEN 2 AND 32 AND `key` GLOB '[a-z]*' AND `key` NOT GLOB '*[^a-z0-9_]*'),
	CONSTRAINT "rbac_role_flags" CHECK(`builtin` IN (0, 1) AND `assignable` IN (0, 1)),
	CONSTRAINT "rbac_role_created_at" CHECK(`created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rbac_role_key_uq` ON `rbac_role` (`key`);--> statement-breakpoint
CREATE TABLE `rbac_role_permission` (
	`role_id` integer NOT NULL,
	`permission` text NOT NULL,
	`qualifier` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	FOREIGN KEY (`role_id`) REFERENCES `rbac_role`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rbac_role_permission_shape" CHECK(length(`permission`) BETWEEN 3 AND 64 AND `permission` NOT GLOB '*[^a-z:]*'),
	CONSTRAINT "rbac_role_permission_qualifier" CHECK(`qualifier` IN ('', 'basic') AND (`qualifier` = '' OR `permission` = 'users:read'))
);
--> statement-breakpoint
CREATE TABLE `rbac_role_template` (
	`key` text PRIMARY KEY NOT NULL,
	`permissions` text NOT NULL,
	`scope_target` text,
	CONSTRAINT "rbac_role_template_key" CHECK(length(`key`) BETWEEN 2 AND 32 AND `key` GLOB '[a-z]*' AND `key` NOT GLOB '*[^a-z0-9_]*'),
	CONSTRAINT "rbac_role_template_permissions" CHECK(json_valid(`permissions`) = 1 AND json_type(`permissions`) = 'array' AND length(CAST(`permissions` AS BLOB)) <= 2048),
	CONSTRAINT "rbac_role_template_target" CHECK(`scope_target` IS NULL OR `scope_target` IN ('user', 'group', 'distributionList', 'contact'))
);
--> statement-breakpoint
CREATE TABLE `runner_lease` (
	`id` integer PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT "runner_lease_singleton" CHECK(`id` = 1),
	CONSTRAINT "runner_lease_times" CHECK(`heartbeat_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND `expires_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
--> statement-breakpoint
CREATE TABLE `secret` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`key_id` text NOT NULL,
	`blob` blob NOT NULL,
	`created_at` text NOT NULL,
	`retired_at` text,
	CONSTRAINT "secret_id" CHECK((length(`id`) = 36 AND `id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "secret_purpose" CHECK(length(`purpose`) BETWEEN 1 AND 64 AND `purpose` NOT GLOB '*[^a-z_]*'),
	CONSTRAINT "secret_key_id" CHECK((length(`key_id`) = 16 AND `key_id` NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "secret_blob" CHECK(typeof(`blob`) = 'blob' AND length(`blob`) >= 41 AND length(`blob`) <= 16384 AND hex(substr(`blob`, 1, 1)) = '01'),
	CONSTRAINT "secret_times" CHECK(`created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND (`retired_at` IS NULL OR `retired_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))
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
	CONSTRAINT "session_id_hash" CHECK((length(`id_hash`) = 64 AND `id_hash` NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "session_kind" CHECK(`kind` IN ('user', 'break_glass')),
	CONSTRAINT "session_principal" CHECK((length(`tid`) = 36 AND `tid` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]') AND ((`kind` = 'user' AND (length(`oid`) = 36 AND `oid` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')) OR (`kind` = 'break_glass' AND `oid` = ''))),
	CONSTRAINT "session_flags" CHECK(`mfa` IN (0, 1) AND `groups_stale` IN (0, 1)),
	CONSTRAINT "session_amr" CHECK(json_valid(`amr`) = 1 AND json_type(`amr`) = 'array' AND length(CAST(`amr` AS BLOB)) <= 256),
	CONSTRAINT "session_times" CHECK(`created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND `last_seen_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND `absolute_expires_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND `authenticated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND (`step_up_at` IS NULL OR `step_up_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))
);
--> statement-breakpoint
CREATE INDEX `session_principal_idx` ON `session` (`tid`,`oid`);--> statement-breakpoint
CREATE INDEX `session_expiry_idx` ON `session` (`absolute_expires_at`);--> statement-breakpoint
CREATE TABLE `setup_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`step` text NOT NULL,
	`level` text NOT NULL,
	`message_key` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "setup_log_level" CHECK(`level` IN ('info', 'warn', 'error')),
	CONSTRAINT "setup_log_params" CHECK((json_valid(`params`) = 1 AND json_type(`params`) = 'object' AND length(CAST(`params` AS BLOB)) <= 1024)),
	CONSTRAINT "setup_log_ts" CHECK(`ts` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
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
	CONSTRAINT "setup_object_id" CHECK(length(`tenant_object_id`) BETWEEN 1 AND 128),
	CONSTRAINT "setup_object_app_id" CHECK(`app_id` IS NULL OR (length(`app_id`) = 36 AND `app_id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "setup_object_name" CHECK(length(CAST(`name` AS BLOB)) BETWEEN 1 AND 256),
	CONSTRAINT "setup_object_origin" CHECK(`origin` IN ('created', 'adopted')),
	CONSTRAINT "setup_object_created_at" CHECK(`created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
--> statement-breakpoint
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
	CONSTRAINT "setup_state_singleton" CHECK(`id` = 1),
	CONSTRAINT "setup_state_state" CHECK(`state` IN ('unconfigured', 'in_progress', 'awaiting_first_signin', 'completed')),
	CONSTRAINT "setup_state_mode" CHECK(`mode` IN ('automatic', 'manual')),
	CONSTRAINT "setup_state_install_id" CHECK((length(`install_id`) = 32 AND `install_id` NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "setup_state_owner_oid" CHECK(`designated_owner_oid` IS NULL OR (length(`designated_owner_oid`) = 36 AND `designated_owner_oid` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "setup_state_tenant" CHECK(`proposed_tenant_id` IS NULL OR (length(`proposed_tenant_id`) = 36 AND `proposed_tenant_id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "setup_state_language" CHECK(`default_language` IS NULL OR `default_language` IN ('nl', 'en')),
	CONSTRAINT "setup_state_completed_at" CHECK((`state` = 'completed') = (`completed_at` IS NOT NULL)),
	CONSTRAINT "setup_state_updated_at" CHECK(`updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
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
	CONSTRAINT "setup_step_status" CHECK(`status` IN ('pending', 'running', 'waiting', 'succeeded', 'warning', 'failed', 'skipped')),
	CONSTRAINT "setup_step_attempt" CHECK(`attempt` >= 0),
	CONSTRAINT "setup_step_detail" CHECK((json_valid(`detail`) = 1 AND json_type(`detail`) = 'object' AND length(CAST(`detail` AS BLOB)) <= 4096)),
	CONSTRAINT "setup_step_times" CHECK((`started_at` IS NULL OR `started_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z') AND (`finished_at` IS NULL OR `finished_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z') AND `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
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
	CONSTRAINT "tenant_connection_singleton" CHECK(`id` = 1),
	CONSTRAINT "tenant_connection_ids" CHECK((`tenant_id` IS NULL OR (length(`tenant_id`) = 36 AND `tenant_id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')) AND (`app_object_id` IS NULL OR (length(`app_object_id`) = 36 AND `app_object_id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')) AND (`app_id` IS NULL OR (length(`app_id`) = 36 AND `app_id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')) AND (`sp_object_id` IS NULL OR (length(`sp_object_id`) = 36 AND `sp_object_id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')) AND (`graph_sp_id` IS NULL OR (length(`graph_sp_id`) = 36 AND `graph_sp_id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')) AND (`exchange_sp_id` IS NULL OR (length(`exchange_sp_id`) = 36 AND `exchange_sp_id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')) AND (`exchange_role_template_id` IS NULL OR (length(`exchange_role_template_id`) = 36 AND `exchange_role_template_id` GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'))),
	CONSTRAINT "tenant_connection_strings" CHECK((`tenant_name` IS NULL OR length(CAST(`tenant_name` AS BLOB)) <= 256) AND (`initial_domain` IS NULL OR length(CAST(`initial_domain` AS BLOB)) <= 256)),
	CONSTRAINT "tenant_connection_exchange" CHECK(`exchange_enabled` IN (0, 1)),
	CONSTRAINT "tenant_connection_version" CHECK(`permission_set_version` >= 1),
	CONSTRAINT "tenant_connection_redirects" CHECK(json_valid(`redirect_uris`) = 1 AND json_type(`redirect_uris`) = 'array' AND length(CAST(`redirect_uris` AS BLOB)) <= 1024),
	CONSTRAINT "tenant_connection_proof" CHECK((json_valid(`proof`) = 1 AND json_type(`proof`) = 'object' AND length(CAST(`proof` AS BLOB)) <= 51200)),
	CONSTRAINT "tenant_connection_times" CHECK((`verified_at` IS NULL OR `verified_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z') AND `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
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
