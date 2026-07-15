import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createSessionCookie, isSessionValid } from "../src/auth";

function extractCookieValue(setCookie: string): string {
  return setCookie.split(";")[0].split("=").slice(1).join("=");
}

describe("cookie de sessão HMAC", () => {
  it("cookie recém-criado é válido", async () => {
    const cookie = await createSessionCookie(env);
    const value = extractCookieValue(cookie);
    expect(await isSessionValid(env, `session=${value}`)).toBe(true);
  });

  it("assinatura errada é inválida", async () => {
    const cookie = await createSessionCookie(env);
    const value = extractCookieValue(cookie);
    const [exp] = value.split(".");
    const forged = `${exp}.assinatura-invalida`;
    expect(await isSessionValid(env, `session=${forged}`)).toBe(false);
  });

  it("cookie expirado é inválido", async () => {
    const expiredExp = Math.floor(Date.now() / 1000) - 10;
    // reconstrói um cookie com exp no passado, assinado com a mesma chave derivada
    const key = await crypto.subtle.importKey(
      "raw",
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("session-v1:" + env.ADMIN_PASSWORD)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(expiredExp)));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await isSessionValid(env, `session=${expiredExp}.${sigB64}`)).toBe(false);
  });

  it("sem cookie é inválido", async () => {
    expect(await isSessionValid(env, null)).toBe(false);
  });
});
