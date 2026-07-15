// Tipos e helpers compartilhados: bindings do Worker, filtro de headers,
// geração de token, comparação constant-time e cálculo de backoff.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
}

/** Backoff em minutos, indexado por número de tentativas já feitas (1ª falha → índice 0). */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 360] as const;
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

/** Modificador SQLite (`datetime('now', <mod>)`) para o próximo retry. */
export function backoffModifier(attemptCount: number): string {
  const minutes = BACKOFF_MINUTES[attemptCount - 1] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1];
  return `+${minutes} minutes`;
}

const BLOCKED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "expect",
  "x-real-ip",
]);
const BLOCKED_HEADER_PREFIXES = ["cf-", "x-forwarded-"];

/** Remove headers técnicos/de proxy antes de reencaminhar ao destino. */
export function filterHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (BLOCKED_HEADERS.has(lower)) continue;
    if (BLOCKED_HEADER_PREFIXES.some((p) => lower.startsWith(p))) continue;
    out[key] = value;
  }
  return out;
}

const TOKEN_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Token url-safe (base62) aleatório, padrão 32 caracteres. */
export function generateToken(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return out;
}

/** Compara duas strings em tempo constante (evita timing attack em senha/token). */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const len = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Normaliza o valor de uma coluna BLOB lida do D1 para ArrayBuffer.
 * Dependendo do driver/ambiente, o D1 pode devolver o BLOB como ArrayBuffer,
 * como view (Uint8Array) ou como array puro de números — normalizamos aqui
 * para que decodeBody/deliver sempre recebam bytes crus corretos.
 */
export function toArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value === null || value === undefined) return null;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(value)) return new Uint8Array(value as number[]).buffer;
  return null;
}
