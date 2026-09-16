/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
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

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ATTENTION_LIVE_SESSION_BASE_URL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withPublicSecurityHeaders(response, request, env);
    }

    return withPublicSecurityHeaders(await handler.fetch(request, env, ctx), request, env);
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

export default worker;
