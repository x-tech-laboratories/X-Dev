ALTER TABLE `items` ADD `body` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `notes` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `branch` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `source_item_id` text;--> statement-breakpoint
ALTER TABLE `items` ADD `source_run_id` text;