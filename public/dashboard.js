const state = { user: null, license: null, config: null, payments: null, ltcPoll: null };
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
function setStatus(id, text, ok = false) {
  const el = document.getElementById(id); if (!el) return;
  el.className = `status ${text ? (ok ? 'success' : 'error') : ''}`; el.textContent = text || '';
}
function showLogin(error = '') {
  loginGate.classList.remove('hidden'); dashApp.classList.add('hidden');
  const messages = {
    not_in_server: 'Join the configured Axiom Discord server first.',
    discord_not_configured: 'Discord OAuth is not fully configured yet.',
    oauth_state: 'Discord sign-in expired. Please try again.',
    oauth_token: 'Discord sign-in failed. Please try again.',
    discord_user: 'Discord could not return your account information.'
  };
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
  if (name === 'utilities' || name === 'license') loadResetStatus();
  if (name === 'license') loadLicense();
  if (name === 'owner' && state.user?.isOwner) loadOwnerLicenses();
}
function money(value) { return Number(value || 0).toFixed(2); }
function formatDate(value) { return value ? new Date(value).toLocaleString() : '—'; }
function daysRemaining(date) {
  const ms = new Date(date).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const d = Math.ceil(ms / 86400000); return `${d} day${d === 1 ? '' : 's'} left`;
}
async function copyText(text) {
  if (!text || text === 'Unavailable' || text === 'Not bound yet') return;
  try { await navigator.clipboard.writeText(text); } catch {
    const input = document.createElement('textarea'); input.value = text; document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
  }
}

async function loadOwnerLicenses() {
  const body = document.getElementById('dashOwnerLicenseRows');
  if (!body || !state.user?.isOwner) return;
  body.innerHTML = '<tr><td colspan="8" class="empty">Loading…</td></tr>';
  try {
    const data = await jsonFetch('/api/admin/licenses');
    if (!data.licenses.length) { body.innerHTML = '<tr><td colspan="8" class="empty">No licenses yet.</td></tr>'; return; }
    body.innerHTML = data.licenses.map(l => {
      const status = l.revoked ? 'revoked' : (l.active ? 'active' : 'expired');
      const type = l.license_type === 'lifetime' ? 'Lifetime' : 'Timed';
      const expiry = l.license_type === 'lifetime' ? 'Lifetime' : new Date(l.expires_at).toLocaleString();
      return `<tr><td><code>${escapeHtml(l.key_preview)}</code></td><td>${type}</td><td><span class="badge ${status}">${status.toUpperCase()}</span></td><td>${l.client_id ? escapeHtml(l.client_id) : 'Unbound'}</td><td>${l.discord_user_id ? escapeHtml(l.discord_user_id) : 'Unbound'}</td><td>${expiry}</td><td>${escapeHtml(l.note || '—')}</td><td><div class="row-actions">${!l.revoked ? `<button data-owner-action="revoke" data-id="${l.id}">Revoke</button>` : ''}${l.client_id ? `<button data-owner-action="unbind" data-id="${l.id}">Unbind</button>` : ''}</div></td></tr>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

function setupOwnerPanel() {
  const mode = document.getElementById('dashOwnerLicenseMode');
  const daysWrap = document.getElementById('dashOwnerDaysWrap');
  const days = document.getElementById('dashOwnerDurationDays');
  const form = document.getElementById('dashOwnerGenerateForm');
  if (!mode || !form) return;

  const sync = () => {
    const lifetime = mode.value === 'lifetime';
    daysWrap.classList.toggle('hidden', lifetime);
    days.required = !lifetime;
  };
  mode.addEventListener('change', sync);
  sync();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    setStatus('dashOwnerGenerateStatus', 'Generating key…', true);
    try {
      const licenseMode = mode.value;
      const data = await jsonFetch('/api/admin/licenses', {
        method: 'POST',
        body: JSON.stringify({
          licenseMode,
          days: licenseMode === 'lifetime' ? null : Number(days.value),
          clientId: document.getElementById('dashOwnerClientId').value,
          discordUserId: document.getElementById('dashOwnerDiscordId').value,
          note: document.getElementById('dashOwnerNote').value
        })
      });
      document.getElementById('dashOwnerGeneratedKey').textContent = data.key;
      document.getElementById('dashOwnerGeneratedExpiry').textContent = data.lifetime ? 'Lifetime access' : `Expires ${new Date(data.expiresAt).toLocaleString()}`;
      document.getElementById('dashOwnerGeneratedBox').classList.remove('hidden');
      setStatus('dashOwnerGenerateStatus', 'Working license key generated.', true);
      await loadOwnerLicenses();
    } catch (err) { setStatus('dashOwnerGenerateStatus', err.message); }
  });

  document.getElementById('dashOwnerCopyKey').addEventListener('click', () => copyText(document.getElementById('dashOwnerGeneratedKey').textContent));
  document.getElementById('dashOwnerRefreshBtn').addEventListener('click', loadOwnerLicenses);
  document.getElementById('dashOwnerLicenseRows').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-owner-action]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await jsonFetch(`/api/admin/licenses/${btn.dataset.id}/${btn.dataset.ownerAction}`, { method: 'POST' });
      await loadOwnerLicenses();
    } catch (err) { alert(err.message); btn.disabled = false; }
  });
}
setupOwnerPanel();

document.querySelectorAll('.side-item').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
document.getElementById('logoutBtn').addEventListener('click', async () => { try { await jsonFetch('/api/auth/logout', { method: 'POST' }); } catch {} location.href = '/'; });
document.getElementById('goPurchaseBtn').addEventListener('click', () => switchTab('purchase'));

document.querySelectorAll('.pay-card').forEach(btn => btn.addEventListener('click', async () => {
  const plan = btn.dataset.plan;
  btn.disabled = true; btn.textContent = 'Opening Stripe…';
  try {
    const data = await jsonFetch('/api/payments/stripe/checkout', { method: 'POST', body: JSON.stringify({ plan }) });
    location.href = data.url;
  } catch (err) {
    setStatus('purchaseNotice', err.message); btn.disabled = false; btn.textContent = 'Pay with Card';
  }
}));

document.querySelectorAll('.pay-ltc').forEach(btn => btn.addEventListener('click', async () => {
  const plan = btn.dataset.plan;
  btn.disabled = true; btn.textContent = 'Creating payment…';
  try {
    const data = await jsonFetch('/api/payments/ltc/checkout', { method: 'POST', body: JSON.stringify({ plan }) });
    showLtcPayment(data); setStatus('purchaseNotice', 'Litecoin payment created.', true);
  } catch (err) { setStatus('purchaseNotice', err.message); }
  finally { btn.disabled = false; btn.textContent = 'Pay with LTC'; }
}));

function showLtcPayment(data) {
  const box = document.getElementById('ltcPaymentBox'); box.classList.remove('hidden');
  document.getElementById('ltcAmount').textContent = `${data.payAmount} LTC`;
  document.getElementById('ltcAddress').textContent = data.payAddress;
  document.getElementById('ltcStatus').textContent = data.status || 'waiting';
  box.dataset.orderId = data.orderId;
  if (state.ltcPoll) clearInterval(state.ltcPoll);
  state.ltcPoll = setInterval(() => pollLtc(data.orderId), 6000);
}
async function pollLtc(orderId) {
  try {
    const data = await jsonFetch(`/api/payments/ltc/status/${encodeURIComponent(orderId)}`);
    document.getElementById('ltcStatus').textContent = data.status || 'waiting';
    if (data.pay_amount) document.getElementById('ltcAmount').textContent = `${data.pay_amount} LTC`;
    if (data.pay_address) document.getElementById('ltcAddress').textContent = data.pay_address;
    if (data.fulfilled_at || data.status === 'finished') {
      clearInterval(state.ltcPoll); state.ltcPoll = null;
      setStatus('purchaseNotice', 'Litecoin payment complete. Your Axiom license is now on your account.', true);
      await loadLicense(); setTimeout(() => switchTab('license'), 700);
    }
    if (['failed', 'expired', 'cancelled', 'refunded'].includes(data.status)) {
      clearInterval(state.ltcPoll); state.ltcPoll = null; setStatus('purchaseNotice', `Litecoin payment ${data.status}.`);
    }
  } catch {}
}
document.getElementById('copyLtcAmount').addEventListener('click', () => copyText(document.getElementById('ltcAmount').textContent.replace(' LTC','')));
document.getElementById('copyLtcAddress').addEventListener('click', () => copyText(document.getElementById('ltcAddress').textContent));
document.getElementById('copyLicenseKey').addEventListener('click', () => copyText(document.getElementById('accountLicenseKey').textContent));
document.getElementById('copyHwid').addEventListener('click', () => copyText(document.getElementById('accountHwid').textContent));

document.getElementById('redeemForm').addEventListener('submit', async e => {
  e.preventDefault(); setStatus('redeemStatus', 'Checking key…', true);
  try {
    const data = await jsonFetch('/api/dashboard/redeem', { method: 'POST', body: JSON.stringify({ key: document.getElementById('redeemKey').value, clientId: document.getElementById('redeemClientId').value }) });
    setStatus('redeemStatus', `Key successful — active until ${new Date(data.license.expires_at).toLocaleString()}`, true); await loadLicense();
  } catch (err) { setStatus('redeemStatus', err.message); }
});

document.getElementById('downloadBtn').addEventListener('click', async () => {
  try { const data = await jsonFetch('/api/dashboard/download-ticket', { method: 'POST' }); location.href = `/api/download/windows?ticket=${encodeURIComponent(data.ticket)}`; }
  catch (err) { alert(err.message); switchTab(state.license?.active ? 'license' : 'purchase'); }
});

async function loadLicense() {
  const data = await jsonFetch('/api/dashboard/license'); state.license = data.license;
  const active = Boolean(data.license?.active);
  const profilePlan = document.getElementById('profilePlan');
  profilePlan.textContent = active ? `${data.license.license_type === 'lifetime' ? 'Axiom+ Lifetime' : 'Axiom+ Monthly'} · ${data.license.license_type === 'lifetime' ? 'Lifetime' : daysRemaining(data.license.expires_at)}` : 'No active license';
  document.getElementById('deviceCount').textContent = `Devices ${data.license?.client_id ? '1' : '0'}/1`;
  document.getElementById('deviceSlotText').textContent = `${data.license?.client_id ? '1' : '0'}/1 in use`;
  document.getElementById('downloadBtn').classList.toggle('disabled-btn', !active);

  const noLicense = document.getElementById('noLicenseBox');
  const licenseBox = document.getElementById('licenseBox');
  if (!data.license) {
    noLicense.classList.remove('hidden'); licenseBox.classList.add('hidden'); return;
  }
  noLicense.classList.add('hidden'); licenseBox.classList.remove('hidden');
  document.getElementById('accountLicenseKey').textContent = data.license.key || data.license.key_preview || 'Unavailable';
  document.getElementById('accountPlan').textContent = data.license.license_type === 'lifetime' ? 'Axiom+ Lifetime' : data.license.license_type === 'monthly' ? 'Axiom+ Monthly' : 'Owner-issued license';
  document.getElementById('accountExpires').textContent = data.license.license_type === 'lifetime' ? 'Lifetime' : formatDate(data.license.expires_at);
  document.getElementById('accountStatus').textContent = active ? 'Active' : (data.license.revoked ? 'Revoked' : 'Expired');
  document.getElementById('accountHwid').textContent = data.license.client_id || 'Not bound yet';
  document.getElementById('accountLastSeen').textContent = data.license.last_seen_at ? formatDate(data.license.last_seen_at) : 'Never';
}

async function loadFeed(type, target) {
  const el = document.getElementById(target); el.innerHTML = '<div class="panel-blue feed-empty">Loading…</div>';
  try {
    const data = await jsonFetch(`/api/community/${type}`);
    el.innerHTML = data.posts.length ? data.posts.map(p => `<article class="panel-blue feed-card"><div><b>${escapeHtml(p.title || p.username)}</b><small>${escapeHtml(p.username)} · ${new Date(p.created_at).toLocaleString()}</small></div><p>${escapeHtml(p.body)}</p>${type === 'review' ? `<span class="stars">${'★'.repeat(p.rating || 5)}</span>` : ''}</article>`).join('') : '<div class="panel-blue feed-empty">Nothing here yet.</div>';
  } catch (err) { el.innerHTML = `<div class="panel-blue feed-empty">${escapeHtml(err.message)}</div>`; }
}
function bindPostForm(formId, type, fields, statusId, target) {
  document.getElementById(formId).addEventListener('submit', async e => {
    e.preventDefault(); const body = {}; for (const [key, id] of Object.entries(fields)) body[key] = document.getElementById(id).value;
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
async function resetBinding() {
  if (!confirm('Reset the HWID/client ID bound to your Axiom license?')) return;
  try {
    const data = await jsonFetch('/api/dashboard/hwid-reset', { method: 'POST' });
    alert(`Axiom device binding reset. ${data.remaining} reset(s) remain in the current 30-day window.`); await loadLicense(); await loadResetStatus();
  } catch (err) { alert(err.message); }
}
document.getElementById('hwidResetBtn').addEventListener('click', resetBinding);
document.getElementById('licenseResetBtn').addEventListener('click', resetBinding);
document.getElementById('configResetBtn').addEventListener('click', () => { location.href = '/api/dashboard/default-config'; });
document.getElementById('analyzeBtn').addEventListener('click', async () => {
  const result = document.getElementById('crashResult'); result.textContent = 'Analyzing…';
  try { const data = await jsonFetch('/api/dashboard/analyze-log', { method: 'POST', body: JSON.stringify({ log: document.getElementById('crashLog').value }) }); result.innerHTML = data.findings.map(x => `<p>• ${escapeHtml(x)}</p>`).join(''); }
  catch (err) { result.textContent = err.message; }
});
document.getElementById('deviceSlotBtn').addEventListener('click', e => { if (state.config?.deviceSlotUrl) e.currentTarget.href = state.config.deviceSlotUrl; });

async function waitForStripeFulfillment() {
  setStatus('purchaseNotice', 'Payment returned successfully. Waiting for Stripe confirmation…', true);
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      await loadLicense();
      if (state.license?.active) { setStatus('purchaseNotice', 'Payment confirmed. Your license is ready.', true); switchTab('license'); return; }
    } catch {}
  }
  setStatus('purchaseNotice', 'Stripe is still confirming the payment. Refresh My License in a moment.', true);
}

async function boot() {
  const params = new URLSearchParams(location.search); const error = params.get('error');
  try {
    const [me, cfg, payments] = await Promise.all([jsonFetch('/api/auth/me'), jsonFetch('/api/config'), jsonFetch('/api/payments/config')]);
    state.user = me.user; state.config = cfg; state.payments = payments; showApp();
    document.getElementById('profileName').textContent = state.user.username;
    if (state.user.avatar) document.getElementById('profileAvatar').src = state.user.avatar;
    if (state.user.isOwner) document.getElementById('ownerSideGroup').classList.remove('hidden');
    document.getElementById('clientVersion').textContent = cfg.version || '1.0.0';
    document.getElementById('updateVersion').textContent = `Axiom ${cfg.version || '1.0.0'}`;
    document.getElementById('updatedText').textContent = `Last updated ${cfg.updated || 'recently'}`;
    document.getElementById('deviceSlotBtn').href = cfg.deviceSlotUrl || '/dashboard?tab=license';
    document.getElementById('monthlyPrice').textContent = money(payments.monthlyPriceUsd);
    document.getElementById('lifetimePrice').textContent = money(payments.lifetimePriceUsd);
    if (!payments.stripeConfigured) document.querySelectorAll('.pay-card').forEach(b => { b.disabled = true; b.title = 'Stripe is not configured yet'; });
    if (!payments.ltcConfigured) document.querySelectorAll('.pay-ltc').forEach(b => { b.disabled = true; b.title = 'Litecoin payments are not configured yet'; });
    await loadLicense();
    const requested = params.get('tab');
    const tabs = ['purchase','license','downloads','updates','redeem','reviews','basefinds','suggestions','utilities','faq'];
    if (state.user.isOwner) tabs.push('owner');
    switchTab(tabs.includes(requested) ? requested : (state.license?.active ? 'license' : 'purchase'));
    if (params.get('purchase') === 'success') waitForStripeFulfillment();
    if (params.get('purchase') === 'cancelled') setStatus('purchaseNotice', 'Checkout was cancelled.');
  } catch { showLogin(error || ''); }
}
boot();
