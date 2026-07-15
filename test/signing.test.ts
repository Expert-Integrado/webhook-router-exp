// F3 — assinatura HMAC de saída: header presente em fan-out e retry,
// verificável recalculando com o secret, assinada sobre o body final (pós-transform).

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  createScheduledController,
} from "cloudflare:test";
import worker from "../src/index";
import { generateSigningSecret, signPayload } from "../src/signing";
import { installFetchMock, assertNoPendingMocks } from "./fetch-mock";

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

async function createEndpoint(signingSecret = "segredo-de-teste-fixo") {
  const token = "tok" + Math.random().toString(36).slice(2, 12);
  return (await env.DB.prepare(
    "INSERT INTO endpoints (name, token, signing_secret) VALUES ('ep-sign', ?, ?) RETURNING id, token, signing_secret"
  )
    .bind(token, signingSecret)
    .first<{ id: number; token: string; signing_secret: string }>())!;
}

async function createDestination(
  endpointId: number,
  url: string,
  extra: { transform_json?: string } = {}
) {
  return (await env.DB.prepare(
    "INSERT INTO destinations (endpoint_id, url, timeout_ms, transform_json) VALUES (?, ?, 5000, ?) RETURNING id"
  )
    .bind(endpointId, url, extra.transform_json ?? null)
    .first<{ id: number }>())!.id;
}

/** Captura o Request enviado ao destino sem depender do fetch-mock compartilhado. */
async function captureOutgoingRequest(run: () => Promise<Response>): Promise<{
  response: Response;
  headers: Headers;
  bodyText: string;
}> {
  const original = globalThis.fetch;
  let capturedHeaders: Headers = new Headers();
  let capturedBody: BodyInit | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers);
    capturedBody = init?.body as BodyInit | undefined;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const response = await run();
  globalThis.fetch = original;

  const bodyText = capturedBody ? await new Response(capturedBody).text() : "";
  return { response, headers: capturedHeaders, bodyText };
}

describe("generateSigningSecret", () => {
  it("gera 64 chars hex minúsculo e valores diferentes a cada chamada", () => {
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    expect(a).toHaveLength(64);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("signPayload", () => {
  it("body vazio assina apenas '<timestamp>.'", async () => {
    const sigWithNull = await signPayload("segredo", 1000, null);
    const sigWithEmptyPrefix = await signPayload("segredo", 1000, new TextEncoder().encode("").buffer as ArrayBuffer);
    expect(sigWithNull).toBe(sigWithEmptyPrefix);
    expect(sigWithNull).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mudar o body ou o secret muda a assinatura", async () => {
    const base = await signPayload("segredo", 1000, new TextEncoder().encode('{"a":1}').buffer as ArrayBuffer);
    const otherBody = await signPayload("segredo", 1000, new TextEncoder().encode('{"a":2}').buffer as ArrayBuffer);
    const otherSecret = await signPayload("outro-segredo", 1000, new TextEncoder().encode('{"a":1}').buffer as ArrayBuffer);
    expect(base).not.toBe(otherBody);
    expect(base).not.toBe(otherSecret);
  });
});

describe("assinatura HMAC no fan-out e no retry (F3)", () => {
  it("fan-out inclui X-Webhook-Router-Timestamp/Signature verificáveis com o signing_secret do endpoint", async () => {
    const endpoint = await createEndpoint("segredo-fan-out");
    await createDestination(endpoint.id, "https://sign-fanout.example.com/hook");

    const rawBody = '{"hello":"mundo"}';
    const { response, headers, bodyText } = await captureOutgoingRequest(() =>
      call(new Request(`https://router.test/in/${endpoint.token}`, { method: "POST", body: rawBody }))
    );
    expect(response.status).toBe(200); // resposta do próprio /in/:token (200 imediato)
    expect(bodyText).toBe(rawBody);

    const timestamp = headers.get("X-Webhook-Router-Timestamp");
    const signature = headers.get("X-Webhook-Router-Signature");
    expect(timestamp).toMatch(/^\d+$/);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);

    const expected = await signPayload(
      endpoint.signing_secret,
      Number(timestamp),
      new TextEncoder().encode(bodyText).buffer as ArrayBuffer
    );
    expect(signature).toBe(`sha256=${expected}`);
  });

  it("retry cron assina novamente com o mesmo signing_secret do endpoint", async () => {
    const endpoint = await createEndpoint("segredo-retry");
    const destId = await createDestination(endpoint.id, "https://sign-retry.example.com/hook");

    const event = (await env.DB.prepare(
      `INSERT INTO events (endpoint_id, method, query, headers, body, body_truncated)
       VALUES (?, 'POST', '', '{}', ?, 0) RETURNING id`
    )
      .bind(endpoint.id, new TextEncoder().encode('{"x":1}').buffer as ArrayBuffer)
      .first<{ id: number }>())!;
    await env.DB.prepare(
      `INSERT INTO deliveries (event_id, destination_id, status, attempt_count, next_retry_at)
       VALUES (?, ?, 'failed', 1, datetime('now', '-1 minute'))`
    )
      .bind(event.id, destId)
      .run();

    const { headers, bodyText } = await captureOutgoingRequest(async () => {
      const ctx = createExecutionContext();
      const controller = createScheduledController({ cron: "* * * * *" });
      await worker.scheduled!(controller, env, ctx);
      await waitOnExecutionContext(ctx);
      return new Response();
    });

    const timestamp = headers.get("X-Webhook-Router-Timestamp");
    const signature = headers.get("X-Webhook-Router-Signature");
    expect(timestamp).toMatch(/^\d+$/);

    const expected = await signPayload(
      endpoint.signing_secret,
      Number(timestamp),
      new TextEncoder().encode(bodyText).buffer as ArrayBuffer
    );
    expect(signature).toBe(`sha256=${expected}`);
  });

  it("assina sobre o body pós-transformação, não o original", async () => {
    const endpoint = await createEndpoint("segredo-transform");
    await createDestination(endpoint.id, "https://sign-transform.example.com/hook", {
      transform_json: JSON.stringify({ mode: "pick", paths: ["a"] }),
    });

    const rawBody = '{"a":1,"b":"não deveria ir"}';
    const { headers, bodyText } = await captureOutgoingRequest(() =>
      call(new Request(`https://router.test/in/${endpoint.token}`, { method: "POST", body: rawBody }))
    );

    expect(bodyText).toBe(JSON.stringify({ a: 1 })); // body final = pós-transform

    const timestamp = headers.get("X-Webhook-Router-Timestamp");
    const signature = headers.get("X-Webhook-Router-Signature");
    const expectedOverFinalBody = await signPayload(
      endpoint.signing_secret,
      Number(timestamp),
      new TextEncoder().encode(bodyText).buffer as ArrayBuffer
    );
    const expectedOverOriginalBody = await signPayload(
      endpoint.signing_secret,
      Number(timestamp),
      new TextEncoder().encode(rawBody).buffer as ArrayBuffer
    );
    expect(signature).toBe(`sha256=${expectedOverFinalBody}`);
    expect(signature).not.toBe(`sha256=${expectedOverOriginalBody}`);
  });
});
