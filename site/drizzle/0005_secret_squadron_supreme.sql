CREATE TABLE `customer_email_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`message_kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`provider_message_id` text,
	`last_attempt_at` text,
	`accepted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `founding_purchases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_customer_email_deliveries_purchase_kind` ON `customer_email_deliveries` (`purchase_id`,`message_kind`);--> statement-breakpoint
CREATE INDEX `idx_customer_email_deliveries_retry` ON `customer_email_deliveries` (`status`,`last_attempt_at`);--> statement-breakpoint
ALTER TABLE `founding_purchases` ADD `access_days` integer DEFAULT 90 NOT NULL;