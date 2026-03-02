import { defineEventHandler, readBody } from "h3";
import { signSessionToken } from "../utils/session";

// Client refreshes 60s before expiry (REFRESH_BUFFER_MS in composables/useSession.js)
const SESSION_TTL_MS = 8 * 60 * 1000; // 8 minutes

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const turnstileToken = body?.turnstileToken;

  if (!turnstileToken) {
    event.node.res.statusCode = 400;
    return { error: "Missing Turnstile token" };
  }

  const config = useRuntimeConfig(event);
  const turnstileSecret = config.turnstileSecretKey;
  const sessionSecret = config.sessionSecret;

  if (!turnstileSecret || !sessionSecret) {
    event.node.res.statusCode = 500;
    return { error: "Server misconfigured" };
  }

  const verifyResponse = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: turnstileSecret,
        response: turnstileToken,
      }),
    },
  );

  const result = await verifyResponse.json();

  if (!result.success) {
    event.node.res.statusCode = 403;
    return { error: "Turnstile verification failed" };
  }

  const expiresAt = Date.now() + SESSION_TTL_MS;
  const sessionToken = signSessionToken({ exp: expiresAt }, sessionSecret);

  return { sessionToken, expiresAt };
});
