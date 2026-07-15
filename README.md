# Webhook Router

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Expert-Integrado/webhook-router)

🌐 **Página do projeto:** [expert-integrado.github.io/webhook-router](https://expert-integrado.github.io/webhook-router/)

Um "distribuidor" de webhooks: você recebe 1 webhook e ele reenvia automaticamente para vários destinos ao mesmo tempo.

## Qual problema isso resolve?

Muitas plataformas (por exemplo, a **Z-API**, usada para WhatsApp) só permitem cadastrar **um único** endereço de webhook. Mas na prática você quase sempre precisa mandar esse mesmo evento para mais de um lugar — o n8n, um CRM, uma planilha, um sistema interno, etc.

O Webhook Router resolve isso ficando no meio do caminho: a plataforma manda o webhook só para ele, e ele copia e reenvia (com o mesmo método, cabeçalhos, texto e tudo mais) para quantos destinos você quiser cadastrar. Se um destino cair, ele tenta de novo automaticamente por algumas horas.

Cada entrega sai assinada (HMAC), você pode filtrar/transformar o que cada destino recebe, e dá pra testar um destino com 1 clique sem esperar um webhook real chegar. Você gerencia tudo por um painel visual simples, em português.

## Pré-requisitos

- **Conta na Cloudflare** — grátis. Crie em https://dash.cloudflare.com/sign-up se ainda não tiver.
- **Node.js (versão LTS)** instalado no seu computador — necessário só para os caminhos B e C abaixo. Baixe em https://nodejs.org (escolha a versão marcada "LTS").

## Instalação

Existem três caminhos. Se você não quer usar terminal, prefira o **caminho A**. Se você usa o **Claude Code**, o **caminho B** faz quase tudo sozinho.

### Caminho A — Botão "Deploy to Cloudflare" (1 clique, sem terminal)

Clique no botão no topo deste README. Segundo a [documentação oficial da Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/), o fluxo clona este repositório para a sua conta, builda e publica o Worker, e **provisiona automaticamente um banco D1 novo, na sua conta** — ele escreve o `database_id` desse banco novo no `wrangler.toml` do seu projeto (não reaproveita o banco do Asafe, mesmo que o `database_id` dele esteja commitado no repo).

As tabelas do banco também são criadas automaticamente: o script `deploy` deste projeto aplica as migrations antes de publicar, e o fluxo do botão executa esse script.

O que pode ficar manual — **definir a senha do painel (`ADMIN_PASSWORD`)**. O fluxo do botão pode pedir esse valor durante a configuração (ele lê o arquivo `.dev.vars.example`); se não pedir, até você definir a senha a tela de login mostra um card "Quase lá!" com estas mesmas instruções. Duas formas de definir:

- **Pelo dashboard (sem terminal):** Cloudflare Dashboard → seu Worker → **Settings** → **Variables and Secrets** → **Add** → nome `ADMIN_PASSWORD`, tipo **Secret**, valor a sua senha → salvar.
- **Pelo terminal:** `npx wrangler secret put ADMIN_PASSWORD`.

Depois disso, abra a URL do Worker (aparece no dashboard da Cloudflare, formato `https://webhook-router.<sua-conta>.workers.dev`) e siga o "Primeiro uso" abaixo.

### Caminho B — Instalação automática com Claude Code (recomendado se você já usa Claude Code)

1. Abra o Claude Code dentro da pasta do projeto.
2. Diga: **"instale o webhook router"**.
3. O Claude executa todos os passos por você (dependências, banco de dados, migrations, publicação), seguindo o runbook do arquivo `CLAUDE.md`. Você só precisa intervir em dois momentos:
   - **Login na Cloudflare:** ele vai pedir que você rode `npx wrangler login` (abre o navegador para autorizar).
   - **Senha do painel:** você escolhe uma senha ou pede para ele gerar uma forte (guarde-a — ela não fica salva em lugar nenhum).
4. Ao final, ele mostra a URL do seu painel e confere se está tudo funcionando.

### Caminho C — Instalação manual (passo a passo)

Abra o terminal (PowerShell) dentro da pasta do projeto e siga os passos na ordem.

#### 1. Instalar as dependências do projeto

```powershell
npm install
```
Baixa as bibliotecas que o projeto usa. Resultado esperado: uma pasta `node_modules` é criada, sem mensagens de erro em vermelho.

#### 2. Fazer login na Cloudflare

```powershell
npx wrangler login
```
Abre o navegador para você autorizar o acesso à sua conta Cloudflare. Resultado esperado: mensagem "Successfully logged in" no terminal.

#### 3. Criar o banco de dados

```powershell
npx wrangler d1 create webhook-router
```
Cria o banco de dados (D1) onde ficam os endpoints, destinos e histórico de eventos. Resultado esperado: um bloco de texto com `database_id`, algo como `"database_id": "xxxxxxxx-xxxx-..."`.

Copie esse `database_id` e cole no arquivo `wrangler.toml`, substituindo o `database_id` existente.

#### 4. Aplicar a estrutura das tabelas no banco

```powershell
npx wrangler d1 migrations apply webhook-router --remote
```
Cria as tabelas dentro do banco que você acabou de criar. Resultado esperado: mensagem confirmando que as migrations foram aplicadas.

#### 5. Definir a senha do painel

```powershell
npx wrangler secret put ADMIN_PASSWORD
```
Pede que você digite (e confirme) a senha que vai usar para entrar no painel. Escolha uma senha forte — é a única proteção do sistema. Resultado esperado: mensagem confirmando que o secret foi salvo.

#### 6. Publicar (deploy)

```powershell
npx wrangler deploy
```
Publica o Webhook Router na internet, na infraestrutura da Cloudflare. Resultado esperado: uma URL no formato `https://webhook-router.<sua-conta>.workers.dev`.

## Primeiro uso

1. Abra a URL do seu Worker no navegador.
2. Digite a senha que você definiu e entre.
3. Clique em "criar endpoint" e dê um nome (ex.: "WhatsApp Loja").
4. Copie a URL gerada, no formato `.../in/{token}`.
5. Cole essa URL no campo de webhook da plataforma de origem (ex.: Z-API).
6. Dentro do endpoint, cadastre os destinos (as URLs para onde o webhook deve ser replicado) — quantos precisar.

Pronto: toda vez que a plataforma disparar o webhook, o Webhook Router replica para todos os destinos ativos automaticamente.

## Testando um destino sem esperar um webhook real

No painel, cada destino tem um botão **"Testar"**. Ele dispara na hora um envio de teste (`{"teste":true,...}`, com a mesma assinatura HMAC de uma entrega real) só para aquele destino — não gera evento nem fica no histórico. O resultado aparece do lado do botão: `✓ 200 · 134ms` em verde se o destino respondeu 2xx, ou `✗ HTTP 500` / `✗ timeout` em vermelho caso contrário. Útil para confirmar que a URL do destino está certa antes de conectar a plataforma de origem.

## Verificando a assinatura HMAC no destino

Toda entrega do Webhook Router (inclusive retries e o botão "Testar") sai com dois headers:

- `X-Webhook-Router-Timestamp`: horário do envio, em segundos Unix.
- `X-Webhook-Router-Signature`: `sha256=<hex>`, um HMAC-SHA256 calculado com o **signing secret do endpoint** (visível no detalhe do endpoint no painel, com botão de rotacionar) sobre a string `"<timestamp>." + body cru enviado`.

Isso deixa o destino confirmar que o webhook realmente veio do seu Webhook Router, e não de qualquer um que descobriu a URL. Exemplo pronto para um **Code node do n8n** (recebendo de um node Webhook com a opção **"Raw Body"** ligada, para ter o body cru sem reformatação):

```javascript
const crypto = require('crypto');

const headers = $input.first().json.headers;
const rawBody = $input.first().json.body; // string crua — requer "Raw Body" ligado no node Webhook

const timestamp = headers['x-webhook-router-timestamp'];
const signature = (headers['x-webhook-router-signature'] || '').replace('sha256=', '');
const secret = 'COLE_AQUI_O_SIGNING_SECRET_DO_ENDPOINT'; // painel → endpoint → "Assinatura HMAC"

// Rejeita timestamp com mais de 5 minutos (evita reenvio malicioso de uma requisição antiga)
const agoraEmSegundos = Math.floor(Date.now() / 1000);
if (!timestamp || Math.abs(agoraEmSegundos - Number(timestamp)) > 300) {
  throw new Error('Timestamp da assinatura ausente ou expirado (mais de 5 min) — webhook rejeitado');
}

const assinaturaEsperada = crypto
  .createHmac('sha256', secret)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');

const assinaturaValida =
  signature.length === assinaturaEsperada.length &&
  crypto.timingSafeEqual(Buffer.from(assinaturaEsperada, 'hex'), Buffer.from(signature, 'hex'));

if (!assinaturaValida) {
  throw new Error('Assinatura HMAC inválida — webhook rejeitado');
}

return $input.all();
```

Se algum dia você suspeitar que o secret foi exposto, use o botão "Rotacionar" no painel — isso invalida a verificação em todos os destinos até você atualizar o secret usado neles.

## Filtro e transformação por destino

Cada destino pode ter, opcionalmente, um **filtro** (só recebe o webhook se as condições casarem) e uma **transformação** (recebe um body diferente do original). Ambos ficam na seção "Regras" ao editar o destino no painel, e só se aplicam quando o body do webhook é JSON — body que não é JSON é sempre encaminhado intacto.

**Exemplo prático (Z-API):** a Z-API manda vários tipos de evento no mesmo webhook (`type` no body: `ReceivedCallback`, `DeliveryCallback`, `ConnectedCallback`, etc.). Se um dos seus destinos só deve reagir a mensagens recebidas, configure o filtro desse destino como:

```json
[{ "path": "type", "op": "equals", "value": "ReceivedCallback" }]
```

Os outros tipos de evento simplesmente não geram entrega para esse destino (os demais destinos, sem filtro, continuam recebendo tudo normalmente).

Para transformação, as opções no painel são: enviar tudo (padrão, igual v1), enviar apenas alguns campos (ex.: só `phone` e `message`, preservando o aninhamento), ou um template avançado (JSON com `{{caminho}}` substituído pelos valores do body original) — útil quando o destino espera um formato bem diferente do original.

## Atualização

Quando houver uma nova versão do código:

```powershell
git pull
npm install
npx wrangler d1 migrations apply webhook-router --remote
npx wrangler deploy
```
`git pull` baixa as últimas mudanças do código; `npm install` atualiza as dependências; o comando de migrations aplica mudanças de banco caso a nova versão traga alguma (se não trouxer, ele só avisa que não há nada a aplicar — é assim que a migration `0002` adiciona assinatura HMAC e regras de filtro/transformação sem quebrar quem já está em produção); `npx wrangler deploy` publica a nova versão. Não é necessário repetir login nem senha. Com Claude Code: basta dizer "atualize o webhook router".

## Solução de problemas

**Tela de login mostra "Quase lá!" em vez do formulário**
A senha do painel (`ADMIN_PASSWORD`) ainda não foi definida. Siga o passo 2 do Caminho A (ou o passo 5 do Caminho C) e recarregue a página.

**"Login falhou" ao rodar `wrangler login`**
Verifique se você está logado na conta Cloudflare certa no navegador que abriu. Rode `npx wrangler logout` e tente `npx wrangler login` novamente.

**O webhook não chega no destino**
- Use o botão "Testar" no destino para isolar se o problema é a URL do destino ou o disparo do evento em si.
- Confira se o endpoint e os destinos estão marcados como "ativo" no painel.
- Se o destino tem filtro configurado, confirme que o tipo de evento realmente casa com a condição — eventos filtrados não aparecem como falha, simplesmente não geram entrega.
- Abra o endpoint no painel e veja o feed de eventos: se o evento aparece lá mas com status de falha, o problema é no destino (fora do ar, URL errada, ou transformação com template inválido — veja o `last_error`). Use o botão "Reenviar".
- Se o evento nem aparece, confira se a URL colada na plataforma de origem está correta (deve terminar em `/in/{token}`).

**Ver os logs em tempo real**

```powershell
npx wrangler tail
```
Mostra em tempo real o que está acontecendo no Worker enquanto os webhooks chegam. Útil para diagnosticar erros no momento em que ocorrem. Deixe esse comando rodando e dispare um webhook de teste para ver o log aparecer.

**Limites do plano grátis da Cloudflare**
O plano gratuito permite até **100.000 requisições por dia**. Isso conta tanto os webhooks recebidos quanto os reenviados para os destinos. Para a maioria dos casos de uso da mentoria isso é bem mais que suficiente — mas se você tiver um volume muito alto, monitore no painel da Cloudflare (dashboard do Worker → aba Analytics).
