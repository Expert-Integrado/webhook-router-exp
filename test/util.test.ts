import { describe, it, expect } from "vitest";
import {
  filterHeaders,
  generateToken,
  constantTimeEqual,
  backoffModifier,
  BACKOFF_MINUTES,
  MAX_ATTEMPTS,
  isValidHttpUrl,
} from "../src/util";

describe("filterHeaders", () => {
  it("remove headers técnicos/proxy (case-insensitive) e preserva o resto", () => {
    const headers = new Headers([
      ["Host", "meusite.com"],
      ["Content-Length", "123"],
      ["Connection", "keep-alive"],
      ["Transfer-Encoding", "chunked"],
      ["Expect", "100-continue"],
      ["CF-Connecting-IP", "1.2.3.4"],
      ["cf-ray", "abc123"],
      ["X-Forwarded-For", "1.2.3.4"],
      ["X-Real-IP", "1.2.3.4"],
      ["Content-Type", "application/json"],
      ["Authorization", "Bearer token"],
      ["X-Custom-Header", "valor"],
    ]);

    const filtered = filterHeaders(headers);

    expect(filtered).not.toHaveProperty("host");
    expect(filtered).not.toHaveProperty("content-length");
    expect(filtered).not.toHaveProperty("connection");
    expect(filtered).not.toHaveProperty("transfer-encoding");
    expect(filtered).not.toHaveProperty("expect");
    expect(filtered).not.toHaveProperty("cf-connecting-ip");
    expect(filtered).not.toHaveProperty("cf-ray");
    expect(filtered).not.toHaveProperty("x-forwarded-for");
    expect(filtered).not.toHaveProperty("x-real-ip");

    expect(filtered["content-type"]).toBe("application/json");
    expect(filtered["authorization"]).toBe("Bearer token");
    expect(filtered["x-custom-header"]).toBe("valor");
  });
});

describe("backoffModifier / BACKOFF_MINUTES", () => {
  it("segue a sequência 1min, 5min, 30min, 2h, 6h", () => {
    expect(BACKOFF_MINUTES).toEqual([1, 5, 30, 120, 360]);
    expect(MAX_ATTEMPTS).toBe(5);
    expect(backoffModifier(1)).toBe("+1 minutes");
    expect(backoffModifier(2)).toBe("+5 minutes");
    expect(backoffModifier(3)).toBe("+30 minutes");
    expect(backoffModifier(4)).toBe("+120 minutes");
    expect(backoffModifier(5)).toBe("+360 minutes");
  });
});

describe("generateToken", () => {
  it("gera 32 caracteres url-safe (base62) e valores diferentes a cada chamada", () => {
    const a = generateToken(32);
    const b = generateToken(32);
    expect(a).toHaveLength(32);
    expect(a).toMatch(/^[A-Za-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});

describe("constantTimeEqual", () => {
  it("retorna true para strings iguais e false para diferentes ou de tamanhos diferentes", () => {
    expect(constantTimeEqual("segredo123", "segredo123")).toBe(true);
    expect(constantTimeEqual("segredo123", "segredo124")).toBe(false);
    expect(constantTimeEqual("curta", "muito-mais-longa")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("isValidHttpUrl", () => {
  it("aceita http(s) e rejeita o resto", () => {
    expect(isValidHttpUrl("https://exemplo.com/webhook")).toBe(true);
    expect(isValidHttpUrl("http://exemplo.com")).toBe(true);
    expect(isValidHttpUrl("ftp://exemplo.com")).toBe(false);
    expect(isValidHttpUrl("não é url")).toBe(false);
  });
});
