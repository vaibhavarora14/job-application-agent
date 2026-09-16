CREATE TABLE `attention_answer_bank` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`prompt` text NOT NULL,
	`text` text NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'typed' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_attention_answer_bank_updated_at` ON `attention_answer_bank` (`updated_at`);
