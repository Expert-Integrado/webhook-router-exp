// Rotas /api/* do painel: login/sessão, CRUD de endpoints/destinos, eventos,
// replay e retry manual.

import { Hono } from "hono";
import type { Env } from "./util";
import { constantTimeEqual, generateToken, isValidHttpUrl, toArrayBuffer } from "./util";
import { createSessionCookie, expireSessionCookie, authMiddleware } from "./auth";
import { deliver } from "./deliver";
import { generateSigningSecret, signPayload } from "./signing";
import { matchesFilter, validateFilterJson, validateTransformJson } from "./rules";
import pkg from "../package.json";

export const api = new Hono<{ Bindings: Env }>();

api.use("*", authMiddleware);

function badRequest(message: string) {
  return { body: { error: message }, status: 400 as const };
}

// ---------- Setup (F1, sem auth) ----------

api.get("/setup-status", (c) => {
  const configured = typeof c.env.ADMIN_PASSWORD === "string" && c.env.ADMIN_PASSWORD.length > 0;
  return c.json({ password_configured: configured });
});

// ---------- Atualização disponível ----------

const UPSTREAM_PACKAGE_JSON =
  "https://raw.githubusercontent.com/Expert-Integrado/webhook-router/master/package.json";

/** Compara "1.2.3" semanticamente; true se latest > current. */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = current.split(".").map(Number);
  const b = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (!Number.isFinite(diff)) return false;
    if (diff !== 0) return diff > 0;
  }
  return false;
}

api.get("/update-status", async (c) => {
  const current = pkg.version;
  let latest: string | null = null;
  try {
    const res = await fetch(UPSTREAM_PACKAGE_JSON, {
      cf: { cacheTtl: 3600, cacheEverything: true },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const remote = (await res.json()) as { version?: unknown };
      if (typeof remote.version === "string") latest = remote.version;
    }
  } catch {
    // sem rede/GitHub fora: não é erro do painel — só não sabemos se há update
  }
  return c.json({
    current,
    latest,
    update_available: latest !== null && isNewerVersion(current, latest),
  });
});

// ---------- Sessão ----------

api.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const password = typeof body.password === "string" ? body.password : "";

  if (!constantTimeEqual(password, c.env.ADMIN_PASSWORD)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return c.json({ error: "senha incorreta" }, 401);
  }

  c.header("Set-Cookie", await createSessionCookie(c.env));
  return c.json({ ok: true });
});

api.post("/logout", (c) => {
  c.header("Set-Cookie", expireSessionCookie());
  return c.json({ ok: true });
});

api.get("/me", (c) => c.json({ ok: true }));

// ---------- Endpoints ----------

interface EndpointRow {
  id: number;
  name: string;
  token: string;
  active: number;
  created_at: string;
  signing_secret: string;
  success_24h: number;
  failed_24h: number;
  pending_24h: number;
  total_7d: number;
}

interface DestinationRow {
  id: number;
  endpoint_id: number;
  label: string;
  url: string;
  active: number;
  timeout_ms: number;
  created_at: string;
  filter_json: string | null;
  transform_json: string | null;
}

api.get("/endpoints", async (c) => {
  const { results: endpoints } = await c.env.DB.prepare(
    `SELECT id, name, token, active, created_at, signing_secret,
      (SELECT COUNT(*) FROM deliveries d JOIN events ev ON ev.id = d.event_id
        WHERE ev.endpoint_id = e.id AND d.status = 'success' AND d.updated_at >= datetime('now','-1 day')) AS success_24h,
      (SELECT COUNT(*) FROM deliveries d JOIN events ev ON ev.id = d.event_id
        WHERE ev.endpoint_id = e.id AND d.status IN ('failed','exhausted') AND d.updated_at >= datetime('now','-1 day')) AS failed_24h,
      (SELECT COUNT(*) FROM deliveries d JOIN events ev ON ev.id = d.event_id
        WHERE ev.endpoint_id = e.id AND d.status = 'pending' AND d.updated_at >= datetime('now','-1 day')) AS pending_24h,
      (SELECT COUNT(*) FROM events ev WHERE ev.endpoint_id = e.id AND ev.received_at >= datetime('now','-7 day')) AS total_7d
     FROM endpoints e
     ORDER BY created_at DESC`
  ).all<EndpointRow>();

  const rows = endpoints ?? [];
  const { results: destinations } = await c.env.DB.prepare(
    "SELECT id, endpoint_id, label, url, active, timeout_ms, created_at, filter_json, transform_json FROM destinations ORDER BY created_at ASC"
  ).all<DestinationRow>();

  const destByEndpoint = new Map<number, DestinationRow[]>();
  for (const d of destinations ?? []) {
    const list = destByEndpoint.get(d.endpoint_id) ?? [];
    list.push(d);
    destByEndpoint.set(d.endpoint_id, list);
  }

  // resposta é o array puro (sem wrapper) — é o formato que o painel SPA consome direto
  return c.json(
    rows.map((e) => ({
      id: e.id,
      name: e.name,
      token: e.token,
      active: e.active,
      created_at: e.created_at,
      signing_secret: e.signing_secret,
      stats: {
        success_24h: e.success_24h,
        failed_24h: e.failed_24h,
        pending_24h: e.pending_24h,
        total_7d: e.total_7d,
      },
      destinations: destByEndpoint.get(e.id) ?? [],
    }))
  );
});

api.post("/endpoints", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    const { body: b, status } = badRequest("nome é obrigatório");
    return c.json(b, status);
  }

  const token = generateToken(32);
  const signingSecret = generateSigningSecret();
  const row = await c.env.DB.prepare(
    `INSERT INTO endpoints (name, token, signing_secret)
     VALUES (?, ?, ?) RETURNING id, name, token, active, created_at, signing_secret`
  )
    .bind(name, token, signingSecret)
    .first();

  return c.json({ ok: true, endpoint: row }, 201);
});

api.patch("/endpoints/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

  const existing = await c.env.DB.prepare("SELECT id FROM endpoints WHERE id = ?").bind(id).first();
  if (!existing) return c.json({ error: "endpoint não encontrado" }, 404);

  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  if (name !== undefined && !name) {
    const { body: b, status } = badRequest("nome não pode ser vazio");
    return c.json(b, status);
  }
  const active = typeof body.active === "boolean" ? (body.active ? 1 : 0) : undefined;

  if (name !== undefined) {
    await c.env.DB.prepare("UPDATE endpoints SET name = ? WHERE id = ?").bind(name, id).run();
  }
  if (active !== undefined) {
    await c.env.DB.prepare("UPDATE endpoints SET active = ? WHERE id = ?").bind(active, id).run();
  }

  const row = await c.env.DB.prepare(
    "SELECT id, name, token, active, created_at, signing_secret FROM endpoints WHERE id = ?"
  )
    .bind(id)
    .first();
  return c.json({ ok: true, endpoint: row });
});

api.post("/endpoints/:id/rotate-token", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await c.env.DB.prepare("SELECT id FROM endpoints WHERE id = ?").bind(id).first();
  if (!existing) return c.json({ error: "endpoint não encontrado" }, 404);

  const token = generateToken(32);
  await c.env.DB.prepare("UPDATE endpoints SET token = ? WHERE id = ?").bind(token, id).run();
  return c.json({ ok: true, id, token });
});

api.post("/endpoints/:id/rotate-signing-secret", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await c.env.DB.prepare("SELECT id FROM endpoints WHERE id = ?").bind(id).first();
  if (!existing) return c.json({ error: "endpoint não encontrado" }, 404);

  const signingSecret = generateSigningSecret();
  await c.env.DB.prepare("UPDATE endpoints SET signing_secret = ? WHERE id = ?").bind(signingSecret, id).run();
  return c.json({ ok: true, id, signing_secret: signingSecret });
});

api.delete("/endpoints/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM endpoints WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---------- Destinos ----------

api.post("/endpoints/:id/destinations", async (c) => {
  const endpointId = Number(c.req.param("id"));
  const endpoint = await c.env.DB.prepare("SELECT id FROM endpoints WHERE id = ?").bind(endpointId).first();
  if (!endpoint) return c.json({ error: "endpoint não encontrado" }, 404);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!isValidHttpUrl(url)) {
    const { body: b, status } = badRequest("URL inválida — use http:// ou https://");
    return c.json(b, status);
  }
  const label = typeof body.label === "string" ? body.label : "";
  const timeoutMs = typeof body.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : 10000;

  const filterResult = validateFilterJson(body.filter_json);
  if (!filterResult.ok) {
    const { body: b, status } = badRequest(filterResult.error);
    return c.json(b, status);
  }
  const transformResult = validateTransformJson(body.transform_json);
  if (!transformResult.ok) {
    const { body: b, status } = badRequest(transformResult.error);
    return c.json(b, status);
  }

  const row = await c.env.DB.prepare(
    `INSERT INTO destinations (endpoint_id, label, url, timeout_ms, filter_json, transform_json)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id, endpoint_id, label, url, active, timeout_ms, created_at, filter_json, transform_json`
  )
    .bind(endpointId, label, url, timeoutMs, filterResult.value, transformResult.value)
    .first();

  return c.json({ ok: true, destination: row }, 201);
});

api.patch("/destinations/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await c.env.DB.prepare("SELECT id FROM destinations WHERE id = ?").bind(id).first();
  if (!existing) return c.json({ error: "destino não encontrado" }, 404);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

  if (body.url !== undefined) {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!isValidHttpUrl(url)) {
      const { body: b, status } = badRequest("URL inválida — use http:// ou https://");
      return c.json(b, status);
    }
    await c.env.DB.prepare("UPDATE destinations SET url = ? WHERE id = ?").bind(url, id).run();
  }
  if (typeof body.label === "string") {
    await c.env.DB.prepare("UPDATE destinations SET label = ? WHERE id = ?").bind(body.label, id).run();
  }
  if (typeof body.active === "boolean") {
    await c.env.DB.prepare("UPDATE destinations SET active = ? WHERE id = ?")
      .bind(body.active ? 1 : 0, id)
      .run();
  }
  if (typeof body.timeout_ms === "number" && body.timeout_ms > 0) {
    await c.env.DB.prepare("UPDATE destinations SET timeout_ms = ? WHERE id = ?")
      .bind(body.timeout_ms, id)
      .run();
  }
  if (body.filter_json !== undefined) {
    const filterResult = validateFilterJson(body.filter_json);
    if (!filterResult.ok) {
      const { body: b, status } = badRequest(filterResult.error);
      return c.json(b, status);
    }
    await c.env.DB.prepare("UPDATE destinations SET filter_json = ? WHERE id = ?")
      .bind(filterResult.value, id)
      .run();
  }
  if (body.transform_json !== undefined) {
    const transformResult = validateTransformJson(body.transform_json);
    if (!transformResult.ok) {
      const { body: b, status } = badRequest(transformResult.error);
      return c.json(b, status);
    }
    await c.env.DB.prepare("UPDATE destinations SET transform_json = ? WHERE id = ?")
      .bind(transformResult.value, id)
      .run();
  }

  const row = await c.env.DB.prepare(
    "SELECT id, endpoint_id, label, url, active, timeout_ms, created_at, filter_json, transform_json FROM destinations WHERE id = ?"
  )
    .bind(id)
    .first();
  return c.json({ ok: true, destination: row });
});

api.delete("/destinations/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM destinations WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---------- Ping de teste (F2) ----------

api.post("/destinations/:id/test", async (c) => {
  const id = Number(c.req.param("id"));
  const dest = await c.env.DB.prepare(
    `SELECT dest.url as url, dest.timeout_ms as timeout_ms, ep.signing_secret as signing_secret
     FROM destinations dest JOIN endpoints ep ON ep.id = dest.endpoint_id WHERE dest.id = ?`
  )
    .bind(id)
    .first<{ url: string; timeout_ms: number; signing_secret: string | null }>();
  if (!dest) return c.json({ error: "destino não encontrado" }, 404);

  const payload = JSON.stringify({ teste: true, origem: "webhook-router", disparado_em: new Date().toISOString() });
  const bodyBytes = new TextEncoder().encode(payload).buffer as ArrayBuffer;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signPayload(dest.signing_secret ?? "", timestamp, bodyBytes);

  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Webhook-Router-Test": "1",
    "X-Webhook-Router-Timestamp": String(timestamp),
    "X-Webhook-Router-Signature": `sha256=${signature}`,
  });

  const start = Date.now();
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(dest.url, {
      method: "POST",
      headers,
      body: bodyBytes,
      signal: AbortSignal.timeout(dest.timeout_ms),
    });
    statusCode = res.status;
    await res.arrayBuffer().catch(() => undefined);
  } catch (err) {
    error = err instanceof Error && err.name === "TimeoutError" ? "timeout" : err instanceof Error ? err.message : "erro de rede";
  }
  const durationMs = Date.now() - start;
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
  if (!ok && !error) error = `HTTP ${statusCode}`;

  return c.json({ ok, status_code: statusCode, duration_ms: durationMs, error: ok ? null : error });
});

// ---------- Eventos ----------

const EVENT_FILTER_STATUSES = new Set(["pending", "success", "failed", "exhausted"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

api.get("/endpoints/:id/events", async (c) => {
  const endpointId = Number(c.req.param("id"));
  const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;
  const limitParam = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;

  // filtros do feed: status (de qualquer delivery do evento) e faixa de datas (UTC)
  const status = c.req.query("status");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (status && !EVENT_FILTER_STATUSES.has(status)) {
    return c.json({ error: "status de filtro inválido" }, 400);
  }
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return c.json({ error: "data de filtro inválida — use o formato AAAA-MM-DD" }, 400);
  }

  const conditions = ["endpoint_id = ?"];
  const binds: (string | number)[] = [endpointId];
  if (before) {
    conditions.push("id < ?");
    binds.push(before);
  }
  if (from) {
    conditions.push("received_at >= ?");
    binds.push(`${from} 00:00:00`);
  }
  if (to) {
    conditions.push("received_at <= ?");
    binds.push(`${to} 23:59:59`);
  }
  if (status) {
    conditions.push("EXISTS (SELECT 1 FROM deliveries dv WHERE dv.event_id = events.id AND dv.status = ?)");
    binds.push(status);
  }

  const query = c.env.DB.prepare(
    `SELECT id, method, query, body_truncated, received_at FROM events
     WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`
  ).bind(...binds, limit);

  const { results: events } = await query.all<{
    id: number;
    method: string;
    query: string;
    body_truncated: number;
    received_at: string;
  }>();

  const rows = events ?? [];
  const eventIds = rows.map((e) => e.id);

  let deliveries: Array<{
    event_id: number;
    destination_label: string;
    status: string;
    attempt_count: number;
    last_status_code: number | null;
  }> = [];

  if (eventIds.length > 0) {
    const placeholders = eventIds.map(() => "?").join(",");
    const { results } = await c.env.DB.prepare(
      `SELECT d.event_id as event_id, dest.label as destination_label, d.status as status,
              d.attempt_count as attempt_count, d.last_status_code as last_status_code
       FROM deliveries d
       JOIN destinations dest ON dest.id = d.destination_id
       WHERE d.event_id IN (${placeholders})`
    )
      .bind(...eventIds)
      .all();
    deliveries = (results ?? []) as typeof deliveries;
  }

  const deliveriesByEvent = new Map<number, typeof deliveries>();
  for (const d of deliveries) {
    const list = deliveriesByEvent.get(d.event_id) ?? [];
    list.push(d);
    deliveriesByEvent.set(d.event_id, list);
  }

  return c.json({
    ok: true,
    events: rows.map((e) => ({
      id: e.id,
      method: e.method,
      query: e.query,
      body_truncated: !!e.body_truncated,
      received_at: e.received_at,
      deliveries: (deliveriesByEvent.get(e.id) ?? []).map((d) => ({
        destination_label: d.destination_label,
        status: d.status,
        attempt_count: d.attempt_count,
        last_status_code: d.last_status_code,
      })),
    })),
  });
});

function decodeBody(buf: ArrayBuffer | null): { body: string | null; body_is_base64: boolean } {
  if (buf === null) return { body: null, body_is_base64: false };
  try {
    return { body: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf), body_is_base64: false };
  } catch {
    let bin = "";
    for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
    return { body: btoa(bin), body_is_base64: true };
  }
}

api.get("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const event = await c.env.DB.prepare(
    "SELECT id, endpoint_id, method, query, headers, body, body_truncated, received_at FROM events WHERE id = ?"
  )
    .bind(id)
    .first<{
      id: number;
      endpoint_id: number;
      method: string;
      query: string;
      headers: string;
      body: ArrayBuffer | null;
      body_truncated: number;
      received_at: string;
    }>();

  if (!event) return c.json({ error: "evento não encontrado" }, 404);

  const { results: deliveries } = await c.env.DB.prepare(
    `SELECT d.id as id, d.destination_id as destination_id, dest.label as destination_label,
            d.status as status, d.attempt_count as attempt_count, d.last_status_code as last_status_code,
            d.last_error as last_error, d.next_retry_at as next_retry_at, d.updated_at as updated_at
     FROM deliveries d
     JOIN destinations dest ON dest.id = d.destination_id
     WHERE d.event_id = ?`
  )
    .bind(id)
    .all();

  const { body, body_is_base64 } = decodeBody(toArrayBuffer(event.body));

  // resposta é o objeto do evento direto (sem wrapper) — consumido pelo drawer do painel
  return c.json({
    id: event.id,
    endpoint_id: event.endpoint_id,
    method: event.method,
    query: event.query,
    headers: JSON.parse(event.headers),
    body,
    body_is_base64,
    body_truncated: !!event.body_truncated,
    received_at: event.received_at,
    deliveries: deliveries ?? [],
  });
});

api.post("/events/:id/replay", async (c) => {
  const id = Number(c.req.param("id"));
  const event = await c.env.DB.prepare(
    `SELECT ev.id as id, ev.endpoint_id as endpoint_id, ev.method as method, ev.query as query,
            ev.headers as headers, ev.body as body, ev.body_truncated as body_truncated,
            ep.signing_secret as signing_secret
     FROM events ev JOIN endpoints ep ON ep.id = ev.endpoint_id WHERE ev.id = ?`
  )
    .bind(id)
    .first<{
      id: number;
      endpoint_id: number;
      method: string;
      query: string;
      headers: string;
      body: ArrayBuffer | null;
      body_truncated: number;
      signing_secret: string | null;
    }>();

  if (!event) return c.json({ error: "evento não encontrado" }, 404);
  if (event.body_truncated) {
    return c.json({ error: "corpo do evento não foi retido (maior que 1 MB)" }, 409);
  }

  const { results: destinations } = await c.env.DB.prepare(
    "SELECT id, url, timeout_ms, filter_json, transform_json FROM destinations WHERE endpoint_id = ? AND active = 1"
  )
    .bind(event.endpoint_id)
    .all<{ id: number; url: string; timeout_ms: number; filter_json: string | null; transform_json: string | null }>();

  const headers = JSON.parse(event.headers);
  const eventBody = toArrayBuffer(event.body);
  const jobs: Promise<void>[] = [];

  for (const dest of destinations ?? []) {
    // filtro (F4): respeitado no replay — destino cujo filtro não casa não recebe delivery
    if (!matchesFilter(eventBody, dest.filter_json)) continue;

    const deliveryRow = await c.env.DB.prepare(
      "INSERT INTO deliveries (event_id, destination_id) VALUES (?, ?) RETURNING id"
    )
      .bind(event.id, dest.id)
      .first<{ id: number }>();

    jobs.push(
      deliver(c.env, {
        deliveryId: deliveryRow!.id,
        destinationUrl: dest.url,
        destinationActive: 1,
        timeoutMs: dest.timeout_ms,
        eventId: event.id,
        method: event.method,
        query: event.query,
        headers,
        body: eventBody,
        bodyTruncated: event.body_truncated,
        attemptCount: 0,
        signingSecret: event.signing_secret ?? "",
        transformJson: dest.transform_json,
      })
    );
  }

  c.executionCtx?.waitUntil(Promise.all(jobs));
  return c.json({ ok: true });
});

api.post("/deliveries/:id/retry", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(
    `SELECT d.id as delivery_id, d.attempt_count as attempt_count,
            dest.url as destination_url, dest.active as destination_active, dest.timeout_ms as timeout_ms,
            dest.transform_json as transform_json,
            e.id as event_id, e.method as method, e.query as query, e.headers as headers,
            e.body as body, e.body_truncated as body_truncated,
            ep.signing_secret as signing_secret
     FROM deliveries d
     JOIN events e ON e.id = d.event_id
     JOIN destinations dest ON dest.id = d.destination_id
     JOIN endpoints ep ON ep.id = e.endpoint_id
     WHERE d.id = ?`
  )
    .bind(id)
    .first<{
      delivery_id: number;
      attempt_count: number;
      destination_url: string;
      destination_active: number;
      timeout_ms: number;
      transform_json: string | null;
      event_id: number;
      method: string;
      query: string;
      headers: string;
      body: ArrayBuffer | null;
      body_truncated: number;
      signing_secret: string | null;
    }>();

  if (!row) return c.json({ error: "entrega não encontrada" }, 404);
  if (row.body_truncated && row.body === null) {
    return c.json({ error: "corpo do evento não foi retido (maior que 1 MB)" }, 409);
  }

  // retry manual sempre dispara +1 tentativa, sem respeitar o limite de 5
  await deliver(c.env, {
    deliveryId: row.delivery_id,
    destinationUrl: row.destination_url,
    destinationActive: row.destination_active,
    timeoutMs: row.timeout_ms,
    eventId: row.event_id,
    method: row.method,
    query: row.query,
    headers: JSON.parse(row.headers),
    body: toArrayBuffer(row.body),
    bodyTruncated: row.body_truncated,
    attemptCount: row.attempt_count,
    signingSecret: row.signing_secret ?? "",
    transformJson: row.transform_json,
  });

  const updated = await c.env.DB.prepare(
    "SELECT id, status, attempt_count, last_status_code, last_error, next_retry_at FROM deliveries WHERE id = ?"
  )
    .bind(id)
    .first();

  return c.json({ ok: true, delivery: updated });
});
