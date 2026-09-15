let token = sessionStorage.getItem('axiomAdminToken') || '';
const loginPanel = document.getElementById('loginPanel');
const dashboard = document.getElementById('dashboard');
const loginStatus = document.getElementById('loginStatus');

function showDashboard(show) { loginPanel.classList.toggle('hidden', show); dashboard.classList.toggle('hidden', !show); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : { error: await res.text() };
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
async function loadLicenses() {
  const body = document.getElementById('licenseRows'); body.innerHTML = '<tr><td colspan="8" class="empty">Loading…</td></tr>';
  try {
    const data = await api('/api/admin/licenses');
    if (!data.licenses.length) { body.innerHTML = '<tr><td colspan="8" class="empty">No licenses yet.</td></tr>'; return; }
    body.innerHTML = data.licenses.map(l => {
      const status = l.revoked ? 'revoked' : (l.active ? 'active' : 'expired');
      const type = l.license_type === 'lifetime' ? 'Lifetime' : 'Timed';
      const expiry = l.license_type === 'lifetime' ? 'Lifetime' : new Date(l.expires_at).toLocaleString();
      return `<tr><td><code>${escapeHtml(l.key_preview)}</code></td><td>${type}</td><td><span class="badge ${status}">${status.toUpperCase()}</span></td><td>${l.client_id ? escapeHtml(l.client_id) : 'Unbound'}</td><td>${l.discord_user_id ? escapeHtml(l.discord_user_id) : 'Unbound'}</td><td>${expiry}</td><td>${escapeHtml(l.note || '—')}</td><td><div class="row-actions">${!l.revoked ? `<button data-action="revoke" data-id="${l.id}">Revoke</button>` : ''}${l.client_id ? `<button data-action="unbind" data-id="${l.id}">Unbind</button>` : ''}</div></td></tr>`;
    }).join('');
  } catch (err) { body.innerHTML = `<tr><td colspan="8" class="empty">${escapeHtml(err.message)}</td></tr>`; }
}
async function tryExistingAccess() {
  try { await api('/api/admin/session'); showDashboard(true); await loadLicenses(); return true; } catch { showDashboard(false); return false; }
}

document.getElementById('ownerLogin').addEventListener('submit', async e => {
  e.preventDefault(); loginStatus.className = 'status'; loginStatus.textContent = 'Signing in…';
  try {
    const data = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: document.getElementById('ownerPassword').value }) });
    token = data.token; sessionStorage.setItem('axiomAdminToken', token); showDashboard(true); document.getElementById('ownerPassword').value = ''; await loadLicenses();
  } catch (err) { loginStatus.className = 'status error'; loginStatus.textContent = err.message; }
});
const licenseMode = document.getElementById('licenseMode');
const daysWrap = document.getElementById('daysWrap');
const durationDays = document.getElementById('durationDays');
function syncLicenseMode() {
  const lifetime = licenseMode.value === 'lifetime';
  daysWrap.classList.toggle('hidden', lifetime);
  durationDays.required = !lifetime;
}
licenseMode.addEventListener('change', syncLicenseMode);
syncLicenseMode();

document.getElementById('generateForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const mode = licenseMode.value;
    const data = await api('/api/admin/licenses', { method: 'POST', body: JSON.stringify({ licenseMode: mode, days: mode === 'lifetime' ? null : Number(durationDays.value), clientId: document.getElementById('newClientId').value, discordUserId: document.getElementById('newDiscordUserId').value, note: document.getElementById('licenseNote').value }) });
    document.getElementById('generatedKey').textContent = data.key;
    document.getElementById('generatedExpiry').textContent = data.lifetime ? 'Lifetime access' : `Expires ${new Date(data.expiresAt).toLocaleString()}`;
    document.getElementById('generatedBox').classList.remove('hidden');
    await loadLicenses();
  } catch (err) { alert(err.message); }
});
document.getElementById('copyKey').addEventListener('click', async () => { await navigator.clipboard.writeText(document.getElementById('generatedKey').textContent); document.getElementById('copyKey').textContent = 'Copied'; setTimeout(() => document.getElementById('copyKey').textContent = 'Copy key', 1200); });
document.getElementById('licenseRows').addEventListener('click', async e => { const btn = e.target.closest('button[data-action]'); if (!btn) return; btn.disabled = true; try { await api(`/api/admin/licenses/${btn.dataset.id}/${btn.dataset.action}`, { method: 'POST' }); await loadLicenses(); } catch (err) { alert(err.message); btn.disabled = false; } });
document.getElementById('refreshBtn').addEventListener('click', loadLicenses);
document.getElementById('logoutBtn').addEventListener('click', async () => { token = ''; sessionStorage.removeItem('axiomAdminToken'); try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {} showDashboard(false); });
tryExistingAccess();
