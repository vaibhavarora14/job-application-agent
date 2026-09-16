export function readJsonRequest(request: Request, maxBytes: number): Promise<
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string }
>;
export function readTextRequest(request: Request, maxBytes: number): Promise<
  | { ok: true; data: string }
  | { ok: false; status: number; error: string }
>;
export function publicSecurityHeaders(): Record<string, string>;
export function attentionPageSecurityHeaders(
  frameSrcOrigins?: string[],
  connectSrcOrigins?: string[],
): Record<string, string>;
export function liveSessionEmbedSecurityHeaders(
  frameSrcOrigins?: string[],
  connectSrcOrigins?: string[],
): Record<string, string>;
export function isAttentionPagePath(pathname: string): boolean;
export function isAttentionLiveSessionEmbedPath(
  pathname: string,
  searchParams?: URLSearchParams,
): boolean;
export function hashRateLimitKey(address: string, scope: string, salt: string): Promise<string>;
export function consumeRateLimit(
  db: D1Database,
  key: string,
  policy: { limit: number; windowSeconds: number; now?: number },
): Promise<{ allowed: boolean; limit: number; remaining: number; retryAfter: number }>;
