ALTER TABLE `runs` ADD `permission_mode` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `allowed` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `awaiting` text DEFAULT '' NOT NULL;