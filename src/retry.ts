// Handlers do cron: retry (a cada minuto) e limpeza (03:00 UTC diário).
// index.ts decide qual rodar olhando event.cron.

import type { Env } from "./util";
import { toArrayBuffer } from "./util";
import { deliver } from "./deliver";

interface RetryRow {
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
}

export async function runRetryCron(env: Env, ctx: ExecutionContext): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT d.id as delivery_id, d.attempt_count,
            dest.url as destination_url, dest.active as destination_active, dest.timeout_ms as timeout_ms,
            dest.transform_json as transform_json,
            e.id as event_id, e.method as method, e.query as query, e.headers as headers,
            e.body as body, e.body_truncated as body_truncated,
            ep.signing_secret as signing_secret
     FROM deliveries d
     JOIN events e ON e.id = d.event_id
     JOIN destinations dest ON dest.id = d.destination_id
     JOIN endpoints ep ON ep.id = e.endpoint_id
     WHERE d.status = 'failed' AND d.next_retry_at <= datetime('now')
     LIMIT 50`
  ).all<RetryRow>();

  const rows = results ?? [];
  if (rows.length === 0) return;

  // "reivindica" as linhas antes de entregar: empurra next_retry_at pra frente para que
  // um tick sobreposto do cron (entrega lenta > 1min) não pegue as mesmas deliveries
  const placeholders = rows.map(() => "?").join(",");
  await env.DB.prepare(
    `UPDATE deliveries SET next_retry_at = datetime('now', '+10 minutes') WHERE id IN (${placeholders})`
  )
    .bind(...rows.map((r) => r.delivery_id))
    .run();

  for (const row of rows) {
    ctx.waitUntil(
      deliver(env, {
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
      })
    );
  }
}

export async function runCleanupCron(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM events WHERE received_at < datetime('now', '-7 days')`).run();
}
