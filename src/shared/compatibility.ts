import type { CompatibilityMetadata } from "./protocol";

/**
 * Compares the deliberately small dotted numeric versions shipped by the
 * extension and backend. Pre-release/build metadata is not part of the
 * compatibility contract, so malformed values are treated as incompatible.
 */
export function compareClientVersions(left: string, right: string): -1 | 0 | 1 {
  const parse = (value: string): number[] | null => {
    if (!/^\d+(?:\.\d+){0,3}$/.test(value)) return null;
    return value.split(".").map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return -1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export function requiresClientUpdate(
  compatibility: Pick<CompatibilityMetadata, "minimumClientVersion">,
  clientVersion: string,
): boolean {
  return compareClientVersions(clientVersion, compatibility.minimumClientVersion) < 0;
}
