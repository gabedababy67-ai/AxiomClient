const state = { user: null, license: null, config: null };
const loginGate = document.getElementById('loginGate');
const dashApp = document.getElementById('dashApp');

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
async function jsonFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...options, headers });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : { error: await res.text() };
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function setStatus(id, text, ok = false) { const el = document.getElementById(id); el.className = `status ${ok ? 'success' : 'error'}`; el.textContent = text; }
function showLogin(error = '') {
  loginGate.classList.remove('hidden'); dashApp.classList.add('hidden');
  const messages = { missing_role: 'Your Discord account is missing the required Axiom role.', not_in_server: 'Join the configured Axiom Discord server first.', discord_not_configured: 'The owners have not finished Discord OAuth setup yet.', oauth_state: 'Discord sign-in expired. Please try again.', oauth_token: 'Discord sign-in failed. Please try again.' };
  document.getElementById('loginError').textContent = messages[error] || '';
}
function showApp() { loginGate.classList.add('hidden'); dashApp.classList.remove('hidden'); }
function switchTab(name) {
  document.querySelectorAll('.dash-tab').forEach(x => x.classList.toggle('active', x.id === `tab-${name}`));
  document.querySelectorAll('.side-item').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  const url = new URL(location.href); url.searchParams.set('tab', name); history.replaceState(null, '', url);
  if (name === 'reviews') loadFeed('review', 'dashboardReviews');
  if (name === 'suggestions') loadFeed('suggestion', 'suggestionFeed');
  if (name === 'basefinds') loadFeed('basefind', 'baseFeed');
  if (name === 'utilities') loadResetStatus();
}

document.querySelectorAll('.side-item').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

document.getElementById('logoutBtn').addEventListener('click', async () => { try { await jsonFetch('/api/auth/logout', { method: 'POST' }); } catch {} location.href = '/'; });

document.getElementById('redeemForm').addEventListener('submit', async e => {
  e.preventDefault(); setStatus('redeemStatus', 'Checking key…', true);
  try {
    const data = await jsonFetch('/api/dashboard/redeem', { method: 'POST', body: JSON.stringify({ key: document.getElementById('redeemKey').value, clientId: document.getElementById('redeemClientId').value }) });
    setStatus('redeemStatus', `Key successful — active until ${new Date(data.license.expires_at).toLocaleString()}`, true); await loadLicense();
  } catch (err) { setStatus('redeemStatus', err.message); }
});

document.getElementById('downloadBtn').addEventListener('click', async () => {
  try { const data = await jsonFetch('/api/dashboard/download-ticket', { method: 'POST' }); location.href = `/api/download/windows?ticket=${encodeURIComponent(data.ticket)}`; }
  catch (err) { alert(err.message); switchTab('redeem'); }
});

async function loadLicense() {
  const data = await jsonFetch('/api/dashboard/license'); state.license = data.license;
  const active = Boolean(data.license?.active);
  document.getElementById('profilePlan').textContent = active ? `Axiom+ · ${daysRemaining(data.license.expires_at)}` : 'No active license';
  document.getElementById('deviceCount').textContent = `Devices ${data.license?.client_id ? '1' : '0'}/1`;
  document.getElementById('deviceSlotText').textContent = `${data.license?.client_id ? '1' : '0'}/1 in use`;
  document.getElementById('downloadBtn').classList.toggle('disabled-btn', !active);
}
function daysRemaining(date) { const ms = new Date(date).getTime() - Date.now(); if (ms <= 0) return 'expired'; const d = Math.ceil(ms / 86400000); return `${d} day${d === 1 ? '' : 's'} left`; }

async function loadFeed(type, target) {
  const el = document.getElementById(target); el.innerHTML = '<div class="panel-blue feed-empty">Loading…</div>';
  try {
    const data = await jsonFetch(`/api/community/${type}`);
    el.innerHTML = data.posts.length ? data.posts.map(p => `<article class="panel-blue feed-card"><div><b>${escapeHtml(p.title || p.username)}</b><small>${escapeHtml(p.username)} · ${new Date(p.created_at).toLocaleString()}</small></div><p>${escapeHtml(p.body)}</p>${type === 'review' ? `<span class="stars">${'★'.repeat(p.rating || 5)}</span>` : ''}</article>`).join('') : '<div class="panel-blue feed-empty">Nothing here yet.</div>';
  } catch (err) { el.innerHTML = `<div class="panel-blue feed-empty">${escapeHtml(err.message)}</div>`; }
}
function bindPostForm(formId, type, fields, statusId, target) {
  document.getElementById(formId).addEventListener('submit', async e => {
    e.preventDefault();
    const body = {}; for (const [key, id] of Object.entries(fields)) body[key] = document.getElementById(id).value;
    try { await jsonFetch(`/api/community/${type}`, { method: 'POST', body: JSON.stringify(body) }); setStatus(statusId, 'Posted successfully.', true); e.target.reset(); await loadFeed(type, target); }
    catch (err) { setStatus(statusId, err.message); }
  });
}
bindPostForm('reviewForm', 'review', { title: 'reviewTitle', rating: 'reviewRating', body: 'reviewBody' }, 'reviewStatus', 'dashboardReviews');
bindPostForm('basefindForm', 'basefind', { title: 'baseTitle', body: 'baseBody' }, 'baseStatus', 'baseFeed');
bindPostForm('suggestionForm', 'suggestion', { title: 'suggestionTitle', body: 'suggestionBody' }, 'suggestionStatus', 'suggestionFeed');

async function loadResetStatus() {
  try { const data = await jsonFetch('/api/dashboard/hwid-reset-status'); document.getElementById('resetCount').textContent = `${data.remaining} of 2 resets available`; }
  catch { document.getElementById('resetCount').textContent = 'Reset status unavailable'; }
}
document.getElementById('hwidResetBtn').addEventListener('click', async () => {
  if (!confirm('Reset the client ID bound to your Axiom license?')) return;
  try { const data = await jsonFetch('/api/dashboard/hwid-reset', { method: 'POST' }); alert(`Axiom device binding reset. ${data.remaining} reset(s) remain in the current 30-day window.`); await loadLicense(); await loadResetStatus(); }
  catch (err) { alert(err.message); }
});
document.getElementById('configResetBtn').addEventListener('click', () => { location.href = '/api/dashboard/default-config'; });
document.getElementById('analyzeBtn').addEventListener('click', async () => {
  const result = document.getElementById('crashResult'); result.textContent = 'Analyzing…';
  try { const data = await jsonFetch('/api/dashboard/analyze-log', { method: 'POST', body: JSON.stringify({ log: document.getElementById('crashLog').value }) }); result.innerHTML = data.findings.map(x => `<p>• ${escapeHtml(x)}</p>`).join(''); }
  catch (err) { result.textContent = err.message; }
});
document.getElementById('deviceSlotBtn').addEventListener('click', e => { if (state.config?.deviceSlotUrl) e.currentTarget.href = state.config.deviceSlotUrl; });

async function boot() {
  const params = new URLSearchParams(location.search); const error = params.get('error');
  try {
    const [me, cfg] = await Promise.all([jsonFetch('/api/auth/me'), jsonFetch('/api/config')]); state.user = me.user; state.config = cfg;
    if (!state.user?.hasAccess) return showLogin('missing_role'); showApp();
    document.getElementById('profileName').textContent = state.user.username; if (state.user.avatar) document.getElementById('profileAvatar').src = state.user.avatar;
    document.getElementById('clientVersion').textContent = cfg.version || '1.0.0'; document.getElementById('updateVersion').textContent = `Axiom ${cfg.version || '1.0.0'}`; document.getElementById('updatedText').textContent = `Last updated ${cfg.updated || 'recently'}`;
    document.getElementById('deviceSlotBtn').href = cfg.deviceSlotUrl || '#';
    await loadLicense();
    const requested = params.get('tab'); switchTab(['downloads','updates','redeem','reviews','basefinds','suggestions','utilities','faq'].includes(requested) ? requested : 'downloads');
  } catch { showLogin(error || ''); }
}
boot();
