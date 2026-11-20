// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261120034019_start",
    "statements": [
      "CREATE TABLE `runs` (\n\t`id` text PRIMARY KEY,\n\t`item_id` text NOT NULL,\n\t`stage` text NOT NULL,\n\t`state` text NOT NULL,\n\t`model` text DEFAULT '' NOT NULL,\n\t`effort` text DEFAULT '' NOT NULL,\n\t`session_id` text NOT NULL,\n\t`start_commit` text DEFAULT '' NOT NULL,\n\t`status_before` text DEFAULT '{}' NOT NULL,\n\t`input` text DEFAULT '' NOT NULL,\n\t`output` text DEFAULT '' NOT NULL,\n\t`report` text DEFAULT '' NOT NULL,\n\t`next` text DEFAULT '' NOT NULL,\n\t`questions` text DEFAULT '[]' NOT NULL,\n\t`answers` text DEFAULT '' NOT NULL,\n\t`cost_usd` real DEFAULT 0 NOT NULL,\n\t`error` text DEFAULT '' NOT NULL,\n\t`started_at` text NOT NULL,\n\t`ended_at` text,\n\t`proposals` integer DEFAULT 0 NOT NULL,\n\tCONSTRAINT `fk_runs_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE CASCADE\n);",
      "CREATE INDEX `runs_by_item` ON `runs` (`item_id`,`started_at`);"
    ]
  },
  {
    "name": "20261120040450_gates",
    "statements": [
      "ALTER TABLE `runs` ADD `end_commit` text DEFAULT '' NOT NULL;",
      "ALTER TABLE `runs` ADD `gates` text DEFAULT '[]' NOT NULL;",
      "ALTER TABLE `runs` ADD `overrides` text DEFAULT '[]' NOT NULL;"
    ]
  },
  {
    "name": "20261120045202_tokens",
    "statements": [
      "ALTER TABLE `runs` ADD `input_tokens` integer DEFAULT 0 NOT NULL;",
      "ALTER TABLE `runs` ADD `output_tokens` integer DEFAULT 0 NOT NULL;"
    ]
  },
  {
    "name": "20261120072902_live",
    "statements": [
      "ALTER TABLE `runs` ADD `transcript` text DEFAULT '' NOT NULL;",
      "ALTER TABLE `runs` ADD `interjections` text DEFAULT '[]' NOT NULL;",
      "ALTER TABLE `runs` ADD `retry_of` text DEFAULT '' NOT NULL;",
      "ALTER TABLE `runs` ADD `attempt` integer DEFAULT 1 NOT NULL;"
    ]
  }
];
