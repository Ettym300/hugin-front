type RuntimeEnv = Partial<Record<string, string>>;

declare global {
  interface Window {
    __CONCORD_ENV__?: RuntimeEnv;
  }
}

const runtime = (): RuntimeEnv =>
  typeof window !== "undefined" ? window.__CONCORD_ENV__ || {} : {};

const str = (key: string, fallback = "") => {
  const fromRuntime = runtime()[key];
  if (fromRuntime) return fromRuntime;
  const fromVite = import.meta.env[key];
  if (typeof fromVite === "string" && fromVite) return fromVite;
  return fallback;
};

const withSlash = (url: string) => {
  if (!url) return "";
  return url.endsWith("/") ? url : `${url}/`;
};

const withoutSlash = (url: string) => url.replace(/\/+$/, "");

export default {
  get SERVER_URL() {
    const configured = withoutSlash(str("VITE_SERVER_URL"));
    if (import.meta.env.DEV) return configured;
    if (typeof window !== "undefined") return window.location.origin;
    return configured;
  },
  get WS_URL() {
    const configured = withoutSlash(str("VITE_WS_URL"));
    if (import.meta.env.DEV) return configured;
    if (typeof window !== "undefined") return window.location.origin;
    return configured;
  },
  get APP_URL() {
    const configured = withoutSlash(str("VITE_APP_URL"));
    if (import.meta.env.DEV) return configured || "http://localhost:3000";
    if (typeof window !== "undefined") return window.location.origin;
    return configured;
  },
  get MOBILE_WIDTH() {
    return parseInt(str("VITE_MOBILE_WIDTH", "850"));
  },
  get APP_VERSION() {
    return str("VITE_APP_VERSION") || undefined;
  },
  get DEV_MODE() {
    return str("VITE_DEV_MODE") === "true";
  },
  get MESSAGE_LIMIT() {
    return parseInt(str("VITE_MESSAGE_LIMIT", "50"));
  },
  get TURNSTILE_SITEKEY() {
    return str("VITE_TURNSTILE_SITEKEY");
  },
  get EMOJI_URL() {
    return str("VITE_EMOJI_URL");
  },
  get HUGIN_CDN() {
    const configured = withSlash(str("VITE_HUGIN_CDN"));
    if (configured) return configured;
    if (typeof window !== "undefined") return withSlash(window.location.origin);
    return configured;
  },
  get BUILD_ID() {
    return str("VITE_BUILD_ID");
  },
  get OFFICIAL_SERVER() {
    return str("VITE_OFFICIAL_SERVER", "concord");
  },
  get GOOGLE_CLIENT_ID() {
    return str("VITE_GOOGLE_CLIENT_ID") || undefined;
  },
  get GOOGLE_API_KEY() {
    return str("VITE_GOOGLE_API_KEY") || undefined;
  },
  get RELEASE_TIMESTAMP() {
    return parseInt(str("VITE_RELEASE_TIMESTAMP", "0"));
  },
  get EMAIL_CONFIRMATION_ENABLED() {
    return str("VITE_EMAIL_CONFIRMATION_ENABLED") === "true";
  },
  get LIVEKIT_ENABLED() {
    return str("VITE_LIVEKIT_ENABLED") === "true";
  }
};
