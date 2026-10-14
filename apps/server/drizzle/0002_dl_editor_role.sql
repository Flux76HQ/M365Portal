-- ===== hand-written section (not in schema.ts): seeds and triggers =====
-- The sixth built-in role, `dl_editor` (Distribution List Editor, ADR-0183). Migration 0001 sealed the set at five
-- built-in roles and made their permissions immutable by trigger, so the two triggers that would refuse the new
-- rows are dropped, the role and its seven permissions are seeded, and the triggers come back with the limit of six.
DROP TRIGGER `rbac_role_builtin_no_insert_flag`;
--> statement-breakpoint
DROP TRIGGER `rbac_role_permission_builtin_no_insert`;
--> statement-breakpoint
INSERT INTO `rbac_role` (`key`, `builtin`, `assignable`, `created_at`) VALUES
	('dl_editor', 1, 1, '2026-01-01T00:00:00.000Z');
--> statement-breakpoint
INSERT INTO `rbac_role_permission` (`role_id`, `permission`, `qualifier`)
SELECT `id`, `permission`, '' FROM `rbac_role`, (
	SELECT 'users:read' AS `permission` UNION ALL SELECT 'distributionlists:read' UNION ALL SELECT 'distributionlists:members:write'
	UNION ALL SELECT 'contacts:read' UNION ALL SELECT 'contacts:create' UNION ALL SELECT 'contacts:update' UNION ALL SELECT 'contacts:delete'
) WHERE `key` = 'dl_editor';
--> statement-breakpoint
CREATE TRIGGER `rbac_role_builtin_no_insert_flag` BEFORE INSERT ON `rbac_role` WHEN NEW.`builtin` = 1 AND (SELECT count(*) FROM `rbac_role` WHERE `builtin` = 1) >= 6
BEGIN SELECT RAISE(ABORT, 'built-in roles are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `rbac_role_permission_builtin_no_insert` BEFORE INSERT ON `rbac_role_permission` WHEN (SELECT `builtin` FROM `rbac_role` WHERE `id` = NEW.`role_id`) = 1
BEGIN SELECT RAISE(ABORT, 'permissions of built-in roles are immutable'); END;
--> statement-breakpoint
-- The epoch triggers counted the eight inserts above. The grants of the five existing roles did not change, so
-- no cached grant is stale: the epoch stays where the installation had it (a fresh install ends at 0, as in 0001).
UPDATE `rbac_epoch` SET `epoch` = `epoch` - 8 WHERE `id` = 1;
