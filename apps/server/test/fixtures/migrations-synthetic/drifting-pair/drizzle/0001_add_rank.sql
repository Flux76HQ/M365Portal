-- Version 1 of the drifting pair: the SQL says DEFAULT 1 while the committed snapshot of version 1
-- says DEFAULT 0. A fresh install reads the schema, an upgrade reads this file: the harness must
-- refuse the pair (baseline section 2).
ALTER TABLE `owner` ADD `rank` integer DEFAULT 1 NOT NULL;
