// Mock simples de fetch global para os testes de integração.
// Substitui o antigo `fetchMock` de "cloudflare:test", removido a partir da
// v0.13 do @cloudflare/vitest-pool-workers (upgrade para Vitest 4) — a
// solução oficial agora é mockar globalThis.fetch diretamente.

import { expect } from "vitest";

interface MockExpectation {
  /** URL completa esperada (com query string), ex.: "https://dest.example.com/webhook?a=1" */
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  status: number;
  responseBody?: string;
}

const queue: MockExpectation[] = [];

/** Registra a resposta mockada para a próxima chamada de fetch que bater com a URL. */
export function mockFetchOnce(exp: MockExpectation): void {
  queue.push(exp);
}

/** Substitui o fetch global pelo mock. Chamar uma vez em beforeAll. */
export function installFetchMock(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const idx = queue.findIndex((e) => e.url === url);
    if (idx === -1) {
      throw new Error(`fetch inesperado (sem mock registrado): ${url}`);
    }
    const [expected] = queue.splice(idx, 1);

    if (expected.method) expect(init?.method ?? "GET").toBe(expected.method);
    if (expected.headers) {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(expected.headers)) {
        expect(headers.get(key)).toBe(value);
      }
    }
    if (expected.body !== undefined) {
      const bodyText = init?.body ? await new Response(init.body as BodyInit).text() : "";
      expect(bodyText).toBe(expected.body);
    }

    return new Response(expected.responseBody ?? "", { status: expected.status });
  }) as typeof fetch;
}

/** Garante que todas as expectativas registradas foram consumidas. Chamar em afterEach. */
export function assertNoPendingMocks(): void {
  const leftover = queue.length;
  queue.length = 0;
  if (leftover > 0) {
    throw new Error(`${leftover} mock(s) de fetch não consumido(s)`);
  }
}
