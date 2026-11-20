ALTER TABLE `runs` ADD `transcript` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `interjections` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `retry_of` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `attempt` integer DEFAULT 1 NOT NULL;