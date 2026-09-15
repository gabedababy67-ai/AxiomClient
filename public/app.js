const year = document.getElementById('year');
if (year) year.textContent = new Date().getFullYear();

const moduleCopy = {
  Combat: 'Combat and PvP controls are grouped together so your in-game setup stays quick to navigate.',
  Render: 'HUD, visual, and rendering preferences live in one category with profile-friendly settings.',
  Utility: 'General utility features and account-side tools are organized away from combat settings.',
  Movement: 'Movement settings are kept in a dedicated category for faster configuration.',
  Player: 'Player-related controls, social features, and profile options stay together.',
  Config: 'Save and restore your Axiom profiles and use the dashboard reset tools when needed.'
};

document.querySelectorAll('.module-card').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.module-card').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const name = btn.dataset.module;
    const detail = document.getElementById('moduleDetail');
    detail.innerHTML = `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(moduleCopy[name] || '')}</span><a href="/dashboard">Open dashboard →</a>`;
  });
});

document.querySelectorAll('.pricing-toggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pricing-toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

fetch('/api/config').then(r => r.json()).then(cfg => {
  for (const id of ['discordTop', 'discordHero', 'discordReviews']) {
    const el = document.getElementById(id);
    if (el) el.href = cfg.discordUrl && cfg.discordUrl !== '#' ? cfg.discordUrl : '/dashboard';
  }
  document.getElementById('monthlyBtn').href = cfg.monthlyUrl || '/dashboard?tab=redeem';
  document.getElementById('lifetimeBtn').href = cfg.lifetimeUrl || '/dashboard?tab=redeem';
}).catch(() => {});

fetch('/api/community/review').then(r => r.json()).then(data => {
  if (!data.posts?.length) return;
  document.getElementById('reviewGrid').innerHTML = data.posts.slice(0, 6).map(post => `
    <article class="review-card"><div class="quote">“</div><b>${escapeHtml(post.title || post.body.slice(0, 48))}</b><p>${escapeHtml(post.body)}</p><div class="review-foot"><span>${'★'.repeat(post.rating || 5)}</span><small>${escapeHtml(post.username)}</small></div></article>
  `).join('');
}).catch(() => {});
