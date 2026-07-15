import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { installFetchMock, mockFetchOnce, assertNoPendingMocks } from "./fetch-mock";

beforeAll(() => {
  installFetchMock();
});

afterEach(() => {
  assertNoPendingMocks();
});

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createEndpoint(name = "endpoint-teste") {
  const token = "tok" + Math.random().toString(36).slice(2, 12);
  return (await env.DB.prepare(
    "INSERT INTO endpoints (name, token, signing_secret) VALUES (?, ?, lower(hex(randomblob(32)))) RETURNING id, token"
  )
    .bind(name, token)
    .first<{ id: number; token: string }>())!;
}

async function createDestination(endpointId: number, url: string) {
  return (await env.DB.prepare(
    "INSERT INTO destinations (endpoint_id, url, timeout_ms) VALUES (?, ?, 5000) RETURNING id"
  )
    .bind(endpointId, url)
    .first<{ id: number }>())!.id;
}

describe("POST/GET/etc /in/:token — ingestão e fan-out", () => {
  it("token inexistente responde 404", async () => {
    const res = await call(new Request("https://router.test/in/token-que-nao-existe", { method: "POST" }));
    expect(res.status).toBe(404);
  });

  it("token de endpoint desativado responde 404", async () => {
    const endpoint = await createEndpoint();
    await env.DB.prepare("UPDATE endpoints SET active = 0 WHERE id = ?").bind(endpoint.id).run();
    const res = await call(new Request(`https://router.test/in/${endpoint.token}`, { method: "POST" }));
    expect(res.status).toBe(404);
  });

  it("responde 200 imediato e faz fan-out para 2 destinos preservando método, query, headers e body", async () => {
    const endpoint = await createEndpoint();
    await createDestination(endpoint.id, "https://dest1.example.com/webhook");
    await createDestination(endpoint.id, "https://dest2.example.com/webhook");

    const rawBody = JSON.stringify({ hello: "mundo" });

    mockFetchOnce({
      url: "https://dest1.example.com/webhook?foo=bar",
      method: "POST",
      body: rawBody,
      headers: { "x-custom-header": "abc" },
      status: 200,
      responseBody: "ok",
    });
    mockFetchOnce({
      url: "https://dest2.example.com/webhook?foo=bar",
      method: "POST",
      body: rawBody,
      status: 200,
      responseBody: "ok",
    });

    const req = new Request(`https://router.test/in/${endpoint.token}?foo=bar`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-custom-header": "abc" },
      body: rawBody,
    });

    const res = await call(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; event_id: number };
    expect(json.ok).toBe(true);
    expect(typeof json.event_id).toBe("number");

    const { results: deliveries } = await env.DB.prepare(
      "SELECT status FROM deliveries WHERE event_id = ?"
    )
      .bind(json.event_id)
      .all<{ status: string }>();

    expect(deliveries).toHaveLength(2);
    expect(deliveries!.every((d) => d.status === "success")).toBe(true);
  });

  it("destino que responde 500 vira delivery 'failed' com next_retry_at agendado", async () => {
    const endpoint = await createEndpoint();
    await createDestination(endpoint.id, "https://dest-com-erro.example.com/webhook");

    mockFetchOnce({
      url: "https://dest-com-erro.example.com/webhook",
      method: "POST",
      status: 500,
      responseBody: "erro interno",
    });

    const req = new Request(`https://router.test/in/${endpoint.token}`, {
      method: "POST",
      body: "{}",
    });
    const res = await call(req);
    const json = (await res.json()) as { event_id: number };

    const delivery = await env.DB.prepare(
      "SELECT status, attempt_count, last_status_code, next_retry_at FROM deliveries WHERE event_id = ?"
    )
      .bind(json.event_id)
      .first<{ status: string; attempt_count: number; last_status_code: number; next_retry_at: string | null }>();

    expect(delivery!.status).toBe("failed");
    expect(delivery!.attempt_count).toBe(1);
    expect(delivery!.last_status_code).toBe(500);
    expect(delivery!.next_retry_at).not.toBeNull();
  });

  it("destino com query própria preserva os parâmetros e recebe também os do evento", async () => {
    const endpoint = await createEndpoint();
    await createDestination(endpoint.id, "https://dest.example.com/webhook?apikey=abc");

    mockFetchOnce({
      url: "https://dest.example.com/webhook?apikey=abc&foo=bar",
      method: "POST",
      status: 200,
      responseBody: "ok",
    });

    const res = await call(
      new Request(`https://router.test/in/${endpoint.token}?foo=bar`, { method: "POST", body: "{}" })
    );
    expect(res.status).toBe(200);
  });

  it("destino pausado (active=0) não recebe delivery", async () => {
    const endpoint = await createEndpoint();
    const destId = await createDestination(endpoint.id, "https://dest-pausado.example.com/webhook");
    await env.DB.prepare("UPDATE destinations SET active = 0 WHERE id = ?").bind(destId).run();

    const req = new Request(`https://router.test/in/${endpoint.token}`, { method: "GET" });
    const res = await call(req);
    const json = (await res.json()) as { event_id: number };

    const { results } = await env.DB.prepare("SELECT id FROM deliveries WHERE event_id = ?")
      .bind(json.event_id)
      .all();
    expect(results).toHaveLength(0);
  });
});
