CREATE TABLE `attention_signals` (
	`attention_id` text PRIMARY KEY NOT NULL,
	`signal` text NOT NULL,
	`actor` text DEFAULT 'candidate' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_attention_signals_updated_at` ON `attention_signals` (`updated_at`);
