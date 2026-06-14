// M-UI session auth (design §8) — the simplest single-operator scheme:
// UI_USER / UI_PASS env creds → an HMAC-signed `{exp}` token in an HttpOnly +
// Secure + SameSite=Lax cookie. No DB, no IdP. EventSource cannot set headers,
// so a same-origin cookie is the correct (and only) auth channel for SSE.
//
// When UI_SESSION_SECRET / UI_PASS are unset the console runs OPEN (pass-through)
// so a local single operator needs no secrets; the existing root API contract is
// unaffected either way (only the new UI-namespace endpoints consult this).

import type { Env } from "../env";
import { UnauthorizedError } from "../runtime/errors";

export const SESSION_COOKIE = "ebpmn_session";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h operator session

/** True once the operator has configured real credentials + a signing secret. */
export function authConfigured(env: Env): boolean {
  return Boolean(env.UI_SESSION_SECRET && env.UI_PASS);
}

// ---- base64url (cookie-safe) ----------------------------------------------

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncode(text: string): string {
  return b64urlFromBytes(new TextEncoder().encode(text));
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- HMAC sign / verify ----------------------------------------------------

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Constant-time-ish comparison of two equal-purpose strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Sign `{exp}` and return the `payload.signature` cookie value. */
export async function signToken(secret: string, ttlMs = DEFAULT_TTL_MS): Promise<string> {
  const exp = Date.now() + ttlMs;
  const payload = b64urlEncode(JSON.stringify({ exp }));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

/** Verify a `payload.signature` token: signature valid AND not expired. */
export async function verifyToken(secret: string, token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const key = await hmacKey(secret);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sigB64), new TextEncoder().encode(payload));
  } catch {
    return false;
  }
  if (!ok) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as { exp: number };
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

// ---- Cookie plumbing -------------------------------------------------------

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function cookieAttrs(maxAgeSec: number): string {
  // Lax (not Strict) so a top-level deep-link from Slack/PagerDuty carries the
  // cookie on the first hop; Lax still withholds it on cross-site POST/subresource
  // so the SPA's same-origin XHR cancel/retry keep CSRF protection (design §8).
  return `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function buildSetCookie(token: string, ttlMs = DEFAULT_TTL_MS): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttrs(Math.floor(ttlMs / 1000))}`;
}

export function clearSetCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttrs(0)}`;
}

// ---- Request guards --------------------------------------------------------

/** True when the request carries a valid session (or auth is not configured). */
export async function hasValidSession(env: Env, request: Request): Promise<boolean> {
  if (!authConfigured(env)) return true; // open console (no secrets configured)
  return verifyToken(env.UI_SESSION_SECRET!, readCookie(request, SESSION_COOKIE));
}

/** Throw 401 unless the request carries a valid session. No-op when auth is open. */
export async function requireSession(env: Env, request: Request): Promise<void> {
  if (await hasValidSession(env, request)) return;
  throw new UnauthorizedError("Operator session required. POST /ui/login first.");
}

/** Timing-safe credential check against the env operator credentials. */
export function credentialsMatch(env: Env, user: string, pass: string): boolean {
  if (!env.UI_USER || !env.UI_PASS) return false;
  // Evaluate both comparisons (no short-circuit) so timing does not leak which field differed.
  const userOk = safeEqual(user, env.UI_USER);
  const passOk = safeEqual(pass, env.UI_PASS);
  return userOk && passOk;
}
