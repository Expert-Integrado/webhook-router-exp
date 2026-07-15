# Webhook Router — Especificação de Design

**Data:** 2026-07-15 · **Status:** Aprovada por Asafe · **Deploy alvo:** Cloudflare Workers (free tier)

## Problema

Plataformas como Z-API só aceitam **um** webhook de saída. Precisamos de um roteador single-tenant: a plataforma envia para o roteador, e ele replica (fan-out) a requisição — método, headers, query string e body idênticos — para N destinos cadastrados. Vários endpoints de entrada independentes na mesma instalação, gerenciados por um painel visual elegante em PT-BR.

## Decisões aprovadas

| Decisão | Escolha |
|---|---|
| Hospedagem | Cloudflare Workers + D1 + assets estáticos (100% free tier) |
| Auth do painel | Senha única (secret `ADMIN_PASSWORD`), sessão via cookie HMAC |
| Retry | Automático com backoff (1min, 5min, 30min, 2h, 6h — máx 5 tentativas) via cron + reenvio manual |
| Logs | Payload retido 7 dias (permite replay), limpeza via cron diário |
| Idioma UI/docs | Português (BR) |
| Nome do worker | `webhook-router` (genérico, sem nome de projeto) |

## Stack e estrutura de arquivos

- Runtime: Cloudflare Worker, TypeScript, framework **Hono** (v4+).
- Banco: **D1** (binding `DB`), migrations em `migrations/`.
- Painel: SPA estática **sem build step** (vanilla JS) servida via Workers Static Assets (binding `ASSETS`, diretório `public/`).
- Testes: **vitest** + `@cloudflare/vitest-pool-workers`.

```
wrangler.toml            # worker name, D1 binding, assets, 2 crons
package.json             # scripts: dev, deploy, test, db:migrate
migrations/0001_init.sql
src/index.ts             # entry: Hono app + scheduled handler
src/ingest.ts            # recepção + fan-out
src/deliver.ts           # entrega a 1 destino (usado por fan-out, retry, replay)
src/retry.ts             # cron: varre fila de retry + limpeza diária
src/auth.ts              # login, cookie HMAC, middleware
src/api.ts               # rotas /api/* (CRUD + logs + replay)
src/util.ts              # token gen, filtro de headers, backoff
public/index.html        # painel SPA
public/app.js
public/styles.css
test/*.test.ts
docs/backlog.md
README.md                # passo a passo PT-BR para não-técnicos
```

### wrangler.toml (essência)

```toml
name = "webhook-router"
main = "src/index.ts"
compatibility_date = "2026-07-01"

[assets]
directory = "public"
binding = "ASSETS"
# assets NÃO devem interceptar /in/* nem /api/* → run_worker_first = ["/in/*", "/api/*"]

[[d1_databases]]
binding = "DB"
database_name = "webhook-router"
database_id = "PLACEHOLDER"   # preenchido na instalação

[triggers]
crons = ["* * * * *", "0 3 * * *"]   # retry a cada minuto; limpeza 03:00 UTC
```

Secrets (via `wrangler secret put`): `ADMIN_PASSWORD`. A chave de sessão é derivada: `SHA-256("session-v1:" + ADMIN_PASSWORD)` — uma única fonte de segredo.

## Modelo de dados (D1)

```sql
CREATE TABLE endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,          -- 32 chars aleatórios url-safe
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  query TEXT NOT NULL DEFAULT '',      -- query string crua (sem '?')
  headers TEXT NOT NULL,               -- JSON {nome: valor} já filtrado
  body BLOB,                           -- NULL se > 1 MB (body_truncated=1)
  body_truncated INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_endpoint ON events(endpoint_id, received_at DESC);
CREATE INDEX idx_events_received ON events(received_at);

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|success|failed|exhausted
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  last_error TEXT,
  next_retry_at TEXT,                   -- NULL quando success/exhausted
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_deliveries_retry ON deliveries(status, next_retry_at);
CREATE INDEX idx_deliveries_event ON deliveries(event_id);
```

## Fluxo de ingestão (`/in/:token`)

1. Aceita **qualquer método HTTP**. Busca endpoint pelo token; inexistente ou `active=0` → `404` genérico.
2. Lê o body (buffer). Se > 1 MB: seta `body_truncated=1` e persiste `body=NULL`, mas **encaminha o body real** normalmente nesta primeira tentativa (replay/retry ficam indisponíveis para esse evento — retry usa o que está persistido).
3. Persiste `events` + uma linha `deliveries` (status `pending`) por destino ativo.
4. Responde **imediatamente** `200 {"ok":true,"event_id":N}`.
5. Em `ctx.waitUntil`: para cada destino ativo chama `deliver()`.

### `deliver(event, destination, attempt)` — regra única de entrega

- Reconstrói a requisição: mesmo método, URL do destino + `?query` original, headers filtrados, body cru.
- **Filtro de headers** (remoção, case-insensitive): `host`, `content-length`, `connection`, `transfer-encoding`, `expect`, `cf-*`, `x-forwarded-*`, `x-real-ip`. Todos os demais passam intactos (incluindo `content-type`, `authorization` e headers customizados da plataforma).
- Headers adicionados: `X-Webhook-Router-Event: <event_id>`, `X-Webhook-Router-Attempt: <n>`.
- Timeout: `AbortSignal.timeout(destination.timeout_ms)`.
- Sucesso = status HTTP 2xx. Atualiza `deliveries` → `success`.
- Falha (timeout, erro de rede, status ≥ 300): incrementa `attempt_count`, grava `last_status_code`/`last_error`, e:
  - `attempt_count < 5` → `status='failed'`, `next_retry_at = now + backoff[attempt_count]` com `backoff = [1min, 5min, 30min, 2h, 6h]` (indexado por tentativas já feitas: após 1ª falha espera 1min, etc.)
  - `attempt_count >= 5` → `status='exhausted'`, `next_retry_at=NULL`.
- Se o evento tem `body_truncated=1` e a tentativa não é a primeira (sem body persistido), marcar `exhausted` com `last_error='body não retido (>1MB)'`.

## Cron (`scheduled`)

- **A cada minuto:** `SELECT ... FROM deliveries WHERE status='failed' AND next_retry_at <= datetime('now') LIMIT 50` → `deliver()` para cada (com `waitUntil`). Destino desativado/excluído nesse meio-tempo → marcar `exhausted`.
- **03:00 UTC diário:** `DELETE FROM events WHERE received_at < datetime('now','-7 days')` (cascade limpa deliveries).
- Distinguir os dois pelo `event.cron` no handler.

## API do painel (`/api/*`, JSON)

Todas exigem sessão válida, exceto `POST /api/login`. Sem sessão → `401 {"error":"unauthorized"}`.

| Rota | Descrição |
|---|---|
| `POST /api/login` `{password}` | Compara com `ADMIN_PASSWORD` (comparação constant-time). OK → cookie `session` (HMAC-SHA256 de `{exp}` com a chave derivada, validade 7 dias, `HttpOnly; Secure; SameSite=Lax; Path=/`). Falha → `401` + delay de 500 ms. |
| `POST /api/logout` | Expira o cookie. |
| `GET /api/me` | `200 {"ok":true}` se sessão válida (usado pelo SPA no load). |
| `GET /api/endpoints` | Lista com contadores agregados de 24h e 7d: `{id,name,token,active,created_at,stats:{success_24h,failed_24h,pending_24h,total_7d}}` + destinos aninhados. |
| `POST /api/endpoints` `{name}` | Cria com token aleatório de 32 chars (base62, `crypto.getRandomValues`). |
| `PATCH /api/endpoints/:id` `{name?,active?}` | Atualiza. |
| `POST /api/endpoints/:id/rotate-token` | Gera novo token (invalida a URL antiga). |
| `DELETE /api/endpoints/:id` | Remove (cascade). |
| `POST /api/endpoints/:id/destinations` `{label?,url,timeout_ms?}` | Valida URL http(s). |
| `PATCH /api/destinations/:id` `{label?,url?,active?,timeout_ms?}` | Atualiza. |
| `DELETE /api/destinations/:id` | Remove. |
| `GET /api/endpoints/:id/events?before=<id>&limit=50` | Lista eventos (paginação por cursor `before`) com deliveries aninhadas `{destination_label,status,attempt_count,last_status_code}`. |
| `GET /api/events/:id` | Detalhe: headers, body (texto se decodável UTF-8; senão base64 + flag), deliveries completas. |
| `POST /api/events/:id/replay` | Recria deliveries `pending` para todos os destinos ativos atuais e dispara fan-out. `409` se `body_truncated=1`. |
| `POST /api/deliveries/:id/retry` | Zera para nova tentativa imediata (respeita limite de 5? Não — retry manual sempre permite +1 tentativa). `409` se body não retido. |

Erros de validação → `400 {"error":"mensagem em PT-BR"}`.

## Painel (SPA, PT-BR)

- **Login:** tela centrada minimalista, campo de senha único.
- **Dashboard:** cards de endpoints — nome, URL de entrada com botão *copiar*, badge ativo/pausado, mini-contadores (✓ 24h / ✗ 24h), lista de destinos com toggle.
- **Detalhe do endpoint:** gestão de destinos (adicionar/editar/pausar/excluir, testar com ping opcional — fora de escopo v1), feed de eventos com status por destino, clique abre painel lateral com headers/body formatado (JSON pretty-print quando aplicável) e botões **Replay** / **Reenviar** por destino falho.
- **Design:** elegante, dark-first, tipografia system-ui/Inter, sem framework CSS — CSS artesanal caprichado, `styles.css` próprio. Responsivo (funciona no celular). Toda string em PT-BR.
- SPA usa `fetch` com `credentials:'same-origin'`; 401 em qualquer chamada → volta pra tela de login.

## Testes (vitest + pool-workers)

1. **Unit:** filtro de headers (remove os proibidos, preserva o resto), cálculo de backoff, geração/validação do cookie HMAC (expirado → inválido; assinatura errada → inválido), geração de token.
2. **Integração (fetchMock do pool-workers):** ingest → 200 imediato + fan-out para 2 destinos com método/headers/query/body preservados; destino 500 → delivery `failed` com `next_retry_at`; cron reprocessa e marca `success`; 5 falhas → `exhausted`; token inválido → 404; API sem cookie → 401; CRUD endpoint/destination; replay recria deliveries.

## Instalação assistida por Claude Code (caminho recomendado)

Requisito adicionado por Asafe em 2026-07-15: a instalação/onboarding deve ser executável pelo **Claude Code com o mínimo de intervenção humana**.

- O repo inclui um `CLAUDE.md` na raiz com o runbook de instalação para o Claude Code executar: verificar Node, `npm install`, checar login (`npx wrangler whoami`), criar D1 (`npx wrangler d1 create webhook-router`), capturar o `database_id` da saída e **editar o `wrangler.toml` automaticamente**, aplicar migrations `--remote`, definir `ADMIN_PASSWORD` (perguntar ao usuário ou gerar senha forte e exibir), `npx wrangler deploy`, testar a URL final e orientar o primeiro login.
- Únicas intervenções humanas: `npx wrangler login` (auth interativa no navegador — o Claude orienta o usuário a rodar) e a escolha/recebimento da senha do painel.
- O runbook também cobre atualização (`git pull` + `deploy`) e diagnóstico (`wrangler tail`).
- O README apresenta o caminho "Instalação automática com Claude Code" como **caminho A (recomendado)**; o passo a passo manual vira caminho B.

## Instalação (README PT-BR, público não-técnico)

1. Criar conta Cloudflare (grátis).
2. Caminho A — via terminal: instalar Node LTS → `npm install` → `npx wrangler login` → `npx wrangler d1 create webhook-router` (colar o `database_id` no `wrangler.toml`) → `npx wrangler d1 migrations apply webhook-router --remote` → `npx wrangler secret put ADMIN_PASSWORD` → `npx wrangler deploy`.
3. Abrir `https://webhook-router.<sua-conta>.workers.dev`, logar, criar endpoint, copiar URL `/in/{token}`, colar na plataforma (ex.: Z-API), cadastrar destinos.
4. Seção de solução de problemas (login falha, webhook não chega, como ver logs com `wrangler tail`).

## Fora de escopo (v1) → `docs/backlog.md`

1. Transformação/filtro de payload por destino
2. Assinatura HMAC de saída para os destinos verificarem origem
3. Botão "Deploy to Cloudflare" (1 clique)
4. Ping de teste de destino
5. Multi-usuário / multi-tenant
