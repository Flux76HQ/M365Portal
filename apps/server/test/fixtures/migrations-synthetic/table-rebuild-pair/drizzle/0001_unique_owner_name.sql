-- Version 1 of the rebuild pair: what drizzle-kit writes to add a UNIQUE. The table is built again,
-- copied, dropped and renamed. Under foreign_keys = ON the DROP deletes every pet (probe P12).
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_owner` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_owner`(`id`, `name`) SELECT `id`, `name` FROM `owner`;
--> statement-breakpoint
DROP TABLE `owner`;
--> statement-breakpoint
ALTER TABLE `__new_owner` RENAME TO `owner`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE UNIQUE INDEX `owner_name_unique` ON `owner` (`name`);
