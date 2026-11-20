CREATE TABLE `runs` (
	`id` text PRIMARY KEY,
	`item_id` text NOT NULL,
	`stage` text NOT NULL,
	`state` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`effort` text DEFAULT '' NOT NULL,
	`session_id` text NOT NULL,
	`start_commit` text DEFAULT '' NOT NULL,
	`status_before` text DEFAULT '{}' NOT NULL,
	`input` text DEFAULT '' NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	`report` text DEFAULT '' NOT NULL,
	`next` text DEFAULT '' NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`answers` text DEFAULT '' NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`proposals` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_runs_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `runs_by_item` ON `runs` (`item_id`,`started_at`);