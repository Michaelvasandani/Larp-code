export function exactOrigin(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isReservedOrigin(value) {
  const origin = exactOrigin(value);
  if (!origin) return true;
  const url = new URL(origin);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:") return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") return true;
  if (hostname.endsWith(".example") || hostname.endsWith(".invalid") || hostname.endsWith(".test") || hostname.endsWith(".local")) return true;
  if (hostname === "example" || hostname === "invalid" || hostname === "test" || hostname === "local") return true;
  if (/^(10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname)) return true;
  return false;
}

export function releaseOrigin(value) {
  const origin = exactOrigin(value);
  if (!origin || isReservedOrigin(origin)) throw new Error(`release backend origin must be a real public HTTPS origin, got ${String(value)}`);
  return origin;
}
