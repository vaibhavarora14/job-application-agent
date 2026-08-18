CREATE TABLE `public_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_public_rate_limits_updated_at` ON `public_rate_limits` (`updated_at`);--> statement-breakpoint
PRAGMA optimize;
