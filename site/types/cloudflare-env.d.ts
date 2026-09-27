declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** Set via `wrangler secret put SENTRY_DSN` — never commit the value. */
    SENTRY_DSN?: string;
    /** Optional override; defaults to production when PUBLIC_SITE_URL is jobappagent.com. */
    SENTRY_ENVIRONMENT?: string;
    /** Git SHA stamped on deploy (`--var SENTRY_RELEASE:$GITHUB_SHA`). */
    SENTRY_RELEASE?: string;
    /** Server-side PostHog project API key (wrangler secret). Prefer project 556627. */
    POSTHOG_PROJECT_API_KEY?: string;
    /** PostHog ingest host; defaults to https://us.i.posthog.com */
    POSTHOG_HOST?: string;
    /** Public PostHog project key for landing client capture (Cloudflare var, not secret). */
    NEXT_PUBLIC_POSTHOG_KEY?: string;
    /** Optional public PostHog host override for the browser client. */
    NEXT_PUBLIC_POSTHOG_HOST?: string;
    DODO_PAYMENTS_API_KEY?: string;
    DODO_PAYMENTS_WEBHOOK_KEY?: string;
    DODO_PRODUCT_ID?: string;
    DODO_PAYMENTS_ENVIRONMENT?: string;
    PUBLIC_SITE_URL?: string;
    RATE_LIMIT_SALT?: string;
    COMMUNITY_STATS_UPSTREAM?: string;
    COMMUNITY_JOBS_UPSTREAM?: string;
    REFUND_CRON_SECRET?: string;
    ATTENTION_NOTIFY_SECRET?: string;
    ATTENTION_MAGIC_LINK_SECRET?: string;
    ATTENTION_LIVE_SESSION_BASE_URL?: string;
    ATTENTION_NOVNC_PASSWORD?: string;
    ATTENTION_IAP_HELPER_COMMAND?: string;
    ATTENTION_WAKE_URL?: string;
    ATTENTION_WAKE_INSTRUCTIONS?: string;
    /** Optional OpenAI-compatible key for attention judgment drafts (P1.5). */
    ATTENTION_DRAFT_API_KEY?: string;
    ATTENTION_DRAFT_BASE_URL?: string;
    ATTENTION_DRAFT_MODEL?: string;
    RESEND_API_KEY?: string;
    RESEND_FROM_EMAIL?: string;
  }
}
