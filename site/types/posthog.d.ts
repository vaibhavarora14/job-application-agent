declare module "*/posthog.mjs" {
  export const DEFAULT_POSTHOG_HOST: string;
  export const BROWSER_POSTHOG_INGEST_PATH: string;
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
  export function resolveBrowserPostHogHost(host?: string): string;
  export function resolveCaptureHost(host?: string): string;
  export function isCustomPostHogApiHost(host?: string): boolean;
  export function postHogCaptureUrl(host?: string, path?: string): string;
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

type LandingSessionStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type LandingCaptureTransport = {
  fetchFn?: typeof fetch;
  sendBeacon?: (url: string, data: Blob) => boolean;
  transport?: "fetch" | "beacon";
  pageHost?: string;
  sessionId?: string;
  sessionStore?: LandingSessionStore | null;
  now?: number;
};

declare module "*/landing-analytics.mjs" {
  export const FOUNDING_EVENTS: Readonly<{
    CTA_CLICKED: string;
    CHECKOUT_CREATED: string;
    CHECKOUT_RETURNED: string;
    PAYMENT_CONFIRMED: string;
  }>;
  export const UTM_KEYS: readonly string[];
  export const LANDING_SESSION_STORAGE_KEY: string;
  export const LANDING_SESSION_IDLE_MS: number;
  export const LANDING_SESSION_MAX_MS: number;
  export function extractUtmParams(source: unknown): Record<string, string>;
  export function getOrCreateAnonymousDistinctId(): string;
  export function getOrCreateLandingSessionId(options?: {
    sessionStore?: LandingSessionStore | null;
    now?: number;
  }): string;
  export function uuidv7(timestampMs?: number, randomBytes?: Uint8Array): string;
  export function isUuidV7(value: unknown): value is string;
  export function readUtmFromLocation(search?: string): Record<string, string>;
  export function captureLandingEvent(input: {
    apiKey: string;
    host?: string;
    event: string;
    properties?: Record<string, unknown>;
    distinctId?: string;
  } & LandingCaptureTransport): Promise<{ ok: boolean; skipped: boolean; status?: number; transport?: string }>;
  export function captureLandingPageview(input: {
    apiKey: string;
    host?: string;
    pathname?: string;
    search?: string;
    href?: string;
  } & LandingCaptureTransport): Promise<{ ok: boolean; skipped: boolean; status?: number; transport?: string }>;
  export function captureLandingPageleave(input: {
    apiKey: string;
    host?: string;
    pathname?: string;
    href?: string;
  } & LandingCaptureTransport): Promise<{
    ok: boolean;
    skipped: boolean;
    status?: number;
    transport?: string;
    duplicate?: boolean;
  }>;
  export function bindLandingPageleave(input: {
    apiKey: string;
    host?: string;
    fetchFn?: typeof fetch;
    sendBeacon?: (url: string, data: Blob) => boolean;
    pageHost?: string;
    sessionStore?: LandingSessionStore | null;
    target?: Pick<Window, "addEventListener" | "removeEventListener"> & { document?: Document };
  }): () => void;
  export function resetLandingPageleaveGuard(): void;
  export function resetLandingSessionForTests(): void;
  export function resetLandingAnalyticsStateForTests(): void;
}

declare module "*/landing-web-vitals.mjs" {
  export const WEB_VITALS_FLUSH_MS: number;
  export const WEB_VITALS_MAX_MS: number;
  export function webVitalsToPostHogProperties(
    metrics: Array<{
      name: string;
      value: number;
      rating?: string;
      delta?: number;
      id?: string;
      navigationType?: string;
    }>,
  ): Record<string, unknown>;
  export function bindLandingWebVitals(
    input: {
      apiKey: string;
      host?: string;
      pathname?: string;
      href?: string;
      fetchFn?: typeof fetch;
      sendBeacon?: (url: string, data: Blob) => boolean;
      pageHost?: string;
      sessionStore?: LandingSessionStore | null;
      flushMs?: number;
    },
    observers?: {
      onLCP?: (cb: (metric: { name: string; value: number }) => void) => void;
      onCLS?: (cb: (metric: { name: string; value: number }) => void) => void;
      onINP?: (cb: (metric: { name: string; value: number }) => void) => void;
    },
  ): () => void;
}

declare module "*/posthog-ingest-proxy.mjs" {
  export const POSTHOG_INGEST_PREFIX: string;
  export const POSTHOG_US_ASSETS_HOST: string;
  export const POSTHOG_EU_ASSETS_HOST: string;
  export function isPostHogIngestPath(pathname: string): boolean;
  export function postHogProxyTargets(ingestHost?: string): { ingest: string; assets: string };
  export function postHogProxyUpstreamUrl(requestUrl: string, ingestHost?: string): URL;
  export function shouldForwardPostHogAuthorization(value: string | null): boolean;
  export function proxyPostHogIngest(
    request: Request,
    options?: {
      env?: { POSTHOG_HOST?: string };
      ingestHost?: string;
      fetchFn?: typeof fetch;
    },
  ): Promise<Response>;
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
