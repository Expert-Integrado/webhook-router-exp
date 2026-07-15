// Sessão do painel: cookie HMAC-SHA256 derivado de SHA-256("session-v1:"+ADMIN_PASSWORD).
// Única fonte de segredo: ADMIN_PASSWORD.

import type { Context, Next } from "hono";
import type { Env } from "./util";

const COOKIE_NAME = "session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 dias

async function deriveKey(adminPassword: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("session-v1:" + adminPassword)
  );
  return crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function toBase64Url(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function createSessionCookie(env: Env): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const key = await deriveKey(env.ADMIN_PASSWORD);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(exp)));
  const value = `${exp}.${toBase64Url(sig)}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function expireSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function isSessionValid(env: Env, cookieHeader: string | null): Promise<boolean> {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;

  const [expStr, sigStr] = match[1].split(".");
  if (!expStr || !sigStr) return false;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;

  try {
    const key = await deriveKey(env.ADMIN_PASSWORD);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(sigStr),
      new TextEncoder().encode(expStr)
    );
  } catch {
    return false;
  }
}

/** Middleware: exige sessão válida em todo /api/*, exceto /api/login. */
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  if (c.req.path === "/api/login" || c.req.path === "/api/setup-status") return next();

  const valid = await isSessionValid(c.env, c.req.header("Cookie") ?? null);
  if (!valid) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
}
