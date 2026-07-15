// Entrega de um evento a UM destino. Usado pelo fan-out inicial (ingest),
// pelo cron de retry e pelo replay/retry manual (API).

import type { Env } from "./util";
import { MAX_ATTEMPTS, backoffModifier } from "./util";
import { signPayload } from "./signing";
import { applyTransform } from "./rules";

export interface DeliverInput {
  deliveryId: number;
  destinationUrl: string;
  /** 1 = ativo, 0 = pausado/removido — checado no momento da entrega (cron pode achar destino já desativado). */
  destinationActive: number;
  timeoutMs: number;
  eventId: number;
  method: string;
  /** query string crua, sem '?' */
  query: string;
  headers: Record<string, string>;
  /** null quando body_truncated=1 e não é a primeira tentativa (nada persistido para reenviar) */
  body: ArrayBuffer | null;
  bodyTruncated: number;
  /** tentativas já feitas antes desta chamada */
  attemptCount: number;
  /** signing_secret do endpoint dono do evento — assina todo envio (F3). */
  signingSecret: string;
  /** transform_json atual do destino (F4) — null = espelho fiel, sem transformação. */
  transformJson: string | null;
}

/** Decodifica e faz parse de JSON; undefined se o body não for JSON parseável. */
function parseJsonBodyOrUndefined(buf: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf));
  } catch {
    return undefined;
  }
}

function methodHasBody(method: string): boolean {
  return method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD";
}

async function markExhausted(env: Env, deliveryId: number, error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE deliveries SET status='exhausted', next_retry_at=NULL, last_error=?, updated_at=datetime('now') WHERE id=?`
  )
    .bind(error, deliveryId)
    .run();
}

/** Registra uma tentativa que não teve sucesso: 'failed' com próximo retry, ou 'exhausted' no limite. */
async function finalizeFailedAttempt(
  env: Env,
  deliveryId: number,
  newAttemptCount: number,
  statusCode: number | null,
  errorMsg: string | null
): Promise<void> {
  if (newAttemptCount >= MAX_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE deliveries SET status='exhausted', attempt_count=?, last_status_code=?, last_error=?, next_retry_at=NULL, updated_at=datetime('now') WHERE id=?`
    )
      .bind(newAttemptCount, statusCode, errorMsg, deliveryId)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE deliveries SET status='failed', attempt_count=?, last_status_code=?, last_error=?, next_retry_at=datetime('now', ?), updated_at=datetime('now') WHERE id=?`
    )
      .bind(newAttemptCount, statusCode, errorMsg, backoffModifier(newAttemptCount), deliveryId)
      .run();
  }
}

export async function deliver(env: Env, input: DeliverInput): Promise<void> {
  const { deliveryId } = input;

  if (!input.destinationActive) {
    await markExhausted(env, deliveryId, "destino inativo ou removido");
    return;
  }

  if (input.bodyTruncated && input.body === null) {
    await markExhausted(env, deliveryId, "body não retido (>1MB)");
    return;
  }

  // Transformação (F4): aplicada a cada tentativa, só quando o body é JSON
  // parseável — body não-JSON segue intacto (transformação ignorada).
  let finalBody = input.body;
  let contentTypeOverride: string | null = null;
  if (input.transformJson && input.body) {
    const bodyJson = parseJsonBodyOrUndefined(input.body);
    if (bodyJson !== undefined) {
      try {
        finalBody = applyTransform(bodyJson, input.transformJson);
        contentTypeOverride = "application/json";
      } catch (err) {
        const message = err instanceof Error ? err.message : "erro ao aplicar transformação";
        await finalizeFailedAttempt(env, deliveryId, input.attemptCount + 1, null, message);
        return;
      }
    }
  }

  // mescla a query: preserva os parâmetros próprios da URL do destino e acrescenta os do evento
  const url = new URL(input.destinationUrl);
  if (input.query) {
    for (const [k, v] of new URLSearchParams(input.query)) {
      url.searchParams.append(k, v);
    }
  }

  const headers = new Headers(input.headers);
  headers.set("X-Webhook-Router-Event", String(input.eventId));
  headers.set("X-Webhook-Router-Attempt", String(input.attemptCount + 1));
  if (contentTypeOverride) headers.set("Content-Type", contentTypeOverride);

  const bodyToSend = methodHasBody(input.method) && finalBody ? finalBody : undefined;

  // Assinatura HMAC (F3): sobre o body final enviado (pós-transformação).
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signPayload(input.signingSecret, timestamp, bodyToSend ?? null);
  headers.set("X-Webhook-Router-Timestamp", String(timestamp));
  headers.set("X-Webhook-Router-Signature", `sha256=${signature}`);

  let statusCode: number | null = null;
  let errorMsg: string | null = null;
  let ok = false;

  try {
    const res = await fetch(url.toString(), {
      method: input.method,
      headers,
      body: bodyToSend,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    statusCode = res.status;
    ok = res.status >= 200 && res.status < 300;
    if (!ok) errorMsg = `HTTP ${res.status}`;
    // drena o corpo da resposta do destino para liberar a conexão
    await res.arrayBuffer().catch(() => undefined);
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : "erro de rede";
  }

  if (ok) {
    await env.DB.prepare(
      `UPDATE deliveries SET status='success', attempt_count=attempt_count+1, last_status_code=?, last_error=NULL, next_retry_at=NULL, updated_at=datetime('now') WHERE id=?`
    )
      .bind(statusCode, deliveryId)
      .run();
    return;
  }

  await finalizeFailedAttempt(env, deliveryId, input.attemptCount + 1, statusCode, errorMsg);
}
