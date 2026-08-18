declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    DODO_PAYMENTS_API_KEY?: string;
    DODO_PAYMENTS_WEBHOOK_KEY?: string;
    DODO_PRODUCT_ID?: string;
    DODO_PAYMENTS_ENVIRONMENT?: string;
    PUBLIC_SITE_URL?: string;
  }
}
