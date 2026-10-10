-- Version 1 of the plain pair: a new column with a default, and an index. Snapshot and SQL agree.
ALTER TABLE `owner` ADD `label` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
CREATE INDEX `owner_name_idx` ON `owner` (`name`);
