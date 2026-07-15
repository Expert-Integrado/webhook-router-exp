# Webhook Router — Runbook para o Claude Code

Este arquivo instrui o **Claude Code** a instalar, atualizar e diagnosticar o Webhook Router com o mínimo de intervenção humana. Se o usuário disser "instale", "faça o deploy", "configure" ou algo equivalente, siga o runbook abaixo na ordem, executando os comandos você mesmo e só envolvendo o usuário nos 2 pontos marcados como 🙋.

## O que é este projeto

Roteador fan-out de webhooks single-tenant em Cloudflare Workers: recebe webhooks em `/in/{token}` e replica método, headers, query e body para N destinos cadastrados, com retry automático e painel de administração em `/`. Spec completa em `docs/superpowers/specs/2026-07-15-webhook-router-design.md` (v1) e `docs/superpowers/specs/2026-07-15-webhook-router-v1.1-design.md` (v1.1). Desde a migration `0002_signing_and_rules.sql`, cada entrega leva assinatura HMAC (`X-Webhook-Router-Signature`), destinos aceitam filtro/transformação de payload e há botão "Testar" no painel para ping manual.

## Instalação (execute na ordem)

1. **Pré-requisitos:** rode `node --version`. Se não houver Node 18+, oriente a instalar o Node LTS em https://nodejs.org e pare até resolver.
2. **Dependências:** `npm install`.
3. **Login na Cloudflare:** rode `npx wrangler whoami`.
   - Se não estiver logado: 🙋 peça ao usuário para rodar ele mesmo `npx wrangler login` (abre o navegador para autorizar — é interativo, não rode você). Se ele não tiver conta, oriente a criar grátis em https://dash.cloudflare.com/sign-up antes. Depois confirme com `npx wrangler whoami`.
4. **Banco de dados:** verifique o `wrangler.toml`. Se `database_id` ainda for `PLACEHOLDER`:
   - Rode `npx wrangler d1 create webhook-router`, capture o `database_id` da saída e **edite o `wrangler.toml`** preenchendo-o.
   - Se o banco já existir na conta (erro de duplicado), recupere o id com `npx wrangler d1 list`.
5. **Migrations:** `npx wrangler d1 migrations apply webhook-router --remote`.
6. **Senha do painel:** 🙋 pergunte ao usuário se ele quer definir a própria senha ou se você deve gerar uma forte. Se gerar, use 20+ caracteres aleatórios e **mostre a senha ao usuário pedindo que guarde** (ela não fica salva em lugar nenhum do projeto). Defina com `npx wrangler secret put ADMIN_PASSWORD` (o comando lê a senha via stdin — no PowerShell: `'A_SENHA' | npx wrangler secret put ADMIN_PASSWORD`). NUNCA grave a senha em arquivo do repositório.
7. **Deploy:** `npx wrangler deploy`. Capture a URL final (`https://webhook-router.<conta>.workers.dev`).
8. **Verificação real (obrigatória antes de declarar pronto):**
   - `GET <url>/api/me` deve responder `401` (auth funcionando).
   - `GET <url>/in/token-inexistente` deve responder `404`.
   - Abra/mostre a URL do painel e confirme com o usuário que a tela de login aparece.
9. **Primeiro uso:** oriente o usuário: logar com a senha → "Novo endpoint" → copiar a URL `/in/{token}` → colar no campo de webhook da plataforma de origem (ex.: Z-API) → cadastrar os destinos.

## Atualização

`git pull` → `npm install` → `npx wrangler d1 migrations apply webhook-router --remote` → `npx wrangler deploy`.

## Diagnóstico

- Webhook não chega ao destino: `npx wrangler tail` enquanto dispara um teste; verifique também o log de entregas no painel (status, código HTTP, erro).
- Login falha: a senha é o secret `ADMIN_PASSWORD` — redefina com `npx wrangler secret put ADMIN_PASSWORD` + novo deploy.
- Erros de banco: confira `database_id` no `wrangler.toml` e se as migrations foram aplicadas com `--remote`.
- Limites do plano grátis: 100 mil requests/dia, D1 5 GB. Payloads > 1 MB são encaminhados mas não ficam retidos (sem replay).

## Regras para agentes trabalhando neste repo

- Fonte única de configuração: `wrangler.toml` + secrets. Nunca duplicar valores.
- Migrations sempre aditivas; novas migrations em `migrations/` numeradas em sequência (ex.: `0002_signing_and_rules.sql` adiciona `signing_secret`, `filter_json` e `transform_json`).
- Strings de UI e erros de API em PT-BR.
- Nunca commitar segredos; `.dev.vars` está no `.gitignore`.
