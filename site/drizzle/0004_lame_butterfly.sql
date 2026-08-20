CREATE TABLE `founding_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`checkout_session_id` text,
	`checkout_url` text,
	`dodo_payment_id` text,
	`dodo_customer_id` text,
	`customer_email` text,
	`product_id` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`amount` integer,
	`currency` text,
	`paid_at` text,
	`activation_deadline_at` text,
	`activated_at` text,
	`access_expires_at` text,
	`refund_id` text,
	`refund_status` text,
	`refund_requested_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founding_purchases_checkout_session_id_unique` ON `founding_purchases` (`checkout_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `founding_purchases_dodo_payment_id_unique` ON `founding_purchases` (`dodo_payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `founding_purchases_refund_id_unique` ON `founding_purchases` (`refund_id`);--> statement-breakpoint
CREATE INDEX `idx_founding_purchases_refund_due` ON `founding_purchases` (`status`,`activation_deadline_at`);