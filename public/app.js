const form = document.getElementById('licenseForm');
const statusEl = document.getElementById('licenseStatus');
const downloadEl = document.getElementById('windowsDownload');
const verifyBtn = document.getElementById('verifyBtn');

document.getElementById('year').textContent = new Date().getFullYear();

fetch('/api/config')
  .then(r => r.json())
  .then(cfg => {
    document.getElementById('versionText').textContent = cfg.version || '1.0.0';
    for (const id of ['discordNav', 'discordHero']) {
      const el = document.getElementById(id);
      el.href = cfg.discordUrl && cfg.discordUrl !== '#' ? cfg.discordUrl : '#download';
    }
  })
  .catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  downloadEl.classList.add('disabled');
  downloadEl.setAttribute('aria-disabled', 'true');
  downloadEl.href = '#';
  statusEl.className = 'status';
  statusEl.textContent = 'Checking key…';
  verifyBtn.disabled = true;

  try {
    const response = await fetch('/api/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: document.getElementById('licenseKey').value,
        clientId: document.getElementById('clientId').value
      })
    });
    const data = await response.json();
    if (!response.ok || !data.valid) throw new Error(data.error || 'Key verification failed.');

    statusEl.className = 'status success';
    statusEl.textContent = `Key successful — active until ${new Date(data.expiresAt).toLocaleString()}`;
    downloadEl.href = `/api/download/windows?ticket=${encodeURIComponent(data.downloadTicket)}`;
    downloadEl.classList.remove('disabled');
    downloadEl.setAttribute('aria-disabled', 'false');
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message;
  } finally {
    verifyBtn.disabled = false;
  }
});
