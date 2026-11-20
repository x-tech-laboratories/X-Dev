CREATE TABLE `items` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`kind` text DEFAULT 'feature' NOT NULL,
	`repository` text NOT NULL,
	`issue_number` integer,
	`stage` text DEFAULT 'triage' NOT NULL,
	`status` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX `items_by_repository` ON `items` (`repository`);