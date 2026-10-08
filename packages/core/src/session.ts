// Opaque session tokens. The client holds the token; we store only its
// SHA-256, so a database leak doesn't hand out live sessions.

export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function newSessionToken(): string {
  return `bps_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const isWellFormedSessionToken = (t: unknown): t is string =>
  typeof t === "string" && /^bps_[A-Za-z0-9_-]{43}$/.test(t);
