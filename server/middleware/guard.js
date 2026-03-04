import { defineEventHandler, getRequestURL, getHeader } from "h3";
import { isbot } from "isbot";
import { verifySessionToken } from "../utils/session";

const PROTECTED_PATHS = new Set(["/api/ai", "/api/embeddings"]);

export default defineEventHandler((event) => {
  const url = getRequestURL(event);
  const pathname = url.pathname.replace(/\/+$/, '');

  if (!PROTECTED_PATHS.has(pathname)) return;

  const ua = getHeader(event, "user-agent") || "";
  if (isbot(ua)) {
    event.node.res.statusCode = 403;
    return { error: "Forbidden: bot detected" };
  }

  const token = getHeader(event, "x-session-token");
  const config = useRuntimeConfig(event);
  const sessionSecret = config.sessionSecret;
  if (!sessionSecret) {
    event.node.res.statusCode = 500;
    return { error: "Server misconfigured" };
  }

  const payload = verifySessionToken(token, sessionSecret);
  if (!payload) {
    event.node.res.statusCode = 403;
    return { error: "Forbidden: invalid or expired session" };
  }
});
