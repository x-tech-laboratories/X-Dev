ALTER TABLE `runs` ADD `reviewed` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `reverts` text DEFAULT '[]' NOT NULL;