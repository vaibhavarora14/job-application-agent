/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { publicSecurityHeaders } from "../lib/public-boundary.mjs";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
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
      return withPublicSecurityHeaders(response);
    }

    const appRequest = withTrustedCountry(request);
    const response = withPublicSecurityHeaders(await handler.fetch(appRequest, env, ctx));
    if (url.pathname !== "/") return response;
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("vary", "CF-IPCountry");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

function withTrustedCountry(request: Request) {
  const country = (request as Request & { cf?: { country?: string } }).cf?.country;
  const headers = new Headers(request.headers);
  headers.delete("x-jobappagent-country");
  if (typeof country === "string" && /^[a-z]{2}$/i.test(country)) {
    headers.set("x-jobappagent-country", country.toUpperCase());
  }
  return new Request(request, { headers });
}

function withPublicSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(publicSecurityHeaders())) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default worker;
