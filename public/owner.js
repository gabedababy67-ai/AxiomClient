let token = sessionStorage.getItem('axiomAdminToken') || '';
const loginPanel = document.getElementById('loginPanel');
const dashboard = document.getElementById('dashboard');
const loginStatus = document.getElementById('loginStatus');

function showDashboard(show) {
  loginPanel.classList.toggle('hidden', show);
  dashboard.classList.toggle('hidden', !show);
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : { error: await res.text() };
  if (!res.ok) {
    if (res.status === 401) {
      token = '';
      sessionStorage.removeItem('axiomAdminToken');
      showDashboard(false);
    }
    throw new Error(data.error || 'Request failed.');
  }
  return data;
}

async function loadLicenses() {
  const body = document.getElementById('licenseRows');
  body.innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>';
  try {
    const data = await api('/api/admin/licenses');
    if (!data.licenses.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty">No licenses yet.</td></tr>';
      return;
    }
    body.innerHTML = data.licenses.map(l => {
      const status = l.revoked ? 'revoked' : (l.active ? 'active' : 'expired');
      const client = l.client_id ? escapeHtml(l.client_id) : '<span style="color:#625b6b">Unbound</span>';
      return `<tr>
        <td><code>${escapeHtml(l.key_preview)}</code></td>
        <td><span class="badge ${status}">${status.toUpperCase()}</span></td>
        <td>${client}</td>
        <td>${new Date(l.expires_at).toLocaleString()}</td>
        <td>${escapeHtml(l.note || '—')}</td>
        <td><div class="row-actions">
          ${!l.revoked ? `<button data-action="revoke" data-id="${l.id}">Revoke</button>` : ''}
          ${l.client_id ? `<button data-action="unbind" data-id="${l.id}">Unbind</button>` : ''}
        </div></td>
      </tr>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

document.getElementById('ownerLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  loginStatus.className = 'status';
  loginStatus.textContent = 'Signing in…';
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: document.getElementById('ownerPassword').value })
    });
    token = data.token;
    sessionStorage.setItem('axiomAdminToken', token);
    showDashboard(true);
    document.getElementById('ownerPassword').value = '';
    await loadLicenses();
  } catch (err) {
    loginStatus.className = 'status error';
    loginStatus.textContent = err.message;
  }
});

document.getElementById('generateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/admin/licenses', {
      method: 'POST',
      body: JSON.stringify({
        amount: Number(document.getElementById('durationAmount').value),
        unit: document.getElementById('durationUnit').value,
        clientId: document.getElementById('newClientId').value,
        note: document.getElementById('licenseNote').value
      })
    });
    document.getElementById('generatedKey').textContent = data.key;
    document.getElementById('generatedExpiry').textContent = `Expires ${new Date(data.expiresAt).toLocaleString()}`;
    document.getElementById('generatedBox').classList.remove('hidden');
    await loadLicenses();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('copyKey').addEventListener('click', async () => {
  const key = document.getElementById('generatedKey').textContent;
  await navigator.clipboard.writeText(key);
  document.getElementById('copyKey').textContent = 'Copied';
  setTimeout(() => document.getElementById('copyKey').textContent = 'Copy key', 1200);
});

document.getElementById('licenseRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  btn.disabled = true;
  try {
    const action = btn.dataset.action;
    await api(`/api/admin/licenses/${btn.dataset.id}/${action}`, { method: 'POST' });
    await loadLicenses();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
});

document.getElementById('refreshBtn').addEventListener('click', loadLicenses);
document.getElementById('logoutBtn').addEventListener('click', () => {
  token = '';
  sessionStorage.removeItem('axiomAdminToken');
  showDashboard(false);
});

if (token) {
  showDashboard(true);
  loadLicenses();
} else {
  showDashboard(false);
}
