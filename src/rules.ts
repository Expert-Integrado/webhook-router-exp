// Filtro e transformação por destino (F4). Aplicáveis somente a body JSON
// parseável — body não-JSON sempre passa o filtro intacto e nunca é transformado.

type FilterOp = "equals" | "not_equals" | "contains" | "exists" | "not_exists";
interface FilterCondition {
  path: string;
  op: FilterOp;
  value?: string;
}

// chaves que atravessam/poluem a cadeia de prototype — nunca navegáveis por path
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (FORBIDDEN_KEYS.has(key)) return undefined;
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  if (keys.some((k) => FORBIDDEN_KEYS.has(k))) return;
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

function evalCondition(body: unknown, cond: FilterCondition): boolean {
  const value = getByPath(body, cond.path);
  switch (cond.op) {
    case "exists":
      return value !== undefined;
    case "not_exists":
      return value === undefined;
    case "equals":
      return String(value) === cond.value;
    case "not_equals":
      return String(value) !== cond.value;
    case "contains":
      if (Array.isArray(value)) return value.some((v) => String(v) === cond.value);
      if (typeof value === "string") return value.includes(cond.value ?? "");
      return false;
  }
}

function parseJsonBody(buf: ArrayBuffer | null): { ok: true; value: unknown } | { ok: false } {
  if (!buf) return { ok: false };
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * true = destino recebe o evento. filter_json nulo/vazio ou body não-JSON
 * sempre passam (nenhuma delivery deixa de ser criada por isso).
 */
export function matchesFilter(bodyBuffer: ArrayBuffer | null, filterJson: string | null): boolean {
  if (!filterJson) return true;

  let conditions: unknown;
  try {
    conditions = JSON.parse(filterJson);
  } catch {
    return true; // filtro corrompido não deveria ocorrer (validado na API) — falha aberta
  }
  if (!Array.isArray(conditions) || conditions.length === 0) return true;

  const parsed = parseJsonBody(bodyBuffer);
  if (!parsed.ok) return true; // body não-JSON sempre passa

  return (conditions as FilterCondition[]).every((cond) => evalCondition(parsed.value, cond));
}

/**
 * Substitui "{{path}}" no template: valor inteiro de uma string → valor tipado
 * cru (JSON.stringify); dentro de uma string maior → interpolação como texto.
 */
function renderTemplate(template: string, body: unknown): string {
  let out = template.replace(/"\{\{\s*([^{}\s]+)\s*\}\}"/g, (_m, path: string) => {
    const value = getByPath(body, path);
    return JSON.stringify(value === undefined ? null : value);
  });
  out = out.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_m, path: string) => {
    const value = getByPath(body, path);
    const text = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
    return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  });
  return out;
}

/**
 * Aplica a transformação ao body (já confirmado JSON parseável pelo chamador).
 * Lança Error com mensagem PT-BR se o template não gerar um JSON válido.
 */
export function applyTransform(bodyJson: unknown, transformJson: string): ArrayBuffer {
  const spec = JSON.parse(transformJson) as { mode: string; paths?: string[]; template?: string };

  if (spec.mode === "pick") {
    const out: Record<string, unknown> = {};
    for (const path of spec.paths ?? []) {
      const value = getByPath(bodyJson, path);
      if (value !== undefined) setByPath(out, path, value);
    }
    return new TextEncoder().encode(JSON.stringify(out)).buffer as ArrayBuffer;
  }

  if (spec.mode === "template") {
    const rendered = renderTemplate(spec.template ?? "", bodyJson);
    let result: unknown;
    try {
      result = JSON.parse(rendered);
    } catch {
      throw new Error("template de transformação não gerou um JSON válido");
    }
    return new TextEncoder().encode(JSON.stringify(result)).buffer as ArrayBuffer;
  }

  throw new Error(`modo de transformação desconhecido: ${spec.mode}`);
}

type ValidationResult = { ok: true; value: string | null } | { ok: false; error: string };

/** Validação estrutural de destinations.filter_json (usada nos POST/PATCH de destino). */
export function validateFilterJson(raw: unknown): ValidationResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "filtro deve ser uma string JSON ou nulo" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "filtro deve ser um JSON válido" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "filtro deve ser um array de condições" };

  const validOps = new Set(["equals", "not_equals", "contains", "exists", "not_exists"]);
  for (const cond of parsed) {
    if (!cond || typeof cond !== "object") return { ok: false, error: "cada condição do filtro deve ser um objeto" };
    const c = cond as Record<string, unknown>;
    if (typeof c.path !== "string" || !c.path.trim()) {
      return { ok: false, error: "condição de filtro precisa de um path (texto não vazio)" };
    }
    if (typeof c.op !== "string" || !validOps.has(c.op)) {
      return { ok: false, error: `operador de filtro inválido: ${String(c.op)}` };
    }
    if ((c.op === "equals" || c.op === "not_equals" || c.op === "contains") && typeof c.value !== "string") {
      return { ok: false, error: `condição "${c.op}" precisa de um value (texto)` };
    }
  }
  return { ok: true, value: JSON.stringify(parsed) };
}

/** Validação estrutural de destinations.transform_json (usada nos POST/PATCH de destino). */
export function validateTransformJson(raw: unknown): ValidationResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "transformação deve ser uma string JSON ou nula" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "transformação deve ser um JSON válido" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "transformação deve ser um objeto" };

  const t = parsed as Record<string, unknown>;
  if (t.mode === "pick") {
    if (
      !Array.isArray(t.paths) ||
      t.paths.length === 0 ||
      !t.paths.every((p) => typeof p === "string" && p.trim())
    ) {
      return { ok: false, error: "transformação 'pick' precisa de paths (lista de textos não vazios)" };
    }
  } else if (t.mode === "template") {
    if (typeof t.template !== "string" || !t.template.trim()) {
      return { ok: false, error: "transformação 'template' precisa de um template (texto não vazio)" };
    }
  } else {
    return { ok: false, error: `modo de transformação inválido: ${String(t.mode)}` };
  }
  return { ok: true, value: JSON.stringify(parsed) };
}
