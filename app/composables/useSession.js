import { solveTurnstile } from "~/composables/useTurnstile";

// Must be less than SESSION_TTL_MS (8 min) in server/api/session.post.js
const REFRESH_BUFFER_MS = 60 * 1000; // Refresh 60s before expiry
const SESSION_STORAGE_KEY = "__libre_session_v1";

let _sessionToken = null;
let _expiresAt = 0;
let _pending = null; // In-flight promise to avoid duplicate requests
let _hydrated = false;

function readStoredSession() {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.sessionToken !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function persistSession(sessionToken, expiresAt) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ sessionToken, expiresAt }),
    );
  } catch {
    // Ignore storage failures and continue with in-memory state.
  }
}

function clearPersistedSession() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function hydrateSessionFromStorage() {
  if (_hydrated) return;
  _hydrated = true;

  const stored = readStoredSession();
  if (!stored) return;

  _sessionToken = stored.sessionToken;
  _expiresAt = stored.expiresAt;
}

/**
 * Exchanges a Turnstile token for a signed session token.
 * @param {string} turnstileToken
 * @returns {Promise<{sessionToken: string, expiresAt: number}>}
 */
async function exchangeForSession(turnstileToken) {
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnstileToken }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Session exchange failed (${res.status})`);
  }

  return res.json();
}

/**
 * Returns a valid session token, refreshing via Turnstile if needed.
 * Multiple concurrent callers share the same in-flight request.
 * @returns {Promise<string>} The session token header value
 */
export async function getSessionToken() {
  hydrateSessionFromStorage();

  if (_sessionToken && Date.now() < _expiresAt - REFRESH_BUFFER_MS) {
    return _sessionToken;
  }

  if (_pending) return _pending;

  _pending = (async () => {
    try {
      if (_expiresAt && Date.now() >= _expiresAt) {
        _sessionToken = null;
        _expiresAt = 0;
        clearPersistedSession();
      }

      const turnstileToken = await solveTurnstile();
      const { sessionToken, expiresAt } =
        await exchangeForSession(turnstileToken);
      _sessionToken = sessionToken;
      _expiresAt = expiresAt;
      persistSession(_sessionToken, _expiresAt);
      return _sessionToken;
    } catch (error) {
      _sessionToken = null;
      _expiresAt = 0;
      clearPersistedSession();
      throw error;
    } finally {
      _pending = null;
    }
  })();

  return _pending;
}
