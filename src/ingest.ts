// Recepção de webhooks em /in/:token — qualquer método, resposta imediata,
// fan-out para os destinos ativos disparado em background (waitUntil).

import type { Context } from "hono";
import type { Env } from "./util";
import { filterHeaders } from "./util";
import { deliver } from "./deliver";
import { matchesFilter } from "./rules";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

export async function ingestHandler(c: Context<{ Bindings: Env }>) {
  const token = c.req.param("token");

  const endpoint = await c.env.DB.prepare(
    "SELECT id, signing_secret FROM endpoints WHERE token = ? AND active = 1"
  )
    .bind(token)
    .first<{ id: number; signing_secret: string | null }>();

  if (!endpoint) {
    return c.json({ error: "não encontrado" }, 404);
  }

  const rawBody = await c.req.raw.arrayBuffer();
  const truncated = rawBody.byteLength > MAX_BODY_BYTES;
  const headers = filterHeaders(c.req.raw.headers);
  const query = new URL(c.req.url).search.replace(/^\?/, "");

  const eventRow = await c.env.DB.prepare(
    `INSERT INTO events (endpoint_id, method, query, headers, body, body_truncated)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(
      endpoint.id,
      c.req.method,
      query,
      JSON.stringify(headers),
      truncated ? null : rawBody,
      truncated ? 1 : 0
    )
    .first<{ id: number }>();
  const eventId = eventRow!.id;

  const destinations = await c.env.DB.prepare(
    "SELECT id, url, timeout_ms, filter_json, transform_json FROM destinations WHERE endpoint_id = ? AND active = 1"
  )
    .bind(endpoint.id)
    .all<{ id: number; url: string; timeout_ms: number; filter_json: string | null; transform_json: string | null }>();

  const bodyForFilter = rawBody.byteLength > 0 ? rawBody : null;
  const jobs: Promise<void>[] = [];
  for (const dest of destinations.results ?? []) {
    // filtro (F4): destino cujo filtro não casa não recebe delivery
    if (!matchesFilter(bodyForFilter, dest.filter_json)) continue;

    const deliveryRow = await c.env.DB.prepare(
      "INSERT INTO deliveries (event_id, destination_id) VALUES (?, ?) RETURNING id"
    )
      .bind(eventId, dest.id)
      .first<{ id: number }>();

    jobs.push(
      deliver(c.env, {
        deliveryId: deliveryRow!.id,
        destinationUrl: dest.url,
        destinationActive: 1,
        timeoutMs: dest.timeout_ms,
        eventId,
        method: c.req.method,
        query,
        headers,
        // primeira tentativa sempre usa o body real recebido, mesmo se truncado na persistência
        body: bodyForFilter,
        bodyTruncated: truncated ? 1 : 0,
        attemptCount: 0,
        signingSecret: endpoint.signing_secret ?? "",
        transformJson: dest.transform_json,
      })
    );
  }

  c.executionCtx?.waitUntil(Promise.all(jobs));

  return c.json({ ok: true, event_id: eventId });
}
