declare module "*/posthog.mjs" {
  export const DEFAULT_POSTHOG_HOST: string;
  export const FOUNDING_EVENTS: Readonly<{
    CTA_CLICKED: string;
    CHECKOUT_CREATED: string;
    CHECKOUT_RETURNED: string;
    PAYMENT_CONFIRMED: string;
  }>;
  export const UTM_KEYS: readonly string[];
  export const POSTHOG_CONNECT_SRC: readonly string[];
  export function extractUtmParams(source: unknown): Record<string, string>;
  export function hashPurchaseId(purchaseId: string): Promise<string>;
  export function buildPostHogCaptureBody(input: {
    apiKey: string;
    event: string;
    distinctId: string;
    properties?: Record<string, unknown>;
    timestamp?: string;
    uuid?: string;
  }): {
    api_key: string;
    event: string;
    distinct_id: string;
    uuid?: string;
    timestamp: string;
    properties: Record<string, unknown>;
  };
  export function resolvePostHogHost(host?: string): string;
  export function captureSitePostHogEvent(
    env: {
      POSTHOG_PROJECT_API_KEY?: string;
      POSTHOG_HOST?: string;
      POSTHOG_FETCH?: typeof fetch;
    },
    input: {
      event: string;
      distinctId: string;
      properties?: Record<string, unknown>;
    },
  ): Promise<{ ok: boolean; skipped: boolean; status?: number }>;
  export function foundingEventProperties(
    purchaseId: string,
    extra?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

declare module "*/landing-analytics.mjs" {
  export const FOUNDING_EVENTS: Readonly<{
    CTA_CLICKED: string;
    CHECKOUT_CREATED: string;
    CHECKOUT_RETURNED: string;
    PAYMENT_CONFIRMED: string;
  }>;
  export const UTM_KEYS: readonly string[];
  export function extractUtmParams(source: unknown): Record<string, string>;
  export function getOrCreateAnonymousDistinctId(): string;
  export function readUtmFromLocation(search?: string): Record<string, string>;
  export function captureLandingEvent(input: {
    apiKey: string;
    host?: string;
    event: string;
    properties?: Record<string, unknown>;
    distinctId?: string;
    fetchFn?: typeof fetch;
  }): Promise<{ ok: boolean; skipped: boolean; status?: number }>;
  export function captureLandingPageview(input: {
    apiKey: string;
    host?: string;
    pathname?: string;
    search?: string;
    href?: string;
    fetchFn?: typeof fetch;
  }): Promise<{ ok: boolean; skipped: boolean; status?: number }>;
}
