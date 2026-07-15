import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { createSessionCookie } from "../src/auth";
import { installFetchMock, mockFetchOnce, assertNoPendingMocks } from "./fetch-mock";

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

async function authHeader(): Promise<Record<string, string>> {
  const setCookie = await createSessionCookie(env);
  return { Cookie: setCookie.split(";")[0] };
}

function jsonReq(path: string, init: RequestInit & { auth?: Record<string, string> } = {}) {
  const { auth, ...rest } = init;
  return new Request(`https://router.test${path}`, {
    ...rest,
    headers: { "content-type": "application/json", ...(auth ?? {}), ...(rest.headers as Record<string, string>) },
  });
}

describe("autenticação", () => {
  it("rota protegida sem cookie retorna 401", async () => {
    const res = await call(jsonReq("/api/endpoints"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("login com senha errada retorna 401", async () => {
    const res = await call(jsonReq("/api/login", { method: "POST", body: JSON.stringify({ password: "errada" }) }));
    expect(res.status).toBe(401);
  });

  it("login com senha correta retorna cookie de sessão utilizável", async () => {
    const res = await call(
      jsonReq("/api/login", { method: "POST", body: JSON.stringify({ password: env.ADMIN_PASSWORD }) })
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();

    const cookie = setCookie!.split(";")[0];
    const me = await call(jsonReq("/api/me", { headers: { Cookie: cookie } }));
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ ok: true });
  });
});

describe("CRUD de endpoints e destinos", () => {
  it("cria, atualiza, rotaciona token e remove um endpoint", async () => {
    const auth = await authHeader();

    const createRes = await call(
      jsonReq("/api/endpoints", { method: "POST", body: JSON.stringify({ name: "Z-API principal" }), auth })
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { endpoint: { id: number; token: string; name: string } };
    expect(created.endpoint.name).toBe("Z-API principal");
    expect(created.endpoint.token).toHaveLength(32);

    const patchRes = await call(
      jsonReq(`/api/endpoints/${created.endpoint.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: false }),
        auth,
      })
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { endpoint: { active: number } };
    expect(patched.endpoint.active).toBe(0);

    const rotateRes = await call(
      jsonReq(`/api/endpoints/${created.endpoint.id}/rotate-token`, { method: "POST", auth })
    );
    expect(rotateRes.status).toBe(200);
    const rotated = (await rotateRes.json()) as { token: string };
    expect(rotated.token).not.toBe(created.endpoint.token);

    const deleteRes = await call(jsonReq(`/api/endpoints/${created.endpoint.id}`, { method: "DELETE", auth }));
    expect(deleteRes.status).toBe(200);

    const list = (await (await call(jsonReq("/api/endpoints", { auth }))).json()) as Array<{ id: number }>;
    expect(list.find((e) => e.id === created.endpoint.id)).toBeUndefined();
  });

  it("GET /api/endpoints responde um array puro (sem wrapper) — contrato do painel SPA", async () => {
    const auth = await authHeader();
    await call(jsonReq("/api/endpoints", { method: "POST", body: JSON.stringify({ name: "ep-lista" }), auth }));

    const res = await call(jsonReq("/api/endpoints", { auth }));
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const found = (body as Array<{ name: string; stats: unknown; destinations: unknown }>).find(
      (e) => e.name === "ep-lista"
    );
    expect(found).toBeDefined();
    expect(found!.stats).toBeDefined();
    expect(Array.isArray(found!.destinations)).toBe(true);
  });

  it("rejeita nome vazio ao criar endpoint (400 PT-BR)", async () => {
    const auth = await authHeader();
    const res = await call(jsonReq("/api/endpoints", { method: "POST", body: JSON.stringify({ name: "" }), auth }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/obrigatório/);
  });

  it("cria e atualiza destinos, rejeitando URL inválida", async () => {
    const auth = await authHeader();
    const endpoint = (
      (await (
        await call(jsonReq("/api/endpoints", { method: "POST", body: JSON.stringify({ name: "ep" }), auth }))
      ).json()) as { endpoint: { id: number } }
    ).endpoint;

    const badUrlRes = await call(
      jsonReq(`/api/endpoints/${endpoint.id}/destinations`, {
        method: "POST",
        body: JSON.stringify({ url: "not-a-url" }),
        auth,
      })
    );
    expect(badUrlRes.status).toBe(400);

    const createRes = await call(
      jsonReq(`/api/endpoints/${endpoint.id}/destinations`, {
        method: "POST",
        body: JSON.stringify({ url: "https://destino.example.com/hook", label: "principal" }),
        auth,
      })
    );
    expect(createRes.status).toBe(201);
    const dest = ((await createRes.json()) as { destination: { id: number } }).destination;

    const patchRes = await call(
      jsonReq(`/api/destinations/${dest.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: false }),
        auth,
      })
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { destination: { active: number } };
    expect(patched.destination.active).toBe(0);

    const deleteRes = await call(jsonReq(`/api/destinations/${dest.id}`, { method: "DELETE", auth }));
    expect(deleteRes.status).toBe(200);
  });
});

describe("replay e retry manual", () => {
  it("replay recria deliveries pending e dispara fan-out", async () => {
    const auth = await authHeader();

    const endpoint = (await env.DB.prepare(
      "INSERT INTO endpoints (name, token, signing_secret) VALUES ('ep-replay', 'tok-replay', lower(hex(randomblob(32)))) RETURNING id"
    ).first<{ id: number }>())!;
    const dest = (await env.DB.prepare(
      "INSERT INTO destinations (endpoint_id, url, timeout_ms) VALUES (?, 'https://replay-dest.example.com/hook', 5000) RETURNING id"
    )
      .bind(endpoint.id)
      .first<{ id: number }>())!;
    const event = (await env.DB.prepare(
      `INSERT INTO events (endpoint_id, method, query, headers, body, body_truncated)
       VALUES (?, 'POST', '', '{}', ?, 0) RETURNING id`
    )
      .bind(endpoint.id, new TextEncoder().encode("{}").buffer)
      .first<{ id: number }>())!;

    mockFetchOnce({ url: "https://replay-dest.example.com/hook", method: "POST", status: 200, responseBody: "ok" });

    const res = await call(jsonReq(`/api/events/${event.id}/replay`, { method: "POST", auth }));
    expect(res.status).toBe(200);

    const { results: deliveries } = await env.DB.prepare(
      "SELECT status FROM deliveries WHERE event_id = ? AND destination_id = ?"
    )
      .bind(event.id, dest.id)
      .all<{ status: string }>();

    expect(deliveries).toHaveLength(1);
    expect(deliveries![0].status).toBe("success");
  });

  it("GET /api/events/:id responde o objeto do evento direto (sem wrapper) — contrato do painel SPA", async () => {
    const auth = await authHeader();
    const endpoint = (await env.DB.prepare(
      "INSERT INTO endpoints (name, token, signing_secret) VALUES ('ep-detalhe', 'tok-detalhe', lower(hex(randomblob(32)))) RETURNING id"
    ).first<{ id: number }>())!;
    const event = (await env.DB.prepare(
      `INSERT INTO events (endpoint_id, method, query, headers, body, body_truncated)
       VALUES (?, 'POST', 'a=1', '{"content-type":"application/json"}', ?, 0) RETURNING id`
    )
      .bind(endpoint.id, new TextEncoder().encode('{"x":1}').buffer)
      .first<{ id: number }>())!;

    const res = await call(jsonReq(`/api/events/${event.id}`, { auth }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      method: string;
      query: string;
      headers: Record<string, string>;
      body: string;
      body_truncated: boolean;
      deliveries: unknown[];
    };

    expect(body.id).toBe(event.id);
    expect(body.method).toBe("POST");
    expect(body.query).toBe("a=1");
    expect(body.headers["content-type"]).toBe("application/json");
    expect(body.body).toBe('{"x":1}');
    expect(body.body_truncated).toBe(false);
    expect(Array.isArray(body.deliveries)).toBe(true);
  });

  it("replay de evento com body_truncated retorna 409", async () => {
    const auth = await authHeader();
    const endpoint = (await env.DB.prepare(
      "INSERT INTO endpoints (name, token, signing_secret) VALUES ('ep-trunc', 'tok-trunc', lower(hex(randomblob(32)))) RETURNING id"
    ).first<{ id: number }>())!;
    const event = (await env.DB.prepare(
      `INSERT INTO events (endpoint_id, method, query, headers, body, body_truncated)
       VALUES (?, 'POST', '', '{}', NULL, 1) RETURNING id`
    )
      .bind(endpoint.id)
      .first<{ id: number }>())!;

    const res = await call(jsonReq(`/api/events/${event.id}/replay`, { method: "POST", auth }));
    expect(res.status).toBe(409);
  });

  it("retry manual dispara +1 tentativa mesmo já exhausted", async () => {
    const auth = await authHeader();
    const endpoint = (await env.DB.prepare(
      "INSERT INTO endpoints (name, token, signing_secret) VALUES ('ep-retry', 'tok-retry', lower(hex(randomblob(32)))) RETURNING id"
    ).first<{ id: number }>())!;
    const dest = (await env.DB.prepare(
      "INSERT INTO destinations (endpoint_id, url, timeout_ms) VALUES (?, 'https://retry-manual.example.com/hook', 5000) RETURNING id"
    )
      .bind(endpoint.id)
      .first<{ id: number }>())!;
    const event = (await env.DB.prepare(
      `INSERT INTO events (endpoint_id, method, query, headers, body, body_truncated)
       VALUES (?, 'POST', '', '{}', ?, 0) RETURNING id`
    )
      .bind(endpoint.id, new TextEncoder().encode("{}").buffer)
      .first<{ id: number }>())!;
    const delivery = (await env.DB.prepare(
      `INSERT INTO deliveries (event_id, destination_id, status, attempt_count) VALUES (?, ?, 'exhausted', 5) RETURNING id`
    )
      .bind(event.id, dest.id)
      .first<{ id: number }>())!;

    mockFetchOnce({ url: "https://retry-manual.example.com/hook", method: "POST", status: 200, responseBody: "ok" });

    const res = await call(jsonReq(`/api/deliveries/${delivery.id}/retry`, { method: "POST", auth }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { delivery: { status: string; attempt_count: number } };
    expect(json.delivery.status).toBe("success");
    expect(json.delivery.attempt_count).toBe(6);
  });
});

describe("GET /api/setup-status (F1, sem auth)", () => {
  it("responde password_configured sem exigir cookie de sessão", async () => {
    const res = await call(jsonReq("/api/setup-status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ password_configured: true }); // ADMIN_PASSWORD="senha-de-teste" nos testes
  });
});

describe("rotate-signing-secret (F3)", () => {
  it("gera um signing_secret novo e o inclui em GET /api/endpoints", async () => {
    const auth = await authHeader();
    const created = (
      (await (
        await call(jsonReq("/api/endpoints", { method: "POST", body: JSON.stringify({ name: "ep-rotate" }), auth }))
      ).json()) as { endpoint: { id: number; signing_secret: string } }
    ).endpoint;
    expect(created.signing_secret).toMatch(/^[0-9a-f]{64}$/);

    const rotateRes = await call(
      jsonReq(`/api/endpoints/${created.id}/rotate-signing-secret`, { method: "POST", auth })
    );
    expect(rotateRes.status).toBe(200);
    const rotated = (await rotateRes.json()) as { signing_secret: string };
    expect(rotated.signing_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.signing_secret).not.toBe(created.signing_secret);

    const list = (await (await call(jsonReq("/api/endpoints", { auth }))).json()) as Array<{
      id: number;
      signing_secret: string;
    }>;
    const found = list.find((e) => e.id === created.id);
    expect(found?.signing_secret).toBe(rotated.signing_secret);
  });
});

describe("POST /api/destinations/:id/test (F2, ping)", () => {
  it("destino que responde 2xx retorna ok=true com status e duração", async () => {
    const auth = await authHeader();
    const endpoint = (
      (await (
        await call(jsonReq("/api/endpoints", { method: "POST", body: JSON.stringify({ name: "ep-ping" }), auth }))
      ).json()) as { endpoint: { id: number } }
    ).endpoint;
    const dest = (
      (await (
        await call(
          jsonReq(`/api/endpoints/${endpoint.id}/destinations`, {
            method: "POST",
            body: JSON.stringify({ url: "https://ping-ok.example.com/hook" }),
            auth,
          })
        )
      ).json()) as { destination: { id: number } }
    ).destination;

    mockFetchOnce({
      url: "https://ping-ok.example.com/hook",
      method: "POST",
      headers: { "X-Webhook-Router-Test": "1" },
      status: 200,
      responseBody: "ok",
    });

    const res = await call(jsonReq(`/api/destinations/${dest.id}/test`, { method: "POST", auth }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; status_code: number | null; duration_ms: number; error: string | null };
    expect(json.ok).toBe(true);
    expect(json.status_code).toBe(200);
    expect(typeof json.duration_ms).toBe("number");
    expect(json.error).toBeNull();

    // ping não cria evento nem delivery
    const events = await countEvents(endpoint.id);
    expect(events).toBe(0);
  });

  it("destino que responde 500 retorna ok=false sem criar evento/delivery", async () => {
    const auth = await authHeader();
    const endpoint = (
      (await (
        await call(jsonReq("/api/endpoints", { method: "POST", body: JSON.stringify({ name: "ep-ping-erro" }), auth }))
      ).json()) as { endpoint: { id: number } }
    ).endpoint;
    const dest = (
      (await (
        await call(
          jsonReq(`/api/endpoints/${endpoint.id}/destinations`, {
            method: "POST",
            body: JSON.stringify({ url: "https://ping-erro.example.com/hook" }),
            auth,
          })
        )
      ).json()) as { destination: { id: number } }
    ).destination;

    mockFetchOnce({ url: "https://ping-erro.example.com/hook", method: "POST", status: 500, responseBody: "erro" });

    const res = await call(jsonReq(`/api/destinations/${dest.id}/test`, { method: "POST", auth }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; status_code: number | null; error: string | null };
    expect(json.ok).toBe(false);
    expect(json.status_code).toBe(500);
    expect(json.error).toBeTruthy();

    const events = await countEvents(endpoint.id);
    expect(events).toBe(0);
  });
});

async function countEvents(endpointId: number): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id FROM events WHERE endpoint_id = ?").bind(endpointId).all();
  return (results ?? []).length;
}

describe("filtros do feed de eventos (status e data)", () => {
  it("filtra por status de delivery e valida parametros", async () => {
    const auth = await authHeader();
    const ep = (await env.DB.prepare(
      "INSERT INTO endpoints (name, token, signing_secret) VALUES ('filtro-feed', 'tokfiltrofeed1234', 'aa') RETURNING id"
    ).first<{ id: number }>())!;
    const dest = (await env.DB.prepare(
      "INSERT INTO destinations (endpoint_id, url, timeout_ms) VALUES (?, 'https://x.example.com', 5000) RETURNING id"
    ).bind(ep.id).first<{ id: number }>())!;

    const evOk = (await env.DB.prepare(
      "INSERT INTO events (endpoint_id, method, query, headers) VALUES (?, 'POST', '', '{}') RETURNING id"
    ).bind(ep.id).first<{ id: number }>())!;
    const evFail = (await env.DB.prepare(
      "INSERT INTO events (endpoint_id, method, query, headers) VALUES (?, 'POST', '', '{}') RETURNING id"
    ).bind(ep.id).first<{ id: number }>())!;
    await env.DB.prepare(
      "INSERT INTO deliveries (event_id, destination_id, status) VALUES (?, ?, 'success'), (?, ?, 'failed')"
    ).bind(evOk.id, dest.id, evFail.id, dest.id).run();

    const failed = await call(jsonReq(`/api/endpoints/${ep.id}/events?status=failed`, { auth }));
    expect(failed.status).toBe(200);
    const failedBody = (await failed.json()) as { events: Array<{ id: number }> };
    expect(failedBody.events.map((e) => e.id)).toEqual([evFail.id]);

    const futuro = await call(jsonReq(`/api/endpoints/${ep.id}/events?from=2099-01-01`, { auth }));
    expect(((await futuro.json()) as { events: unknown[] }).events).toHaveLength(0);

    const passado = await call(jsonReq(`/api/endpoints/${ep.id}/events?from=2020-01-01&to=2099-01-01`, { auth }));
    expect(((await passado.json()) as { events: unknown[] }).events).toHaveLength(2);

    const statusInvalido = await call(jsonReq(`/api/endpoints/${ep.id}/events?status=xyz`, { auth }));
    expect(statusInvalido.status).toBe(400);
    const dataInvalida = await call(jsonReq(`/api/endpoints/${ep.id}/events?from=ontem`, { auth }));
    expect(dataInvalida.status).toBe(400);
  });
});
describe("checagem de atualizacao (/api/update-status)", () => {
  it("compara a versao local com o package.json do repositorio oficial", async () => {
    const auth = await authHeader();
    mockFetchOnce({
      url: "https://raw.githubusercontent.com/Expert-Integrado/webhook-router/master/package.json",
      method: "GET",
      status: 200,
      responseBody: JSON.stringify({ version: "99.0.0" }),
    });
    const res = await call(jsonReq("/api/update-status", { auth }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current: string; latest: string; update_available: boolean };
    expect(body.latest).toBe("99.0.0");
    expect(body.update_available).toBe(true);
  });

  it("falha de rede nao quebra: update_available=false com latest=null", async () => {
    const auth = await authHeader();
    mockFetchOnce({
      url: "https://raw.githubusercontent.com/Expert-Integrado/webhook-router/master/package.json",
      method: "GET",
      status: 500,
      responseBody: "erro",
    });
    const res = await call(jsonReq("/api/update-status", { auth }));
    const body = (await res.json()) as { latest: string | null; update_available: boolean };
    expect(body.latest).toBeNull();
    expect(body.update_available).toBe(false);
  });
});