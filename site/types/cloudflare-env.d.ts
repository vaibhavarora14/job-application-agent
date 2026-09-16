declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
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
    RESEND_API_KEY?: string;
    RESEND_FROM_EMAIL?: string;
  }
}
