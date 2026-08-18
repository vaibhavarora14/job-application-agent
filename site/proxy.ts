import { NextRequest, NextResponse } from "next/server";

const STATS_HOST = "stats.jobappagent.com";
const PRODUCT_HOSTS = new Set(["jobappagent.com", "www.jobappagent.com"]);

export function proxy(request: NextRequest) {
  const hostname = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(":")[0];
  const pathname = request.nextUrl.pathname;
  if (hostname === STATS_HOST && pathname === "/") {
    return NextResponse.rewrite(new URL("/community-view", request.url));
  }
  if (PRODUCT_HOSTS.has(hostname) && pathname === "/community") {
    return NextResponse.redirect("https://stats.jobappagent.com/", 308);
  }
  if (PRODUCT_HOSTS.has(hostname) && pathname === "/community-view") {
    return NextResponse.redirect("https://stats.jobappagent.com/", 308);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/", "/community", "/community-view"] };
