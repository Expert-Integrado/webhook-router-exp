# Webhook Router v1.1 — Adendo de Design

**Data:** 2026-07-15 · **Status:** Aprovada por Asafe · **Base:** spec v1 (mesmo diretório)

Quatro features do backlog, aprovadas para implementação. **Sem multi-tenant/multi-usuário.** Repo público: `github.com/Expert-Integrado/webhook-router`, licença MIT.

## Migration `0002_signing_and_rules.sql`

```sql
ALTER TABLE endpoints ADD COLUMN signing_secret TEXT;
UPDATE endpoints SET signing_secret = lower(hex(randomblob(32))) WHERE signing_secret IS NULL;
ALTER TABLE destinations ADD COLUMN filter_json TEXT;      -- NULL = sem filtro
ALTER TABLE destinations ADD COLUMN transform_json TEXT;   -- NULL = sem transformação
```

Novos endpoints criados via API: `signing_secret` gerado em código (64 chars hex via `crypto.getRandomValues`).

## F1 — Botão "Deploy to Cloudflare"

- README ganha no topo o botão: `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Expert-Integrado/webhook-router)` e uma seção explicando o fluxo de 1 clique como **caminho A** (Claude Code vira caminho B; manual vira C).
- O agente de docs DEVE pesquisar a documentação oficial atual da Cloudflare sobre Deploy Buttons (WebFetch/Context7) e documentar honestamente: o que o fluxo provisiona sozinho (Worker, D1, migrations?) e o que fica manual (definir `ADMIN_PASSWORD` no dash → Settings do Worker). Não inventar comportamento.
- `database_id` real permanece commitado (instância do Asafe); se a doc indicar que o fluxo do botão NÃO substitui o id ao provisionar, documentar o passo manual.
- **Tela de "senha não configurada":** nova rota `GET /api/setup-status` (SEM auth) → `{"password_configured": boolean}` (true se `env.ADMIN_PASSWORD` existe e não é vazio). O SPA chama no load da tela de login; se `false`, em vez do formulário mostra um card "Quase lá!" com instruções PT-BR para definir a senha (dash da Cloudflare → Worker → Settings → Variables and Secrets → `ADMIN_PASSWORD`, ou `npx wrangler secret put ADMIN_PASSWORD`).
- Adicionar `LICENSE` (MIT, copyright 2026 Expert Integrado).

## F2 — Ping de teste de destino

- `POST /api/destinations/:id/test` (autenticada): dispara na hora, sem criar evento nem delivery:
  - `POST` na URL do destino, body `{"teste":true,"origem":"webhook-router","disparado_em":"<ISO agora>"}`, headers `Content-Type: application/json`, `X-Webhook-Router-Test: 1` + headers de assinatura HMAC (F3) do endpoint dono do destino.
  - Timeout: o `timeout_ms` do destino.
  - Resposta `200 {"ok":bool,"status_code":n|null,"duration_ms":n,"error":string|null}` (`ok` = 2xx).
- Painel: botão "Testar" em cada destino, resultado inline ao lado (ex.: `✓ 200 · 134ms` verde ou `✗ HTTP 500` / `✗ timeout` vermelho), some após alguns segundos.

## F3 — Assinatura HMAC de saída

- **Toda** entrega (fan-out, retry cron, retry manual, replay, ping de teste) leva:
  - `X-Webhook-Router-Timestamp: <unix segundos>`
  - `X-Webhook-Router-Signature: sha256=<hex>` onde hex = HMAC-SHA256(`signing_secret` do endpoint, bytes de `"<timestamp>." + body_final`). Body vazio → assina `"<timestamp>."`.
- A assinatura é calculada sobre o **body final enviado** (pós-transformação F4).
- API: `signing_secret` passa a vir em `GET /api/endpoints`; nova rota `POST /api/endpoints/:id/rotate-signing-secret` → `{ok, id, signing_secret}`.
- Painel: no detalhe do endpoint, seção "Assinatura HMAC" com o secret oculto por padrão (botão mostrar/copiar) e botão "Rotacionar" (com confirmação — invalida verificações existentes nos destinos).
- README: seção "Verificando a assinatura no destino" com snippet pronto para **Code node do n8n** (JavaScript, crypto nativo: recalcular HMAC de `timestamp + "." + body cru` e comparar; rejeitar timestamp com mais de 5 min).

## F4 — Filtro e transformação por destino

Aplicáveis **somente a body JSON parseável**; body não-JSON é sempre encaminhado intacto (filtro passa, transformação é ignorada). Documentar isso no painel e README.

### Filtro (`destinations.filter_json`)

- JSON: array de condições em **AND**: `[{"path":"a.b.c","op":"equals|not_equals|contains|exists|not_exists","value":"..."}]` (`value` ausente para exists/not_exists). Path em dot notation sobre o body.
- Semântica: `equals`/`not_equals` comparam `String(valorNoPath) === value`; `contains` = string contém substring OU array contém o valor (comparação por String); `exists`/`not_exists` = path definido/indefinido.
- Avaliado no **fan-out e no replay**: destino cujo filtro não casa **não recebe delivery** (nenhuma linha criada, igual destino pausado). Retry não reavalia filtro (a delivery já existe).
- `filter_json` NULL ou `[]` = sem filtro.

### Transformação (`destinations.transform_json`)

- JSON, dois modos:
  - `{"mode":"pick","paths":["a.b","c"]}` → body novo contendo só esses paths, estrutura aninhada preservada; path inexistente é ignorado.
  - `{"mode":"template","template":"<string com um JSON contendo {{path}}>"}` → placeholders: se `"{{path}}"` é o valor inteiro de uma string no template, substitui pelo **valor tipado** (número/objeto/bool cru); se aparece dentro de uma string maior, interpola como texto. Resultado deve ser JSON válido; se não for (ou template quebrado), a delivery **falha** com `last_error` explicativo (entra no fluxo normal de retry).
- Aplicada **dentro do `deliver()`** a cada tentativa, usando o `transform_json` atual do destino (o JOIN do retry já traz a linha do destino). Quando aplicada: `Content-Type` do envio vira `application/json` e o HMAC assina o body transformado.
- `transform_json` NULL = espelho fiel (comportamento v1).

### Validação na API

- `POST /api/endpoints/:id/destinations` e `PATCH /api/destinations/:id` aceitam `filter_json` e `transform_json` (string JSON ou null). Validar estrutura (ops válidas, paths string não-vazia, mode válido, template parseável como string) → `400` com mensagem PT-BR específica. Persistir normalizado.
- `GET /api/endpoints` inclui `filter_json`/`transform_json` nos destinos aninhados.

### Painel

- No card/edição de cada destino, seção expansível **"Regras"**:
  - **Filtro:** construtor visual — linhas `[campo] [operador ▾] [valor]` com adicionar/remover; texto de ajuda ("campo em dot notation, ex.: `type`"). Vazio = recebe tudo.
  - **Transformação:** radio `Enviar tudo (padrão)` / `Enviar apenas campos…` (input de paths separados por vírgula ou chips) / `Template avançado` (textarea monoespaçada; validar JSON do template ao salvar).
  - Indicador visual no card do destino quando há filtro/transformação ativa (ex.: badge "filtro" / "transform").

## Testes novos (vitest)

1. HMAC: header presente em fan-out e no retry; assinatura verificável recalculando com o secret; assinada sobre body pós-transform.
2. Filtro: casa → delivery criada; não casa → nenhuma delivery; body não-JSON com filtro → delivery criada; replay respeita filtro.
3. Transform pick: destino recebe só os campos; aninhamento preservado.
4. Transform template: valor tipado vs interpolação em string; template inválido → delivery failed com last_error.
5. Ping: `POST /api/destinations/:id/test` retorna ok/status/duration; destino 500 → ok=false; não cria evento/delivery.
6. `GET /api/setup-status` sem auth responde; rotate-signing-secret muda o secret.

## Sequência de release (executor final)

1. Testes verdes + dry-run.
2. `npx wrangler d1 migrations apply webhook-router --remote` (migration 0002 é aditiva).
3. `npx wrangler deploy` + smoke em produção.
4. Criar repo público `Expert-Integrado/webhook-router` (gh CLI), push do master, conferir se o botão do README renderiza e aponta certo.
5. Backlog: remover itens 1-4 e renumerar.
