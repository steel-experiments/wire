// ABOUTME: Request-origin guard for the console API — rejects cross-origin
// ABOUTME: state-changing requests so remote sites can't forge launches/approvals.

import type { MiddlewareHandler } from "hono";

// URL#hostname strips the brackets from an IPv6 literal, so the loopback
// entry here is "::1", not "[::1]".
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function isLocalOrigin(origin: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export const rejectCrossOriginWrites: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin !== undefined && !isLocalOrigin(origin)) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }
  }
  await next();
};
