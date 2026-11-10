CREATE TABLE `saved_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`filter_query` text NOT NULL,
	`cadence` text NOT NULL CHECK (`cadence` IN ('daily', 'weekly')),
	`status` text NOT NULL CHECK (`status` IN ('pending', 'active')),
	`confirm_token_hash` text,
	`unsubscribe_token` text NOT NULL,
	`confirm_expires_at` text,
	`created_at` text NOT NULL,
	`confirmed_at` text,
	`last_sent_at` text,
	`watermark_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_saved_searches_email_query` ON `saved_searches` (`email`,`filter_query`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_saved_searches_unsubscribe_token` ON `saved_searches` (`unsubscribe_token`);
--> statement-breakpoint
CREATE INDEX `idx_saved_searches_confirm_token_hash` ON `saved_searches` (`confirm_token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_saved_searches_due` ON `saved_searches` (`status`,`cadence`,`last_sent_at`);
