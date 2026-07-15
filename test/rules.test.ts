// F4 — filtro e transformação por destino: avaliação do filtro no fan-out/replay,
// transformação (pick/template) aplicada em deliver(), e validação estrutural da API.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { createSessionCookie } from "../src/auth";
import { matchesFilter, applyTransform, validateFilterJson, validateTransformJson } from "../src/rules";
import { installFetchMock, mockFetchOnce, assertNoPendingMocks } from "./fetch-mock";

beforeAll(() => {
  installFetchMock();
});

afterEach(() => {
  assertNoPendingMocks();
});

function buf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

// ---------- Unidade: matchesFilter ----------

describe("matchesFilter", () => {
  it("filter_json nulo ou [] sempre passa", () => {
    expect(matchesFilter(buf('{"a":1}'), null)).toBe(true);
    expect(matchesFilter(buf('{"a":1}'), "[]")).toBe(true);
  });

  it("body não-JSON sempre passa, mesmo com filtro definido", () => {
    const filter = JSON.stringify([{ path: "a", op: "equals", value: "1" }]);
    expect(matchesFilter(buf("não é json"), filter)).toBe(true);
    expect(matchesFilter(null, filter)).toBe(true);
  });

  it("equals/not_equals comparam String(valor) com value", () => {
    const equalsFilter = JSON.stringify([{ path: "type", op: "equals", value: "pedido" }]);
    expect(matchesFilter(buf('{"type":"pedido"}'), equalsFilter)).toBe(true);
    expect(matchesFilter(buf('{"type":"boleto"}'), equalsFilter)).toBe(false);

    const notEqualsFilter = JSON.stringify([{ path: "type", op: "not_equals", value: "pedido" }]);
    expect(matchesFilter(buf('{"type":"boleto"}'), notEqualsFilter)).toBe(true);
    expect(matchesFilter(buf('{"type":"pedido"}'), notEqualsFilter)).toBe(false);
  });

  it("contains funciona em string e em array", () => {
    const stringFilter = JSON.stringify([{ path: "msg", op: "contains", value: "erro" }]);
    expect(matchesFilter(buf('{"msg":"deu erro aqui"}'), stringFilter)).toBe(true);
    expect(matchesFilter(buf('{"msg":"tudo ok"}'), stringFilter)).toBe(false);

    const arrayFilter = JSON.stringify([{ path: "tags", op: "contains", value: "urgente" }]);
    expect(matchesFilter(buf('{"tags":["normal","urgente"]}'), arrayFilter)).toBe(true);
    expect(matchesFilter(buf('{"tags":["normal"]}'), arrayFilter)).toBe(false);
  });

  it("exists/not_exists checam se o path está definido, com dot notation", () => {
    const existsFilter = JSON.stringify([{ path: "a.b.c", op: "exists" }]);
    expect(matchesFilter(buf('{"a":{"b":{"c":1}}}'), existsFilter)).toBe(true);
    expect(matchesFilter(buf('{"a":{"b":{}}}'), existsFilter)).toBe(false);

    const notExistsFilter = JSON.stringify([{ path: "a.b.c", op: "not_exists" }]);
    expect(matchesFilter(buf('{"a":{"b":{}}}'), notExistsFilter)).toBe(true);
  });

  it("múltiplas condições são combinadas em AND", () => {
    const filter = JSON.stringify([
      { path: "type", op: "equals", value: "pedido" },
      { path: "valor", op: "exists" },
    ]);
    expect(matchesFilter(buf('{"type":"pedido","valor":10}'), filter)).toBe(true);
    expect(matchesFilter(buf('{"type":"pedido"}'), filter)).toBe(false);
  });
});

// ---------- Unidade: applyTransform ----------

describe("applyTransform", () => {
  it("modo pick mantém só os paths pedidos, preservando aninhamento", () => {
    const body = JSON.parse('{"a":{"b":1,"c":2},"d":"ignorar"}');
    const out = applyTransform(body, JSON.stringify({ mode: "pick", paths: ["a.b"] }));
    expect(JSON.parse(new TextDecoder().decode(out))).toEqual({ a: { b: 1 } });
  });

  it("modo pick ignora path inexistente", () => {
    const body = { a: 1 };
    const out = applyTransform(body, JSON.stringify({ mode: "pick", paths: ["a", "nao.existe"] }));
    expect(JSON.parse(new TextDecoder().decode(out))).toEqual({ a: 1 });
  });

  it("modo template: placeholder sozinho numa string vira valor tipado", () => {
    const body = { n: 42, ativo: true, obj: { x: 1 } };
    const template = '{"count":"{{n}}","flag":"{{ativo}}","nested":"{{obj}}"}';
    const out = applyTransform(body, JSON.stringify({ mode: "template", template }));
    expect(JSON.parse(new TextDecoder().decode(out))).toEqual({ count: 42, flag: true, nested: { x: 1 } });
  });

  it("modo template: placeholder dentro de string maior interpola como texto", () => {
    const body = { nome: "Ana" };
    const template = '{"msg":"Olá, {{nome}}!"}';
    const out = applyTransform(body, JSON.stringify({ mode: "template", template }));
    expect(JSON.parse(new TextDecoder().decode(out))).toEqual({ msg: "Olá, Ana!" });
  });

  it("template que não gera JSON válido lança erro", () => {
    const body = { a: 1 };
    const template = "{isso não é JSON: {{a}}}";
    expect(() => applyTransform(body, JSON.stringify({ mode: "template", template }))).toThrow();
  });
});

// ---------- Unidade: validação estrutural da API ----------

describe("validateFilterJson", () => {
  it("aceita nulo e array vazio/válido", () => {
    expect(validateFilterJson(null)).toEqual({ ok: true, value: null });
    const valid = JSON.stringify([{ path: "a", op: "exists" }]);
    expect(validateFilterJson(valid)).toEqual({ ok: true, value: valid });
  });

  it("rejeita JSON malformado, operador inválido e path vazio", () => {
    expect(validateFilterJson("{não é json").ok).toBe(false);
    expect(validateFilterJson(JSON.stringify([{ path: "a", op: "invalido" }])).ok).toBe(false);
    expect(validateFilterJson(JSON.stringify([{ path: "", op: "exists" }])).ok).toBe(false);
    expect(validateFilterJson(JSON.stringify([{ path: "a", op: "equals" }])).ok).toBe(false); // falta value
  });
});

describe("validateTransformJson", () => {
  it("aceita nulo, pick válido e template válido", () => {
    expect(validateTransformJson(null)).toEqual({ ok: true, value: null });
    expect(validateTransformJson(JSON.stringify({ mode: "pick", paths: ["a"] })).ok).toBe(true);
    expect(validateTransformJson(JSON.stringify({ mode: "template", template: "{{a}}" })).ok).toBe(true);
  });

  it("rejeita modo inválido, pick sem paths e template sem texto", () => {
    expect(validateTransformJson(JSON.stringify({ mode: "outro" })).ok).toBe(false);
    expect(validateTransformJson(JSON.stringify({ mode: "pick", paths: [] })).ok).toBe(false);
    expect(validateTransformJson(JSON.stringify({ mode: "template", template: "" })).ok).toBe(false);
  });
});

// ---------- Integração: ingest (fan-out) e replay ----------

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function authHeader(): Promise<Record<string, string>> {
  const setCookie = await createSessionCookie(env);
  return { Cookie: setCookie.split(";")[0] };
}

async function createEndpoint() {
  const token = "tok" + Math.random().toString(36).slice(2, 12);
  return (await env.DB.prepare(
    "INSERT INTO endpoints (name, token, signing_secret) VALUES ('ep-rules', ?, lower(hex(randomblob(32)))) RETURNING id, token"
  )
    .bind(token)
    .first<{ id: number; token: string }>())!;
}

async function createDestination(
  endpointId: number,
  url: string,
  opts: { filter_json?: string; transform_json?: string } = {}
) {
  return (await env.DB.prepare(
    `INSERT INTO destinations (endpoint_id, url, timeout_ms, filter_json, transform_json)
     VALUES (?, ?, 5000, ?, ?) RETURNING id`
  )
    .bind(endpointId, url, opts.filter_json ?? null, opts.transform_json ?? null)
    .first<{ id: number }>())!.id;
}

describe("filtro no fan-out (ingest)", () => {
  it("destino cujo filtro casa recebe a delivery", async () => {
    const endpoint = await createEndpoint();
    await createDestination(endpoint.id, "https://filtro-casa.example.com/hook", {
      filter_json: JSON.stringify([{ path: "type", op: "equals", value: "pedido" }]),
    });

    mockFetchOnce({ url: "https://filtro-casa.example.com/hook", method: "POST", status: 200, responseBody: "ok" });

    const res = await call(
      new Request(`https://router.test/in/${endpoint.token}`, { method: "POST", body: '{"type":"pedido"}' })
    );
    const json = (await res.json()) as { event_id: number };
    const { results } = await env.DB.prepare("SELECT id FROM deliveries WHERE event_id = ?")
      .bind(json.event_id)
      .all();
    expect(results).toHaveLength(1);
  });

  it("destino cujo filtro não casa não recebe delivery nenhuma", async () => {
    const endpoint = await createEndpoint();
    await createDestination(endpoint.id, "https://filtro-nao-casa.example.com/hook", {
      filter_json: JSON.stringify([{ path: "type", op: "equals", value: "pedido" }]),
    });

    // nenhum mockFetchOnce registrado — se o worker tentar entregar, o teste falha
    const res = await call(
      new Request(`https://router.test/in/${endpoint.token}`, { method: "POST", body: '{"type":"boleto"}' })
    );
    const json = (await res.json()) as { event_id: number };
    const { results } = await env.DB.prepare("SELECT id FROM deliveries WHERE event_id = ?")
      .bind(json.event_id)
      .all();
    expect(results).toHaveLength(0);
  });

  it("body não-JSON com filtro definido ainda cria a delivery", async () => {
    const endpoint = await createEndpoint();
    await createDestination(endpoint.id, "https://filtro-nao-json.example.com/hook", {
      filter_json: JSON.stringify([{ path: "type", op: "equals", value: "pedido" }]),
    });

    mockFetchOnce({ url: "https://filtro-nao-json.example.com/hook", method: "POST", status: 200, responseBody: "ok" });

    const res = await call(
      new Request(`https://router.test/in/${endpoint.token}`, { method: "POST", body: "texto puro, não é json" })
    );
    const json = (await res.json()) as { event_id: number };
    const { results } = await env.DB.prepare("SELECT id FROM deliveries WHERE event_id = ?")
      .bind(json.event_id)
      .all();
    expect(results).toHaveLength(1);
  });
});

describe("filtro no replay", () => {
  it("replay respeita o filtro: recria delivery só pros destinos que casam", async () => {
    const auth = await authHeader();
    const endpoint = await createEndpoint();
    await createDestination(endpoint.id, "https://replay-casa.example.com/hook", {
      filter_json: JSON.stringify([{ path: "type", op: "equals", value: "pedido" }]),
    });
    await createDestination(endpoint.id, "https://replay-nao-casa.example.com/hook", {
      filter_json: JSON.stringify([{ path: "type", op: "equals", value: "boleto" }]),
    });

    const event = (await env.DB.prepare(
      `INSERT INTO events (endpoint_id, method, query, headers, body, body_truncated)
       VALUES (?, 'POST', '', '{}', ?, 0) RETURNING id`
    )
      .bind(endpoint.id, buf('{"type":"pedido"}'))
      .first<{ id: number }>())!;

    mockFetchOnce({ url: "https://replay-casa.example.com/hook", method: "POST", status: 200, responseBody: "ok" });

    const res = await call(
      new Request(`https://router.test/api/events/${event.id}/replay`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(200);

    const { results } = await env.DB.prepare("SELECT id FROM deliveries WHERE event_id = ?")
      .bind(event.id)
      .all();
    expect(results).toHaveLength(1); // só o destino cujo filtro casou
  });
});

describe("transformação aplicada na entrega", () => {
  it("modo pick: destino recebe só os campos escolhidos", async () => {
    const endpoint = await createEndpoint();
    await createDestination(endpoint.id, "https://transform-pick.example.com/hook", {
      transform_json: JSON.stringify({ mode: "pick", paths: ["cliente.nome"] }),
    });

    mockFetchOnce({
      url: "https://transform-pick.example.com/hook",
      method: "POST",
      body: JSON.stringify({ cliente: { nome: "Ana" } }),
      status: 200,
      responseBody: "ok",
    });

    const res = await call(
      new Request(`https://router.test/in/${endpoint.token}`, {
        method: "POST",
        body: JSON.stringify({ cliente: { nome: "Ana", email: "ana@exemplo.com" }, valor: 100 }),
      })
    );
    expect(res.status).toBe(200);
  });

  it("template inválido marca a delivery como 'failed' com last_error explicativo", async () => {
    const endpoint = await createEndpoint();
    await createDestination(endpoint.id, "https://transform-invalido.example.com/hook", {
      transform_json: JSON.stringify({ mode: "template", template: "{quebrado: {{a}}" }),
    });

    // nenhum mockFetchOnce — a transformação inválida impede a tentativa de rede
    const res = await call(
      new Request(`https://router.test/in/${endpoint.token}`, { method: "POST", body: '{"a":1}' })
    );
    const json = (await res.json()) as { event_id: number };

    const delivery = await env.DB.prepare(
      "SELECT status, last_error FROM deliveries WHERE event_id = ?"
    )
      .bind(json.event_id)
      .first<{ status: string; last_error: string }>();

    expect(delivery!.status).toBe("failed");
    expect(delivery!.last_error).toMatch(/transformação/);
  });
});

describe("validação da API para filter_json/transform_json", () => {
  it("POST /api/endpoints/:id/destinations rejeita filtro com operador inválido (400 PT-BR)", async () => {
    const auth = await authHeader();
    const endpoint = (
      (await (
        await call(
          new Request("https://router.test/api/endpoints", {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ name: "ep-validacao" }),
          })
        )
      ).json()) as { endpoint: { id: number } }
    ).endpoint;

    const res = await call(
      new Request(`https://router.test/api/endpoints/${endpoint.id}/destinations`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://destino.example.com/hook",
          filter_json: JSON.stringify([{ path: "a", op: "operador-invalido" }]),
        }),
      })
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/operador/);
  });
});
