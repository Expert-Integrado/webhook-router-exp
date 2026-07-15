// Assinatura HMAC de saída (F3): toda entrega leva
// X-Webhook-Router-Timestamp + X-Webhook-Router-Signature: sha256=<hex>,
// calculado sobre "<timestamp>." + body final enviado.

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Secret hex de 64 chars (32 bytes aleatórios) — gerado em código para endpoints novos. */
export function generateSigningSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

/**
 * HMAC-SHA256(secret, "<timestamp>." + body) em hex minúsculo.
 * Body vazio/null → assina apenas "<timestamp>.".
 */
export async function signPayload(secret: string, timestamp: number, body: ArrayBuffer | null): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const bodyBytes = body ? new Uint8Array(body) : new Uint8Array(0);
  const data = new Uint8Array(prefix.length + bodyBytes.length);
  data.set(prefix, 0);
  data.set(bodyBytes, prefix.length);

  const sig = await crypto.subtle.sign("HMAC", key, data);
  return toHex(sig);
}
