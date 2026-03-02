import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signs a payload with HMAC-SHA256 and returns a token string.
 * Format: base64url(payload).base64url(signature)
 * @param {object} payload
 * @param {string} secret
 * @returns {string}
 */
export function signSessionToken(payload, secret) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

/**
 * Verifies and decodes a session token.
 * Returns the payload if valid & not expired, otherwise null.
 * @param {string} token
 * @param {string} secret
 * @returns {object|null}
 */
export function verifySessionToken(token, secret) {
  if (!token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, sig] = parts;

  const expectedSig = createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");

  const sigBuf = Buffer.from(sig, "base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
