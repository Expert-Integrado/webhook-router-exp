import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  createScheduledController,
} from "cloudflare:test";
import worker from "../src/index";
import { installFetchMock, mockFetchOnce, assertNoPendingMocks } from "./fetch-mock";

beforeAll(() => {
  installFetchMock();
});

afterEach(() => {
  assertNoPendingMocks();
});

async function runScheduled(cron: string) {
  const ctx = createExecutionContext();
  const controller = createScheduledController({ cron });
  await worker.scheduled!(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

async function seedEndpointAndDestination(url: string) {
  const endpoint = (await env.DB.prepare(
    "INSERT INTO endpoints (name, token, signing_secret) VALUES ('ep', 'tok-' || abs(random()), lower(hex(randomblob(32)))) RETURNING id"
  ).first<{ id: number }>())!;
  const dest = (await env.DB.prepare(
    "INSERT INTO destinations (endpoint_id, url, timeout_ms) VALUES (?, ?, 5000) RETURNING id"
  )
    .bind(endpoint.id, url)
    .first<{ id: number }>())!;
  return { endpointId: endpoint.id, destId: dest.id };
}

async function seedEventAndFailedDelivery(
  endpointId: number,
  destId: number,
  attemptCount: number
) {
  const event = (await env.DB.prepare(
    `INSERT INTO events (endpoint_id, method, query, headers, body, body_truncated)
     VALUES (?, 'POST', '', '{}', ?, 0) RETURNING id`
  )
    .bind(endpointId, new TextEncoder().encode("{}").buffer)
    .first<{ id: number }>())!;

  const delivery = (await env.DB.prepare(
    `INSERT INTO deliveries (event_id, destination_id, status, attempt_count, next_retry_at)
     VALUES (?, ?, 'failed', ?, datetime('now', '-1 minute')) RETURNING id`
  )
    .bind(event.id, destId, attemptCount)
    .first<{ id: number }>())!;

  return { eventId: event.id, deliveryId: delivery.id };
}

describe("cron de retry (* * * * *)", () => {
  it("reprocessa delivery 'failed' e marca 'success' quando o destino responde 2xx", async () => {
    const { endpointId, destId } = await seedEndpointAndDestination("https://retry-ok.example.com/hook");
    const { deliveryId } = await seedEventAndFailedDelivery(endpointId, destId, 1);

    mockFetchOnce({ url: "https://retry-ok.example.com/hook", method: "POST", status: 200, responseBody: "ok" });

    await runScheduled("* * * * *");

    const delivery = await env.DB.prepare(
      "SELECT status, next_retry_at FROM deliveries WHERE id = ?"
    )
      .bind(deliveryId)
      .first<{ status: string; next_retry_at: string | null }>();

    expect(delivery!.status).toBe("success");
    expect(delivery!.next_retry_at).toBeNull();
  });

  it("5ª falha consecutiva marca delivery como 'exhausted'", async () => {
    const { endpointId, destId } = await seedEndpointAndDestination("https://sempre-falha.example.com/hook");
    // já teve 4 tentativas falhas; esta é a 5ª
    const { deliveryId } = await seedEventAndFailedDelivery(endpointId, destId, 4);

    mockFetchOnce({ url: "https://sempre-falha.example.com/hook", method: "POST", status: 500, responseBody: "erro" });

    await runScheduled("* * * * *");

    const delivery = await env.DB.prepare(
      "SELECT status, attempt_count, next_retry_at FROM deliveries WHERE id = ?"
    )
      .bind(deliveryId)
      .first<{ status: string; attempt_count: number; next_retry_at: string | null }>();

    expect(delivery!.status).toBe("exhausted");
    expect(delivery!.attempt_count).toBe(5);
    expect(delivery!.next_retry_at).toBeNull();
  });

  it("destino desativado nesse meio-tempo é marcado 'exhausted' sem tentar entregar", async () => {
    const { endpointId, destId } = await seedEndpointAndDestination("https://vai-ser-pausado.example.com/hook");
    await env.DB.prepare("UPDATE destinations SET active = 0 WHERE id = ?").bind(destId).run();
    const { deliveryId } = await seedEventAndFailedDelivery(endpointId, destId, 1);

    // nenhum fetchMock interceptor registrado — se o worker tentar chamar a rede, o teste falha
    await runScheduled("* * * * *");

    const delivery = await env.DB.prepare("SELECT status, last_error FROM deliveries WHERE id = ?")
      .bind(deliveryId)
      .first<{ status: string; last_error: string }>();

    expect(delivery!.status).toBe("exhausted");
    expect(delivery!.last_error).toBe("destino inativo ou removido");
  });
});

describe("cron de limpeza (0 3 * * *)", () => {
  it("remove eventos com mais de 7 dias (e cascade em deliveries)", async () => {
    const { endpointId, destId } = await seedEndpointAndDestination("https://qualquer.example.com/hook");
    const oldEvent = (await env.DB.prepare(
      `INSERT INTO events (endpoint_id, method, query, headers, body, body_truncated, received_at)
       VALUES (?, 'POST', '', '{}', NULL, 0, datetime('now', '-8 days')) RETURNING id`
    )
      .bind(endpointId)
      .first<{ id: number }>())!;
    await env.DB.prepare(
      "INSERT INTO deliveries (event_id, destination_id, status) VALUES (?, ?, 'success')"
    )
      .bind(oldEvent.id, destId)
      .run();

    await runScheduled("0 3 * * *");

    const remainingEvent = await env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(oldEvent.id).first();
    const remainingDeliveries = await env.DB.prepare(
      "SELECT id FROM deliveries WHERE event_id = ?"
    )
      .bind(oldEvent.id)
      .all();

    expect(remainingEvent).toBeNull();
    expect(remainingDeliveries.results).toHaveLength(0);
  });
});
