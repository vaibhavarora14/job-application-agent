import * as Sentry from "@sentry/cloudflare";
import handler from "vinext/server/app-router-entry";
import {
  attentionPageSecurityHeaders,
  isAttentionLiveSessionEmbedPath,
  isAttentionPagePath,
  liveSessionEmbedSecurityHeaders,
  publicSecurityHeaders,
} from "../lib/public-boundary.mjs";
import {
  liveSessionConnectSrcOrigins,
  liveSessionFrameSrcOrigins,
} from "../lib/attention-live-session.mjs";
import { captureApiServerError, siteSentryOptions } from "../lib/sentry.mjs";
import { serveFreshEdgeCacheHit, serveWithEdgeCache, withSharedProxyNoStore } from "../lib/edge-cache.mjs";
import { workersDefaultCache } from "../lib/workers-cache";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  PUBLIC_SITE_URL?: string;
  ATTENTION_LIVE_SESSION_BASE_URL?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Public documents (/, /jobs, /jobs/<slug>, ...) use Cache API + SWR so crawler
    // traffic is served from cache (HIT/STALE) instead of re-running SSR each time.
    // Vercel's external-rewrite cache keys on the workers.dev destination, not the
    // public host, so it must never store a Worker response (stats `/` vs apex `/`):
    // every response leaves with Vercel-CDN-Cache-Control: private, no-store.
    return withSharedProxyNoStore(await serveWithEdgeCache(request, {
      cache: workersDefaultCache(),
      release: env.SENTRY_RELEASE,
      waitUntil: (promise) => ctx.waitUntil(promise),
      render: async (renderRequest = request) => {
        const secured = withPublicSecurityHeaders(
          await handler.fetch(renderRequest, env, ctx),
          renderRequest,
          env,
        );
        captureApiServerError(renderRequest, secured);
        return secured;
      },
    }));
  },
};

function withPublicSecurityHeaders(response: Response, request: Request, env: Env) {
  const url = new URL(request.url);
  const headers = new Headers(response.headers);
  const liveBase = env.ATTENTION_LIVE_SESSION_BASE_URL ?? "";
  const frameSrc = liveSessionFrameSrcOrigins(liveBase);
  const connectSrc = liveSessionConnectSrcOrigins(liveBase);
  let security: Record<string, string>;
  if (isAttentionLiveSessionEmbedPath(url.pathname, url.searchParams)) {
    // Embed shell: may be framed by attention page; may frame noVNC.
    security = liveSessionEmbedSecurityHeaders(frameSrc, connectSrc);
  } else if (isAttentionPagePath(url.pathname)) {
    // Attention document: iframe embed shell (and optionally noVNC after 302).
    security = attentionPageSecurityHeaders(frameSrc, connectSrc);
  } else {
    security = publicSecurityHeaders();
  }
  for (const [name, value] of Object.entries(security)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const sentryWorker = Sentry.withSentry((env: Env) => siteSentryOptions(env), worker);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Fresh edge-cache hits skip Sentry's per-request setup and the app wrapper (CPU on
    // Workers Free). Same response as the HIT branch of serveWithEdgeCache; anything else
    // (stale, miss, bypass, errors) takes the full Sentry-wrapped path below.
    const hit = await serveFreshEdgeCacheHit(request, { cache: workersDefaultCache(), release: env.SENTRY_RELEASE });
    if (hit) return withSharedProxyNoStore(hit);
    return sentryWorker.fetch!(request, env, ctx);
  },
};
