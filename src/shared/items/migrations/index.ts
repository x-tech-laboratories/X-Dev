// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261120031212_start",
    "statements": [
      "CREATE TABLE `items` (\n\t`id` text PRIMARY KEY,\n\t`title` text NOT NULL,\n\t`kind` text DEFAULT 'feature' NOT NULL,\n\t`repository` text NOT NULL,\n\t`issue_number` integer,\n\t`stage` text DEFAULT 'triage' NOT NULL,\n\t`status` text DEFAULT '{}' NOT NULL,\n\t`created_at` text NOT NULL,\n\t`closed_at` text\n);",
      "CREATE INDEX `items_by_repository` ON `items` (`repository`);"
    ]
  },
  {
    "name": "20261120034018_run_fields",
    "statements": [
      "ALTER TABLE `items` ADD `body` text DEFAULT '' NOT NULL;",
      "ALTER TABLE `items` ADD `notes` text DEFAULT '' NOT NULL;",
      "ALTER TABLE `items` ADD `branch` text DEFAULT '' NOT NULL;",
      "ALTER TABLE `items` ADD `source_item_id` text;",
      "ALTER TABLE `items` ADD `source_run_id` text;"
    ]
  }
];
