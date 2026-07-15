// Webhook Router — painel SPA (vanilla JS, sem build step)

const app = document.getElementById('app');
const drawerEl = document.getElementById('drawer');
const drawerBackdrop = document.getElementById('drawer-backdrop');
const toastsEl = document.getElementById('toasts');

const state = {
  authenticated: false,
  route: { name: 'login' },
  loading: false,
  passwordConfigured: true, // F1: assume ok até o /api/setup-status responder, evita flash
  endpoints: [],
  currentEndpointId: null,
  currentEndpoint: null,
  showCreateEndpoint: false,
  editingDestinationId: null,
  events: [],
  eventsExhausted: false,
  drawerEvent: null,
  testResults: {}, // F2: { [destinationId]: { loading?, ok?, text } }
  showSigningSecret: false, // F3
  rulesEditingId: null, // F4: id do destino com o painel de regras aberto
  rulesDraft: null, // F4: { destId, filters:[{path,op,value}], mode, pickPaths, template }
  eventFilters: { status: '', from: '', to: '' },
  updateStatus: null, // { current, latest, update_available } — checado 1x por sessão
  showUpdateHelp: false,
};

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v.includes('T') ? v : v.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return v;
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function toast(msg, type) {
  const div = document.createElement('div');
  div.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');
  div.textContent = msg;
  toastsEl.appendChild(div);
  setTimeout(() => {
    div.style.transition = 'opacity .3s ease';
    div.style.opacity = '0';
    setTimeout(() => div.remove(), 300);
  }, 3800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('URL copiada para a área de transferência.', 'success');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('URL copiada.', 'success');
    } catch (e2) {
      toast('Não foi possível copiar a URL.', 'error');
    }
    document.body.removeChild(ta);
  }
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ponytail: sessão inválida em qualquer chamada volta pro login direto no fetch wrapper,
// exceto no login em si (tratado separadamente para não virar loop).
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    showLogin();
    throw new ApiError('Sessão expirada.', 401);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = null; }
  }
  if (!res.ok) {
    throw new ApiError((data && data.error) || `Erro inesperado (${res.status}).`, res.status);
  }
  return data;
}

async function doLogin(password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || 'Senha incorreta.');
  return data;
}

// ---------- roteamento ----------

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('endpoints/')) return { name: 'endpoint', id: hash.split('/')[1] };
  return { name: 'dashboard' };
}

function onRouteChange() {
  if (!state.authenticated) return;
  closeDrawer();
  const route = parseRoute();
  state.route = route;
  if (route.name === 'endpoint') {
    if (String(state.currentEndpointId) !== String(route.id)) {
      state.currentEndpointId = route.id;
      state.events = [];
      state.eventsExhausted = false;
      state.eventFilters = { status: '', from: '', to: '' };
      state.editingDestinationId = null;
      state.testResults = {};
      state.showSigningSecret = false;
      state.rulesEditingId = null;
      state.rulesDraft = null;
    }
    loadEndpointDetail(route.id);
  } else {
    loadDashboard();
  }
}

// F1: checa se ADMIN_PASSWORD já foi configurado antes de mostrar o form de login.
async function showLogin() {
  state.authenticated = false;
  state.route = { name: 'login' };
  render();
  try {
    const res = await fetch('/api/setup-status', { credentials: 'same-origin' });
    const data = await res.json();
    state.passwordConfigured = data.password_configured !== false;
  } catch (e) {
    state.passwordConfigured = true; // falha na checagem: não bloquear a tela de login
  }
  render();
}

async function boot() {
  document.body.addEventListener('click', onGlobalClick);
  document.body.addEventListener('submit', onGlobalSubmit);
  document.body.addEventListener('change', onGlobalChange);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  drawerBackdrop.addEventListener('click', closeDrawer);
  window.addEventListener('hashchange', onRouteChange);

  try {
    await api('/api/me');
    state.authenticated = true;
    onRouteChange();
  } catch (e) {
    showLogin();
  }
}

// ---------- carregamento de dados ----------

async function loadDashboard() {
  state.loading = true;
  render();
  try {
    state.endpoints = await api('/api/endpoints');
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  } finally {
    state.loading = false;
    render();
  }
  checkForUpdate();
}

// checa 1x por sessão se há versão nova no repositório oficial
async function checkForUpdate() {
  if (state.updateStatus !== null) return;
  try {
    state.updateStatus = await api('/api/update-status');
    if (state.updateStatus.update_available) render();
  } catch (e) { /* silencioso — banner é cortesia, não funcionalidade */ }
}

function updateBannerHtml() {
  const u = state.updateStatus;
  if (!u || !u.update_available) return '';
  return `
    <div class="update-banner">
      <div class="update-banner-text">
        <strong>Nova versão disponível</strong> — você está na v${esc(u.current)} e a v${esc(u.latest)} já saiu.
      </div>
      <button class="btn btn-sm" type="button" data-action="toggle-update-help">Como atualizar</button>
    </div>
    ${state.showUpdateHelp ? `
    <div class="update-help">
      <p><strong>Instalou com o Claude Code?</strong> Abra o Claude Code na pasta do projeto e diga: <code>atualize o webhook router</code>.</p>
      <p><strong>Instalou pelo botão Deploy to Cloudflare?</strong> Abra o seu repositório no GitHub e clique em <em>Sync fork → Update branch</em> (se existir); o deploy acontece sozinho depois disso. Se o botão não existir no seu repositório, use o caminho do terminal abaixo.</p>
      <p><strong>Pelo terminal:</strong> na pasta do projeto, rode <code>git pull</code> e depois <code>npm run deploy</code> (aplica as migrations e publica).</p>
      <p class="faint">O que mudou: veja em <a href="https://github.com/Expert-Integrado/webhook-router/commits/master" target="_blank" rel="noopener">github.com/Expert-Integrado/webhook-router</a>.</p>
    </div>` : ''}`;
}

async function loadEndpointDetail(id) {
  state.loading = true;
  render();
  try {
    const list = await api('/api/endpoints');
    state.endpoints = list;
    state.currentEndpoint = list.find((e) => String(e.id) === String(id)) || null;
    if (!state.currentEndpoint) {
      toast('Endpoint não encontrado.', 'error');
      location.hash = '#/';
      return;
    }
    if (state.events.length === 0) await loadEvents(id, false);
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  } finally {
    state.loading = false;
    render();
  }
}

async function refreshCurrentEndpoint() {
  try {
    const list = await api('/api/endpoints');
    state.endpoints = list;
    state.currentEndpoint = list.find((e) => String(e.id) === String(state.currentEndpointId)) || null;
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  }
  render();
}

async function loadEvents(id, more) {
  const params = new URLSearchParams({ limit: '50' });
  if (more && state.events.length) params.set('before', String(state.events[state.events.length - 1].id));
  const f = state.eventFilters || {};
  if (f.status) params.set('status', f.status);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  const data = await api(`/api/endpoints/${id}/events?${params.toString()}`);
  const list = Array.isArray(data) ? data : (data && data.events) || [];
  state.events = more ? state.events.concat(list) : list;
  if (!more) state.eventsExhausted = false;
  if (list.length < 50) state.eventsExhausted = true;
}

async function applyEventFilters(form) {
  const fd = new FormData(form);
  state.eventFilters = {
    status: String(fd.get('status') || ''),
    from: String(fd.get('from') || ''),
    to: String(fd.get('to') || ''),
  };
  try {
    await loadEvents(state.currentEndpointId, false);
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  }
  render();
}

async function clearEventFilters() {
  state.eventFilters = { status: '', from: '', to: '' };
  try {
    await loadEvents(state.currentEndpointId, false);
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  }
  render();
}

async function handleLoadMoreEvents() {
  try {
    await loadEvents(state.currentEndpointId, true);
    render();
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  }
}

// ---------- ações ----------

async function doLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignora */ }
  showLogin();
}

async function createEndpoint(form) {
  const fd = new FormData(form);
  const name = (fd.get('name') || '').trim();
  if (!name) { toast('Informe um nome para o endpoint.', 'error'); return; }
  try {
    await api('/api/endpoints', { method: 'POST', body: { name } });
    toast('Endpoint criado.', 'success');
    state.showCreateEndpoint = false;
    await loadDashboard();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteEndpoint(id) {
  const ep = state.endpoints.find((e) => String(e.id) === String(id));
  if (!window.confirm(`Excluir o endpoint "${ep ? ep.name : id}"? Destinos e histórico de eventos associados serão removidos. Essa ação não pode ser desfeita.`)) return;
  try {
    await api(`/api/endpoints/${id}`, { method: 'DELETE' });
    toast('Endpoint excluído.', 'success');
    if (state.route.name === 'endpoint' && String(state.currentEndpointId) === String(id)) {
      location.hash = '#/';
    } else {
      await loadDashboard();
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function renameEndpoint(id) {
  const ep = state.endpoints.find((e) => String(e.id) === String(id));
  const name = window.prompt('Novo nome do endpoint:', ep ? ep.name : '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { toast('O nome não pode ser vazio.', 'error'); return; }
  try {
    await api(`/api/endpoints/${id}`, { method: 'PATCH', body: { name: trimmed } });
    toast('Nome atualizado.', 'success');
    await refreshCurrentEndpoint();
    if (state.route.name === 'dashboard') await loadDashboard();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function rotateToken(id) {
  if (!window.confirm('Rotacionar o token invalida a URL de entrada atual imediatamente — atualize a plataforma de origem depois. Continuar?')) return;
  try {
    await api(`/api/endpoints/${id}/rotate-token`, { method: 'POST' });
    toast('Token rotacionado.', 'success');
    await refreshCurrentEndpoint();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function toggleEndpoint(id, checked) {
  try {
    await api(`/api/endpoints/${id}`, { method: 'PATCH', body: { active: checked } });
    toast(checked ? 'Endpoint ativado.' : 'Endpoint pausado.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
  if (state.route.name === 'endpoint') await refreshCurrentEndpoint(); else await loadDashboard();
}

async function toggleDestination(id, checked) {
  try {
    await api(`/api/destinations/${id}`, { method: 'PATCH', body: { active: checked } });
    toast(checked ? 'Destino ativado.' : 'Destino pausado.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
  if (state.route.name === 'endpoint') await refreshCurrentEndpoint(); else await loadDashboard();
}

async function deleteDestination(id) {
  if (!window.confirm('Excluir este destino? Ele deixará de receber novas entregas.')) return;
  try {
    await api(`/api/destinations/${id}`, { method: 'DELETE' });
    toast('Destino excluído.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
  await refreshCurrentEndpoint();
}

async function saveDestination(id, form) {
  const fd = new FormData(form);
  const body = {
    label: fd.get('label') || '',
    url: fd.get('url'),
    timeout_ms: Number(fd.get('timeout_ms')) || 10000,
  };
  try {
    await api(`/api/destinations/${id}`, { method: 'PATCH', body });
    toast('Destino atualizado.', 'success');
    state.editingDestinationId = null;
    await refreshCurrentEndpoint();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function addDestination(endpointId, form) {
  const fd = new FormData(form);
  const body = { label: fd.get('label') || '', url: fd.get('url') };
  const timeout = fd.get('timeout_ms');
  if (timeout) body.timeout_ms = Number(timeout);
  try {
    await api(`/api/endpoints/${endpointId}/destinations`, { method: 'POST', body });
    toast('Destino adicionado.', 'success');
    form.reset();
    await refreshCurrentEndpoint();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- F2: ping de teste de destino ----------

async function testDestination(id) {
  state.testResults[id] = { loading: true };
  render();
  try {
    const data = await api(`/api/destinations/${id}/test`, { method: 'POST' });
    let text;
    if (data.ok) {
      text = `✓ ${data.status_code} · ${data.duration_ms}ms`;
    } else if (data.status_code) {
      text = `✗ HTTP ${data.status_code}`;
    } else if (data.error && /timeout/i.test(data.error)) {
      text = '✗ timeout';
    } else {
      text = `✗ ${data.error || 'falha'}`;
    }
    state.testResults[id] = { ok: data.ok, text };
  } catch (e) {
    state.testResults[id] = { ok: false, text: '✗ ' + (e.message || 'erro') };
  }
  render();
  setTimeout(() => {
    delete state.testResults[id];
    render();
  }, 6000);
}

// ---------- F3: assinatura HMAC do endpoint ----------

async function rotateSigningSecret(id) {
  if (!window.confirm('Rotacionar o segredo de assinatura invalida as verificações HMAC existentes nos destinos — eles vão rejeitar entregas até você atualizar o segredo lá também. Continuar?')) return;
  try {
    await api(`/api/endpoints/${id}/rotate-signing-secret`, { method: 'POST' });
    toast('Segredo de assinatura rotacionado.', 'success');
    state.showSigningSecret = true;
    await refreshCurrentEndpoint();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- F4: filtro e transformação por destino ----------

function draftFromDestination(d) {
  let filters = [];
  try {
    const arr = d.filter_json ? JSON.parse(d.filter_json) : [];
    if (Array.isArray(arr)) {
      filters = arr.map((f) => ({
        path: f && f.path ? String(f.path) : '',
        op: f && f.op ? String(f.op) : 'equals',
        value: f && f.value !== undefined ? String(f.value) : '',
      }));
    }
  } catch (e) { /* filter_json inválido: trata como vazio */ }

  let mode = 'all', pickPaths = '', template = '';
  try {
    if (d.transform_json) {
      const t = JSON.parse(d.transform_json);
      if (t.mode === 'pick') {
        mode = 'pick';
        pickPaths = Array.isArray(t.paths) ? t.paths.join(', ') : '';
      } else if (t.mode === 'template') {
        mode = 'template';
        template = typeof t.template === 'string' ? t.template : '';
      }
    }
  } catch (e) { /* transform_json inválido: trata como "enviar tudo" */ }

  return { destId: d.id, filters, mode, pickPaths, template };
}

// lê o formulário de regras renderizado e atualiza o draft em state — necessário
// antes de qualquer mutação que force um re-render (add/remove linha, trocar modo),
// senão o texto já digitado nos outros campos se perde.
function syncRulesDraftFromDom() {
  if (!state.rulesDraft) return;
  const form = document.querySelector(`[data-role="rules-form"][data-id="${state.rulesDraft.destId}"]`);
  if (!form) return;
  const rows = Array.from(form.querySelectorAll('[data-role="filter-row"]'));
  state.rulesDraft.filters = rows.map((row) => ({
    path: row.querySelector('[data-field="path"]').value,
    op: row.querySelector('[data-field="op"]').value,
    value: row.querySelector('[data-field="value"]').value,
  }));
  const modeInput = form.querySelector('input[name="transform-mode"]:checked');
  if (modeInput) state.rulesDraft.mode = modeInput.value;
  const pickInput = form.querySelector('[data-field="pick-paths"]');
  if (pickInput) state.rulesDraft.pickPaths = pickInput.value;
  const templateInput = form.querySelector('[data-field="template"]');
  if (templateInput) state.rulesDraft.template = templateInput.value;
}

function toggleRules(destId) {
  if (String(state.rulesEditingId) === String(destId)) {
    state.rulesEditingId = null;
    state.rulesDraft = null;
  } else {
    const dest = ((state.currentEndpoint && state.currentEndpoint.destinations) || []).find((d) => String(d.id) === String(destId));
    if (!dest) return;
    state.rulesEditingId = destId;
    state.rulesDraft = draftFromDestination(dest);
  }
  render();
}

async function saveRules(destId) {
  syncRulesDraftFromDom();
  const draft = state.rulesDraft;
  if (!draft) return;

  const filters = draft.filters
    .filter((f) => f.path && f.path.trim())
    .map((f) => {
      const row = { path: f.path.trim(), op: f.op };
      if (f.op !== 'exists' && f.op !== 'not_exists') row.value = f.value ?? '';
      return row;
    });
  const filter_json = filters.length ? JSON.stringify(filters) : null;

  let transform_json = null;
  if (draft.mode === 'pick') {
    const paths = (draft.pickPaths || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!paths.length) {
      toast('Informe ao menos um campo em "Enviar apenas campos…".', 'error');
      return;
    }
    transform_json = JSON.stringify({ mode: 'pick', paths });
  } else if (draft.mode === 'template') {
    const tpl = draft.template || '';
    try {
      JSON.parse(tpl);
    } catch (e) {
      toast('Template inválido — precisa ser um JSON válido (coloque {{caminho}} entre aspas quando o valor for substituído).', 'error');
      return;
    }
    transform_json = JSON.stringify({ mode: 'template', template: tpl });
  }

  try {
    await api(`/api/destinations/${destId}`, { method: 'PATCH', body: { filter_json, transform_json } });
    toast('Regras salvas.', 'success');
    state.rulesEditingId = null;
    state.rulesDraft = null;
    await refreshCurrentEndpoint();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function replayEvent(id) {
  try {
    await api(`/api/events/${id}/replay`, { method: 'POST' });
    toast('Replay disparado para os destinos ativos.', 'success');
    await openEventDrawer(id);
    state.events = [];
    state.eventsExhausted = false;
    await loadEvents(state.currentEndpointId, false);
    render();
  } catch (e) {
    if (e.status === 409) toast('Corpo do evento não foi retido (maior que 1 MB) — replay indisponível.', 'error');
    else toast(e.message, 'error');
  }
}

async function retryDelivery(id) {
  try {
    await api(`/api/deliveries/${id}/retry`, { method: 'POST' });
    toast('Reenvio agendado.', 'success');
    if (state.drawerEvent) await openEventDrawer(state.drawerEvent.id);
  } catch (e) {
    if (e.status === 409) toast('Corpo do evento não foi retido — reenvio indisponível.', 'error');
    else toast(e.message, 'error');
  }
}

async function openEventDrawer(id) {
  try {
    const data = await api(`/api/events/${id}`);
    state.drawerEvent = data;
    drawerEl.innerHTML = renderDrawerContent(data);
    drawerEl.hidden = false;
    drawerBackdrop.hidden = false;
    requestAnimationFrame(() => {
      drawerEl.classList.add('show');
      drawerBackdrop.classList.add('show');
    });
    drawerEl.setAttribute('aria-hidden', 'false');
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  }
}

function closeDrawer() {
  if (drawerEl.hidden) return;
  drawerEl.classList.remove('show');
  drawerBackdrop.classList.remove('show');
  drawerEl.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    drawerEl.hidden = true;
    drawerBackdrop.hidden = true;
  }, 250);
  state.drawerEvent = null;
}

// ---------- delegação de eventos ----------

function onGlobalClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const { action, id, value } = el.dataset;
  switch (action) {
    case 'logout': return doLogout();
    case 'go-dashboard': location.hash = '#/'; return;
    case 'open-endpoint': location.hash = `#/endpoints/${id}`; return;
    case 'show-create-endpoint': state.showCreateEndpoint = true; render(); return;
    case 'hide-create-endpoint': state.showCreateEndpoint = false; render(); return;
    case 'copy': copyText(value); return;
    case 'delete-endpoint': deleteEndpoint(id); return;
    case 'rename-endpoint': renameEndpoint(id); return;
    case 'rotate-token': rotateToken(id); return;
    case 'delete-destination': deleteDestination(id); return;
    case 'edit-destination': state.editingDestinationId = id; render(); return;
    case 'cancel-edit-destination': state.editingDestinationId = null; render(); return;
    case 'test-destination': testDestination(id); return;
    case 'toggle-signing-secret': state.showSigningSecret = !state.showSigningSecret; render(); return;
    case 'rotate-signing-secret': rotateSigningSecret(id); return;
    case 'toggle-rules': toggleRules(id); return;
    case 'add-filter-row':
      syncRulesDraftFromDom();
      if (state.rulesDraft) state.rulesDraft.filters.push({ path: '', op: 'equals', value: '' });
      render();
      return;
    case 'remove-filter-row':
      syncRulesDraftFromDom();
      if (state.rulesDraft) state.rulesDraft.filters.splice(Number(value), 1);
      render();
      return;
    case 'save-rules': saveRules(id); return;
    case 'cancel-rules': state.rulesEditingId = null; state.rulesDraft = null; render(); return;
    case 'recheck-setup': showLogin(); return;
    case 'open-event': openEventDrawer(id); return;
    case 'close-drawer': closeDrawer(); return;
    case 'replay-event': replayEvent(id); return;
    case 'retry-delivery': retryDelivery(id); return;
    case 'load-more-events': handleLoadMoreEvents(); return;
    case 'clear-event-filters': clearEventFilters(); return;
    case 'toggle-update-help': state.showUpdateHelp = !state.showUpdateHelp; render(); return;
    default: return;
  }
}

function onGlobalSubmit(e) {
  const form = e.target;
  if (form.id === 'login-form') { e.preventDefault(); return handleLoginSubmit(form); }
  if (form.id === 'create-endpoint-form') { e.preventDefault(); return createEndpoint(form); }
  if (form.id === 'add-destination-form') { e.preventDefault(); return addDestination(form.dataset.endpoint, form); }
  if (form.dataset.role === 'edit-destination-form') { e.preventDefault(); return saveDestination(form.dataset.id, form); }
  if (form.id === 'event-filters-form') { e.preventDefault(); return applyEventFilters(form); }
}

function onGlobalChange(e) {
  const el = e.target;
  if (!el.dataset) return;
  if (el.dataset.action === 'toggle-destination') toggleDestination(el.dataset.id, el.checked);
  else if (el.dataset.action === 'toggle-endpoint') toggleEndpoint(el.dataset.id, el.checked);
  else if (el.name === 'transform-mode') { syncRulesDraftFromDom(); render(); }
  else if (el.dataset.field === 'op') {
    // ponytail: some/desabilita o campo "valor" via DOM direto (sem render) pra não
    // perder texto já digitado em outras linhas do formulário de regras.
    const row = el.closest('[data-role="filter-row"]');
    const valueInput = row ? row.querySelector('[data-field="value"]') : null;
    if (valueInput) {
      const hide = el.value === 'exists' || el.value === 'not_exists';
      valueInput.disabled = hide;
      valueInput.placeholder = hide ? '(não aplicável)' : 'valor';
      if (hide) valueInput.value = '';
    }
  }
}

async function handleLoginSubmit(form) {
  const fd = new FormData(form);
  const password = fd.get('password');
  const btn = form.querySelector('button[type=submit]');
  const errBox = form.querySelector('#login-error');
  btn.disabled = true;
  errBox.hidden = true;
  try {
    await doLogin(password);
    state.authenticated = true;
    if (location.hash) onRouteChange(); else { location.hash = '#/'; }
  } catch (e) {
    errBox.textContent = e.message || 'Senha incorreta.';
    errBox.hidden = false;
    btn.disabled = false;
  }
}

// ---------- render: shell ----------

function render() {
  if (!state.authenticated || state.route.name === 'login') {
    app.innerHTML = renderLogin();
    return;
  }
  app.innerHTML = state.route.name === 'endpoint' ? renderEndpointDetail() : renderDashboard();
}

function topbarHtml() {
  return `
    <div class="topbar">
      <div class="brand"><span class="brand-mark">🪝</span> Webhook Router</div>
      <div class="topbar-actions"><button class="btn btn-ghost btn-sm" type="button" data-action="logout">Sair</button></div>
    </div>`;
}

function loadingHtml() {
  return `<div class="loading-block"><span class="spinner"></span> Carregando…</div>`;
}

// ---------- render: login ----------

function renderLogin() {
  if (state.passwordConfigured === false) return renderSetupCard();
  return `
    <div class="login-screen">
      <form class="login-card" id="login-form">
        <div class="brand"><span class="brand-mark">🪝</span> Webhook Router</div>
        <div class="sub">Acesso restrito — informe a senha do painel</div>
        <div class="field">
          <label for="password">Senha</label>
          <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
        </div>
        <div id="login-error" class="field-error" hidden></div>
        <button class="btn btn-primary" type="submit">Entrar</button>
      </form>
    </div>`;
}

// F1: painel sem ADMIN_PASSWORD configurado — instruções em vez do formulário.
function renderSetupCard() {
  return `
    <div class="login-screen">
      <div class="login-card setup-card">
        <div class="brand"><span class="brand-mark">🪝</span> Webhook Router</div>
        <h2 class="setup-title">Quase lá!</h2>
        <p class="setup-lead">O painel já está no ar, mas a senha de acesso ainda não foi configurada. Defina o secret <code class="inline-code">ADMIN_PASSWORD</code> para liberar o login.</p>
        <div class="setup-steps">
          <div class="setup-step">
            <strong>Opção 1 — via terminal</strong>
            <div class="code-block">npx wrangler secret put ADMIN_PASSWORD</div>
          </div>
          <div class="setup-step">
            <strong>Opção 2 — via painel da Cloudflare</strong>
            <p>Dashboard da Cloudflare → seu Worker → <em>Settings</em> → <em>Variables and Secrets</em> → adicionar <code class="inline-code">ADMIN_PASSWORD</code>.</p>
          </div>
        </div>
        <button class="btn btn-primary" type="button" style="width:100%;margin-top:6px;" data-action="recheck-setup">Já configurei — verificar de novo</button>
      </div>
    </div>`;
}

// ---------- render: dashboard ----------

function renderDashboard() {
  const eps = state.endpoints || [];
  return `
    ${topbarHtml()}
    <div class="page">
      <div class="page-header">
        <div>
          <h1>Endpoints</h1>
          <div class="sub">Gerencie os pontos de entrada e para onde cada um replica os eventos.</div>
        </div>
        <button class="btn btn-primary" type="button" data-action="show-create-endpoint">+ Novo endpoint</button>
      </div>
      ${updateBannerHtml()}
      ${state.showCreateEndpoint ? createEndpointFormHtml() : ''}
      ${state.loading ? loadingHtml() : (eps.length ? `<div class="endpoint-grid">${eps.map(endpointCardHtml).join('')}</div>` : dashboardEmptyHtml())}
    </div>`;
}

function createEndpointFormHtml() {
  return `
    <form id="create-endpoint-form" class="add-dest-card" style="margin-bottom:20px;">
      <div class="form-row">
        <div class="field" style="flex:2;">
          <label for="new-endpoint-name">Nome do endpoint</label>
          <input id="new-endpoint-name" name="name" required placeholder="Ex.: Z-API — Loja Principal" autofocus />
        </div>
        <button class="btn btn-primary" type="submit">Criar</button>
        <button class="btn btn-ghost" type="button" data-action="hide-create-endpoint">Cancelar</button>
      </div>
    </form>`;
}

function dashboardEmptyHtml() {
  return `
    <div class="empty">
      <div class="empty-icon">🪶</div>
      <h3>Nenhum endpoint ainda</h3>
      <p>Crie o primeiro endpoint para começar a receber e distribuir webhooks.</p>
      <button class="btn btn-primary" type="button" data-action="show-create-endpoint">Criar o primeiro endpoint</button>
    </div>`;
}

function endpointCardHtml(ep) {
  const inUrl = `${location.origin}/in/${ep.token}`;
  const stats = ep.stats || {};
  const dests = ep.destinations || [];
  return `
    <div class="card">
      <div class="card-head">
        <div class="card-title"><h3 title="${esc(ep.name)}">${esc(ep.name)}</h3></div>
        <span class="badge ${ep.active ? 'badge-on' : 'badge-off'}">${ep.active ? 'Ativo' : 'Pausado'}</span>
      </div>
      <div class="url-row">
        <code title="${esc(inUrl)}">${esc(inUrl)}</code>
        <button class="btn btn-icon btn-ghost btn-sm" type="button" title="Copiar URL" data-action="copy" data-value="${esc(inUrl)}">📋</button>
      </div>
      <div class="stats-row">
        <span class="count count-ok" title="Sucesso nas últimas 24h">✓ ${stats.success_24h ?? 0}</span>
        <span class="count count-fail" title="Falhas nas últimas 24h">✗ ${stats.failed_24h ?? 0}</span>
      </div>
      <div class="dest-list">
        ${dests.length ? dests.slice(0, 4).map(destRowMiniHtml).join('') : '<div class="dest-empty">Nenhum destino cadastrado</div>'}
        ${dests.length > 4 ? `<button class="dest-more" type="button" data-action="open-endpoint" data-id="${ep.id}">+ ${dests.length - 4} destino${dests.length - 4 > 1 ? 's' : ''} — ver todos →</button>` : ''}
      </div>
      <div class="card-footer">
        <button class="btn btn-sm btn-ghost" type="button" data-action="open-endpoint" data-id="${ep.id}">Ver detalhes →</button>
        <button class="btn btn-sm btn-ghost btn-danger" type="button" data-action="delete-endpoint" data-id="${ep.id}">Excluir</button>
      </div>
    </div>`;
}

function destRowMiniHtml(d) {
  return `
    <div class="dest-row">
      <span class="dest-label" title="${esc(d.url)}">${esc(d.label || d.url)}${destBadgesHtml(d)}</span>
      <label class="switch" title="Ativar/pausar destino">
        <input type="checkbox" ${d.active ? 'checked' : ''} data-action="toggle-destination" data-id="${d.id}" />
        <span class="track"></span><span class="thumb"></span>
      </label>
    </div>`;
}

// F4: badges "filtro"/"transform" quando o destino tem regras ativas.
function destBadgesHtml(d) {
  let html = '';
  if (d.filter_json) html += `<span class="badge badge-rule" title="Tem filtro configurado">filtro</span>`;
  if (d.transform_json) html += `<span class="badge badge-rule" title="Tem transformação configurada">transform</span>`;
  return html;
}

// ---------- render: detalhe do endpoint ----------

function renderEndpointDetail() {
  const ep = state.currentEndpoint;
  if (!ep) return `${topbarHtml()}<div class="page">${loadingHtml()}</div>`;
  const inUrl = `${location.origin}/in/${ep.token}`;
  const dests = ep.destinations || [];
  return `
    ${topbarHtml()}
    <div class="page">
      <button class="back-link" type="button" data-action="go-dashboard">← Voltar para endpoints</button>
      <div class="detail-head">
        <div class="detail-title">
          <h1>${esc(ep.name)}</h1>
          <span class="badge ${ep.active ? 'badge-on' : 'badge-off'}">${ep.active ? 'Ativo' : 'Pausado'}</span>
        </div>
        <div class="detail-actions">
          <label class="switch" title="Ativar/pausar endpoint">
            <input type="checkbox" ${ep.active ? 'checked' : ''} data-action="toggle-endpoint" data-id="${ep.id}" />
            <span class="track"></span><span class="thumb"></span>
          </label>
          <button class="btn btn-sm" type="button" data-action="rename-endpoint" data-id="${ep.id}">Renomear</button>
          <button class="btn btn-sm" type="button" data-action="rotate-token" data-id="${ep.id}">Rotacionar token</button>
          <button class="btn btn-sm btn-danger" type="button" data-action="delete-endpoint" data-id="${ep.id}">Excluir endpoint</button>
        </div>
      </div>
      <div class="url-row" style="max-width:560px;margin-bottom:32px;">
        <code title="${esc(inUrl)}">${esc(inUrl)}</code>
        <button class="btn btn-icon btn-ghost btn-sm" type="button" title="Copiar URL" data-action="copy" data-value="${esc(inUrl)}">📋</button>
      </div>

      <div class="section">
        <div class="section-head"><h2>Assinatura HMAC</h2></div>
        <p class="field-hint" style="margin-bottom:10px;">Toda entrega leva os headers <code class="inline-code">X-Webhook-Router-Timestamp</code> e <code class="inline-code">X-Webhook-Router-Signature</code>, calculados com este segredo — use para verificar a origem no destino.</p>
        <div class="secret-row">
          <code class="secret-value">${state.showSigningSecret ? esc(ep.signing_secret || '') : maskSecret(ep.signing_secret)}</code>
          <button class="btn btn-icon btn-ghost btn-sm" type="button" title="${state.showSigningSecret ? 'Ocultar segredo' : 'Mostrar segredo'}" data-action="toggle-signing-secret">${state.showSigningSecret ? '🙈' : '👁'}</button>
          <button class="btn btn-icon btn-ghost btn-sm" type="button" title="Copiar segredo" data-action="copy" data-value="${esc(ep.signing_secret || '')}">📋</button>
        </div>
        <button class="btn btn-sm" type="button" style="margin-top:10px;" data-action="rotate-signing-secret" data-id="${ep.id}">Rotacionar segredo</button>
      </div>

      <div class="section">
        <div class="section-head"><h2>Destinos</h2></div>
        ${dests.length ? dests.map(destManageRowHtml).join('') : '<p class="faint">Nenhum destino cadastrado ainda.</p>'}
        ${addDestinationFormHtml(ep.id)}
      </div>

      <div class="section">
        <div class="section-head"><h2>Eventos recebidos</h2></div>
        ${eventFiltersHtml()}
        ${renderEventsFeed()}
      </div>
    </div>`;
}

function destManageRowHtml(d) {
  if (String(state.editingDestinationId) === String(d.id)) {
    return `
      <form class="dest-manage-row" data-role="edit-destination-form" data-id="${d.id}">
        <input name="label" value="${esc(d.label)}" placeholder="Rótulo" />
        <input name="url" type="url" required value="${esc(d.url)}" placeholder="https://" />
        <input name="timeout_ms" type="number" min="1000" step="500" value="${d.timeout_ms}" />
        <span></span>
        <div class="actions">
          <button class="btn btn-sm btn-primary" type="submit">Salvar</button>
          <button class="btn btn-sm btn-ghost" type="button" data-action="cancel-edit-destination">Cancelar</button>
        </div>
      </form>`;
  }
  const test = state.testResults[d.id];
  const testHtml = test
    ? (test.loading
        ? `<span class="test-result test-loading">testando…</span>`
        : `<span class="test-result ${test.ok ? 'test-ok' : 'test-fail'}">${esc(test.text)}</span>`)
    : '';
  const rulesOpen = String(state.rulesEditingId) === String(d.id);
  return `
    <div class="dest-block">
      <div class="dest-manage-row">
        <span>${esc(d.label) || '<span class="faint">(sem rótulo)</span>'}${destBadgesHtml(d)}</span>
        <span class="url-text" title="${esc(d.url)}">${esc(d.url)}</span>
        <span class="faint" style="font-size:12px;">${d.timeout_ms} ms</span>
        <label class="switch" title="Ativar/pausar destino">
          <input type="checkbox" ${d.active ? 'checked' : ''} data-action="toggle-destination" data-id="${d.id}" />
          <span class="track"></span><span class="thumb"></span>
        </label>
        <div class="actions">
          <button class="btn btn-sm btn-ghost" type="button" data-action="test-destination" data-id="${d.id}">Testar</button>
          ${testHtml}
          <button class="btn btn-sm btn-ghost" type="button" data-action="toggle-rules" data-id="${d.id}">${rulesOpen ? 'Ocultar regras' : 'Regras'}</button>
          <button class="btn btn-sm btn-ghost" type="button" data-action="edit-destination" data-id="${d.id}">Editar</button>
          <button class="btn btn-sm btn-ghost btn-danger" type="button" data-action="delete-destination" data-id="${d.id}">Excluir</button>
        </div>
      </div>
      ${rulesOpen ? rulesPanelHtml(d) : ''}
    </div>`;
}

// ---------- F4: painel de regras (filtro + transformação) ----------

function rulesPanelHtml(d) {
  const draft = state.rulesDraft;
  if (!draft) return '';
  const filters = draft.filters || [];
  return `
    <div class="rules-panel">
      <div class="rules-warning">⚠ Regras valem só para body JSON — body não-JSON é sempre encaminhado intacto (filtro passa, transformação é ignorada).</div>
      <form data-role="rules-form" data-id="${d.id}">
        <div class="rules-section">
          <div class="rules-section-title">Filtro <span class="faint">(vazio = recebe tudo)</span></div>
          <div class="filter-rows">
            ${filters.length
              ? filters.map((f, i) => filterRowHtml(f, i)).join('')
              : '<p class="faint" style="margin:2px 0 8px;">Nenhuma condição — recebe todos os eventos.</p>'}
          </div>
          <button class="btn btn-sm btn-ghost" type="button" data-action="add-filter-row" data-id="${d.id}">+ adicionar condição</button>
          <div class="field-hint" style="margin-top:8px;">Condições combinadas em E (AND). Campo em dot notation, ex.: <code class="inline-code">data.tipo</code>.</div>
        </div>
        <div class="rules-section">
          <div class="rules-section-title">Transformação</div>
          <label class="radio-row">
            <input type="radio" name="transform-mode" value="all" ${draft.mode === 'all' ? 'checked' : ''} />
            Enviar tudo (padrão)
          </label>
          <label class="radio-row">
            <input type="radio" name="transform-mode" value="pick" ${draft.mode === 'pick' ? 'checked' : ''} />
            Enviar apenas campos…
          </label>
          ${draft.mode === 'pick' ? `<input class="pick-paths-input" data-field="pick-paths" placeholder="ex.: nome, contato.telefone" value="${esc(draft.pickPaths)}" />` : ''}
          <label class="radio-row">
            <input type="radio" name="transform-mode" value="template" ${draft.mode === 'template' ? 'checked' : ''} />
            Template avançado
          </label>
          ${draft.mode === 'template' ? `<textarea class="template-input" data-field="template" rows="6" placeholder='{"nome": "{{nome}}"}'>${esc(draft.template)}</textarea>` : ''}
        </div>
        <div class="rules-actions">
          <button class="btn btn-sm btn-primary" type="button" data-action="save-rules" data-id="${d.id}">Salvar regras</button>
          <button class="btn btn-sm btn-ghost" type="button" data-action="cancel-rules" data-id="${d.id}">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function filterRowHtml(f, i) {
  const disabledValue = f.op === 'exists' || f.op === 'not_exists';
  return `
    <div class="filter-row" data-role="filter-row">
      <span class="filter-and">${i > 0 ? 'E' : ''}</span>
      <input data-field="path" value="${esc(f.path)}" placeholder="campo (ex.: type)" />
      <select data-field="op">${filterOpOptionsHtml(f.op)}</select>
      <input data-field="value" value="${esc(f.value)}" placeholder="valor" ${disabledValue ? 'disabled' : ''} />
      <button class="btn btn-icon btn-ghost btn-sm" type="button" data-action="remove-filter-row" data-value="${i}" title="Remover condição">✕</button>
    </div>`;
}

function filterOpOptionsHtml(selected) {
  const ops = [
    ['equals', 'igual a'],
    ['not_equals', 'diferente de'],
    ['contains', 'contém'],
    ['exists', 'existe'],
    ['not_exists', 'não existe'],
  ];
  return ops.map(([v, label]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${label}</option>`).join('');
}

// F3: mostra o segredo mascarado por padrão.
function maskSecret(secret) {
  if (!secret) return '—';
  return '•'.repeat(Math.min(40, String(secret).length));
}

function addDestinationFormHtml(endpointId) {
  return `
    <form id="add-destination-form" class="add-dest-card" data-endpoint="${endpointId}">
      <div class="form-row">
        <div class="field"><label>Rótulo (opcional)</label><input name="label" placeholder="Ex.: CRM" /></div>
        <div class="field" style="flex:2;"><label>URL de destino</label><input name="url" type="url" required placeholder="https://exemplo.com/webhook" /></div>
        <div class="field" style="max-width:130px;"><label>Timeout (ms)</label><input name="timeout_ms" type="number" min="1000" step="500" placeholder="10000" /></div>
        <button class="btn btn-primary" type="submit">Adicionar destino</button>
      </div>
    </form>`;
}

function hasActiveEventFilters() {
  const f = state.eventFilters || {};
  return !!(f.status || f.from || f.to);
}

function eventFiltersHtml() {
  const f = state.eventFilters || {};
  const statuses = [
    ['', 'Todos os status'],
    ['success', 'Sucesso'],
    ['failed', 'Falha (em retry)'],
    ['exhausted', 'Esgotado'],
    ['pending', 'Pendente'],
  ];
  return `
    <form id="event-filters-form" class="events-filter-bar">
      <select name="status" title="Filtrar por status de entrega">
        ${statuses.map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <label class="filter-date"><span>de</span><input type="date" name="from" value="${esc(f.from || '')}" /></label>
      <label class="filter-date"><span>até</span><input type="date" name="to" value="${esc(f.to || '')}" /></label>
      <button class="btn btn-sm btn-primary" type="submit">Filtrar</button>
      ${hasActiveEventFilters() ? `<button class="btn btn-sm btn-ghost" type="button" data-action="clear-event-filters">Limpar</button>` : ''}
    </form>`;
}

function renderEventsFeed() {
  const events = state.events || [];
  if (!events.length) {
    if (hasActiveEventFilters()) {
      return `
        <div class="empty">
          <div class="empty-icon">🔍</div>
          <h3>Nenhum evento com esses filtros</h3>
          <p>Ajuste o status ou o período e filtre de novo.</p>
        </div>`;
    }
    return `
      <div class="empty">
        <div class="empty-icon">📭</div>
        <h3>Nenhum evento recebido ainda</h3>
        <p>Assim que a plataforma enviar algo para a URL de entrada, os eventos aparecem aqui.</p>
      </div>`;
  }
  return `
    ${events.map(eventRowHtml).join('')}
    ${!state.eventsExhausted ? `<div class="load-more"><button class="btn btn-sm" type="button" data-action="load-more-events">Carregar mais</button></div>` : ''}`;
}

function chipClass(status) {
  return { success: 'chip-success', failed: 'chip-failed', pending: 'chip-pending', exhausted: 'chip-exhausted' }[status] || 'chip-pending';
}
function chipSymbol(status) {
  return { success: '✓', failed: '✗', pending: '…', exhausted: '⨯' }[status] || '•';
}
function statusLabel(status) {
  return { success: 'sucesso', failed: 'falhou', pending: 'pendente', exhausted: 'esgotado' }[status] || status;
}
function deliveryTitle(d) {
  return `tentativas: ${d.attempt_count}${d.last_status_code ? ' · HTTP ' + d.last_status_code : ''}`;
}

function eventRowHtml(ev) {
  const chips = (ev.deliveries || [])
    .map((d) => `<span class="chip ${chipClass(d.status)}" title="${esc(deliveryTitle(d))}">${chipSymbol(d.status)} ${esc(d.destination_label || 'destino')}</span>`)
    .join('');
  return `
    <div class="event-row" data-action="open-event" data-id="${ev.id}">
      <span class="event-method">${esc(ev.method)}</span>
      <div class="event-meta">
        <div class="event-time">${fmtDateTime(ev.received_at)}</div>
        <div class="event-id">#${ev.id}${ev.body_truncated ? ' · corpo não retido' : ''}</div>
      </div>
      <div class="event-chips">${chips}</div>
    </div>`;
}

// ---------- render: drawer de evento ----------

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers === 'string') {
    try { return JSON.parse(headers); } catch (e) { return { raw: headers }; }
  }
  return headers;
}

function headersRowsHtml(headers) {
  const obj = normalizeHeaders(headers);
  const keys = Object.keys(obj);
  if (!keys.length) return `<div class="kv-row"><span class="faint">Nenhum header registrado.</span></div>`;
  return keys.map((k) => `<div class="kv-row"><span class="kv-key">${esc(k)}</span><span class="kv-val">${esc(obj[k])}</span></div>`).join('');
}

// ponytail: o nome exato do campo que sinaliza corpo em base64 não está fixado na spec —
// checa as variações mais prováveis; ajustar aqui se a API usar outro nome.
function isBodyBase64(ev) {
  return Boolean(ev.body_base64 || ev.is_base64 || ev.body_is_base64 || ev.body_encoding === 'base64' || ev.encoding === 'base64');
}

function bodyBlockHtml(ev) {
  if (ev.body_truncated) {
    return `<div class="b64-note">⚠ Corpo não retido — evento maior que 1 MB. Replay e reenvio ficam indisponíveis para este evento.</div>`;
  }
  const body = ev.body;
  if (body === null || body === undefined || body === '') {
    return `<p class="faint">Sem corpo.</p>`;
  }
  if (isBodyBase64(ev)) {
    return `
      <div class="b64-note">ℹ Conteúdo binário — exibido em base64.</div>
      <div class="code-block">${esc(body)}</div>`;
  }
  try {
    const parsed = JSON.parse(body);
    return `<div class="code-block">${esc(JSON.stringify(parsed, null, 2))}</div>`;
  } catch (e) {
    return `<div class="code-block">${esc(body)}</div>`;
  }
}

function deliveryItemHtml(d) {
  const canRetry = d.status === 'failed' || d.status === 'exhausted';
  return `
    <div class="delivery-item">
      <div class="delivery-info">
        <div class="delivery-label">${esc(d.destination_label || ('Destino #' + d.destination_id))}</div>
        <div class="delivery-sub">tentativas: ${d.attempt_count}${d.last_status_code ? ' · HTTP ' + d.last_status_code : ''}${d.last_error ? ' · ' + esc(d.last_error) : ''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="chip ${chipClass(d.status)}">${chipSymbol(d.status)} ${statusLabel(d.status)}</span>
        ${canRetry ? `<button class="btn btn-sm" type="button" data-action="retry-delivery" data-id="${d.id}">Reenviar</button>` : ''}
      </div>
    </div>`;
}

function renderDrawerContent(ev) {
  return `
    <div class="drawer-head">
      <div>
        <h3>Evento #${ev.id}</h3>
        <div class="faint" style="font-size:12.5px;margin-top:4px;">${esc(ev.method)} · ${fmtDateTime(ev.received_at)}${ev.query ? ' · ?' + esc(ev.query) : ''}</div>
      </div>
      <button class="btn btn-icon btn-ghost" type="button" data-action="close-drawer">✕</button>
    </div>
    <div class="drawer-body">
      <div class="section">
        <button class="btn btn-primary btn-sm" type="button" data-action="replay-event" data-id="${ev.id}" ${ev.body_truncated ? 'disabled title="Corpo não retido — replay indisponível"' : ''}>↻ Replay para todos os destinos ativos</button>
      </div>
      <div class="section">
        <div class="section-head"><h2>Headers</h2></div>
        <div class="kv-list">${headersRowsHtml(ev.headers)}</div>
      </div>
      <div class="section">
        <div class="section-head"><h2>Body</h2></div>
        ${bodyBlockHtml(ev)}
      </div>
      <div class="section">
        <div class="section-head"><h2>Entregas por destino</h2></div>
        ${(ev.deliveries || []).map(deliveryItemHtml).join('') || '<p class="faint">Nenhuma entrega registrada.</p>'}
      </div>
    </div>`;
}

boot();
