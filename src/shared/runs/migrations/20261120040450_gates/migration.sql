ALTER TABLE `runs` ADD `end_commit` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `gates` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `overrides` text DEFAULT '[]' NOT NULL;