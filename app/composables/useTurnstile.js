const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_CONTAINER_ID = "__turnstile-container";

let loadPromise = null;
let activeWidgetId = null;

function loadTurnstile() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Turnstile is only available in browser"));
  }

  if (window.turnstile) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector(
      `script[src^="${TURNSTILE_SCRIPT_SRC.split("?")[0]}"]`,
    );

    if (existingScript) {
      existingScript.addEventListener("load", () => {
        if (window.turnstile) resolve();
        else reject(new Error("Turnstile script loaded but API unavailable"));
      });
      existingScript.addEventListener("error", () => {
        reject(new Error("Failed to load Turnstile script"));
      });
      return;
    }

    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.turnstile) resolve();
      else reject(new Error("Turnstile script loaded but API unavailable"));
    };
    script.onerror = () => reject(new Error("Failed to load Turnstile script"));
    document.head.appendChild(script);
  });

  return loadPromise;
}

function getContainer() {
  let container = document.getElementById(TURNSTILE_CONTAINER_ID);
  if (container) return container;

  container = document.createElement("div");
  container.id = TURNSTILE_CONTAINER_ID;
  container.style.position = "fixed";
  container.style.left = "-9999px";
  container.style.top = "-9999px";
  container.style.width = "1px";
  container.style.height = "1px";
  container.style.opacity = "0";
  container.style.pointerEvents = "none";
  container.style.overflow = "hidden";
  container.setAttribute("aria-hidden", "true");
  document.body.appendChild(container);
  return container;
}

/**
 * Renders an invisible Turnstile widget and resolves with the token.
 * @returns {Promise<string>}
 */
export async function solveTurnstile() {
  const siteKey = useRuntimeConfig().public.turnstileSiteKey;
  if (!siteKey) {
    throw new Error("Turnstile site key is missing");
  }

  await loadTurnstile();

  const container = getContainer();

  if (activeWidgetId !== null) {
    window.turnstile.remove(activeWidgetId);
    activeWidgetId = null;
  }

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const logWaitTime = (status) => {
      const elapsedMs = Math.round(performance.now() - startedAt);
      console.info(`[Turnstile] ${status} after ${elapsedMs}ms`);
    };

    activeWidgetId = window.turnstile.render(container, {
      sitekey: siteKey,
      size: "invisible",
      appearance: "interaction-only",
      execution: "execute",
      callback: (token) => {
        logWaitTime("response received");
        resolve(token);
      },
      "error-callback": () => {
        logWaitTime("error");
        reject(new Error("Turnstile challenge failed"));
      },
      "expired-callback": () => {
        logWaitTime("expired");
        reject(new Error("Turnstile token expired"));
      },
    });

    window.turnstile.execute(activeWidgetId);
  });
}
