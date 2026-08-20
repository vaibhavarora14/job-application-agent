CREATE TABLE `founding_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`registration_id` text NOT NULL,
	`checkout_session_id` text NOT NULL,
	`checkout_url` text NOT NULL,
	`dodo_payment_id` text,
	`product_id` text NOT NULL,
	`status` text DEFAULT 'checkout_created' NOT NULL,
	`amount` integer,
	`currency` text,
	`paid_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`registration_id`) REFERENCES `founding_registrations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founding_payments_checkout_session_id_unique` ON `founding_payments` (`checkout_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `founding_payments_dodo_payment_id_unique` ON `founding_payments` (`dodo_payment_id`);--> statement-breakpoint
CREATE TABLE `payment_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`payment_id` text,
	`processed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
