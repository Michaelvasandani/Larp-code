function decodeSegment(segment, label) {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`publishable key ${label} is not valid base64url JSON: ${error.message}`);
  }
}

/**
 * Validate the signed, public Supabase JWT shape used by this release.
 * Signature verification is intentionally not attempted: the public key is
 * verified for its non-privileged claims and Supabase verifies the signature.
 */
export function validatePublishableKey(value) {
  if (typeof value !== "string" || value.length < 40 || value.length > 4096 || /\s/.test(value)) {
    throw new Error("publishable key must be a compact JWT without whitespace");
  }
  if (/service[_-]?role/i.test(value)) {
    throw new Error("publishable key contains a service_role marker");
  }
  if (value.startsWith("sb_publishable_")) {
    throw new Error("modern non-JWT publishable key format is not accepted until verified safe");
  }
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("publishable key must be a three-segment JWT; modern formats require separate verification");
  }
  const header = decodeSegment(parts[0], "header");
  const claims = decodeSegment(parts[1], "claims");
  if (header.alg === "none" || typeof header.alg !== "string") throw new Error("publishable key JWT algorithm is unsafe");
  if (claims.role !== "anon" && claims.role !== "publishable") {
    throw new Error(`publishable key JWT role must be anon or publishable, got ${String(claims.role)}`);
  }
  if (claims.role === "service_role") throw new Error("service_role JWTs are forbidden");
  if (claims.exp !== undefined && (!Number.isInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000))) {
    throw new Error("publishable key JWT is expired");
  }
  return { header, role: claims.role, claims };
}
