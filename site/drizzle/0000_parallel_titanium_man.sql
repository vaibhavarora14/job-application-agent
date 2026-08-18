CREATE TABLE `founding_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`target_role` text NOT NULL,
	`target_location` text DEFAULT '' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`consent_version` text NOT NULL,
	`paid_intent` text,
	`paid_intent_recorded_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founding_registrations_email_unique` ON `founding_registrations` (`email`);