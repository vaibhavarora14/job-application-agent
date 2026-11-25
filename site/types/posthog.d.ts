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

declare module "*/jobs-analytics.mjs" {
  export const JOBS_EVENTS: Readonly<{
    GOOGLE_FOR_JOBS_LANDING: string;
    COPY_CLICKED: string;
  }>;
  export const JOBS_COPY_KINDS: Readonly<{
    PROMPT: "prompt";
    COMMAND: "command";
  }>;
  export function setJobsAnalyticsBrowserConfig(config: { apiKey: string; host?: string } | null): void;
  export function resetJobsAnalyticsForTests(): void;
  export function isJobsCopyKind(value: unknown): value is "prompt" | "command";
  export function normalizeJobsPathname(pathname?: string): string;
  export function classifyJobsSurface(pathname?: string): "board" | "job_page" | null;
  export function isGoogleJobsReferrerHost(hostname?: string): boolean;
  export function referrerHostname(referrer?: string): string;
  export function jobsCaptureHost(host?: string): string;
  export function detectGoogleForJobsLanding(input?: {
    referrer?: string;
    search?: string;
    utm?: Record<string, string>;
  }): boolean;
  export function jobsCaptureUrl(input?: {
    origin?: string;
    pathname?: string;
    href?: string;
  }): string;
  export function captureJobsPageview(input: {
    apiKey: string;
    host?: string;
    pathname?: string;
    search?: string;
    origin?: string;
    href?: string;
    referrer?: string;
    distinctId?: string;
    fetchFn?: typeof fetch;
  }): Promise<{ ok: boolean; skipped: boolean; status?: number }>;
  export function captureJobsCopyClicked(input: {
    apiKey: string;
    host?: string;
    copyKind: "prompt" | "command";
    pathname?: string;
    origin?: string;
    href?: string;
    distinctId?: string;
    fetchFn?: typeof fetch;
  }): Promise<{ ok: boolean; skipped: boolean; status?: number }>;
  export function trackJobsCopyClicked(copyKind: "prompt" | "command"): void;
}
