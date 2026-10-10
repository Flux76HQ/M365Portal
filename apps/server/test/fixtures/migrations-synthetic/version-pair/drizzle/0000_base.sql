-- Synthetic fixture, version 0 of the upgrade harness (T-A-038). Not a migration of the product.
-- A parent and a child with ON DELETE CASCADE (the shape that probe P12 destroys when a parent is
-- rebuilt under foreign_keys = ON), plus the real audit_log table and triggers, so that the
-- harness can seed a hash chain and verify it after the upgrade.
CREATE TABLE `owner` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pet` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_id` integer NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owner`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`outcome` text NOT NULL,
	`reason_code` text,
	`client_ip` text,
	`request_id` text,
	`detail` text DEFAULT '{}' NOT NULL,
	`prev_hash` blob NOT NULL,
	`hash` blob NOT NULL,
	CONSTRAINT "audit_log_ts_shape" CHECK(ts GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "audit_log_outcome_set" CHECK(outcome IN ('success', 'denied', 'rejected', 'error')),
	CONSTRAINT "audit_log_detail_json" CHECK(json_valid(detail) = 1 AND length(CAST(detail AS BLOB)) <= 4096),
	CONSTRAINT "audit_log_hash_sizes" CHECK(length(prev_hash) = 32 AND length(hash) = 32)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_hash_uq` ON `audit_log` (`hash`);
--> statement-breakpoint
-- =============================================================================================
-- HAND-WRITTEN SECTION (data-model 7.1). Everything above this banner is drizzle-kit output; the
-- audit_log triggers below are not part of the TypeScript schema (drizzle-kit cannot render them),
-- which is why the committed snapshots are taken from the migrated database (PD-05).
--
-- audit_log_no_update / audit_log_no_delete: the log is append-only (I-7).
-- audit_log_chain_link: SQLite cannot compute SHA-256, but it can refuse an insert whose seq or
-- prev_hash does not continue the chain, so even a buggy writer cannot fork it (I-6). Because it
-- requires seq = MAX(seq) + 1, an INSERT OR REPLACE onto an existing seq is refused as well.
-- =============================================================================================
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_log_chain_link BEFORE INSERT ON audit_log
WHEN NEW.seq <> COALESCE((SELECT MAX(seq) FROM audit_log), 0) + 1
  OR NEW.prev_hash <> COALESCE((SELECT hash FROM audit_log WHERE seq = (SELECT MAX(seq) FROM audit_log)), zeroblob(32))
BEGIN SELECT RAISE(ABORT, 'audit_log chain link violated'); END;
