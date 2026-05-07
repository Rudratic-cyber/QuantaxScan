type AppConfig = {
  apiBaseUrl?: string;
};

declare global {
  interface Window {
    __APP_CONFIG__?: AppConfig;
  }
}

function normalizeBaseUrl(value?: string | null): string {
  if (!value) return "";
  return value.replace(/\/+$/, "");
}

export function getApiBaseUrl(): string {
  if (typeof window === "undefined") return "";
  const runtime = window.__APP_CONFIG__?.apiBaseUrl;
  const env = import.meta.env.VITE_API_BASE_URL as string | undefined;
  return normalizeBaseUrl(runtime || env || "");
}

export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  if (!base) return path;
  if (!path.startsWith("/")) return `${base}/${path}`;
  return `${base}${path}`;
}
