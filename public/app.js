const $ = (s) => document.querySelector(s);
const grid = $('#grid');
const dlg = $('#dlg');
let current = null;
let verifiedHolder = null;

const initials = (name) => name.replace(/^The\s+/i, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

function avatar(el, c) {
  el.style.background = c.color;
  el.innerHTML = c.image ? `<img src="${c.image}" alt="">` : initials(c.name);
}

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: 'Something went wrong. Try again.' }));
  return { ok: r.ok, ...j };
}

async function load() {
  const data = await api('/api/collections');
  if (!data.collections) { grid.innerHTML = '<p class="muted">Could not load collections. Refresh to try again.</p>'; return; }
  if (!data.open) { const p = $('#status-pill'); p.classList.add('closed'); p.innerHTML = '<i></i>Closed'; $('.hero-title h2').textContent = 'GTD claims are closed'; }
  $('#col-count').textContent = `${data.collections.length} collections`;
  grid.innerHTML = '';
  for (const c of data.collections) {
    const full = c.spots != null && c.claimed >= c.spots;
    const b = document.createElement('button');
    b.className = 'col';
    b.disabled = !c.ready || full || !data.open;
    const sub = c.spots != null ? `${Math.max(c.spots - c.claimed, 0)} of ${c.spots} spots left` : `@${c.x}`;
    const right = !c.ready ? '<span class="soon">Soon</span>' : full ? '<span class="soon">Full</span>' : '<span class="go">Claim →</span>';
    b.innerHTML = `<div class="avatar"></div><div class="meta"><div class="name"></div><div class="sub"></div></div>${right}`;
    avatar(b.querySelector('.avatar'), c);
    b.querySelector('.name').textContent = c.name;
    b.querySelector('.sub').textContent = sub;
    b.addEventListener('click', () => open(c));
    grid.append(b);
  }
}

function show(step) {
  for (const id of ['step-verify', 'step-claim', 'step-done']) $('#' + id).hidden = id !== step;
}

function open(c) {
  current = c; verifiedHolder = null;
  avatar($('#dlg-avatar'), c);
  $('#dlg-title').textContent = c.name;
  const x = $('#dlg-x'); x.textContent = '@' + c.x; x.href = 'https://x.com/' + c.x;
  $('#holder').value = ''; $('#claim').value = '';
  $('#verify-err').textContent = ''; $('#claim-err').textContent = '';
  document.querySelector('input[name=dest][value=same]').checked = true; $('#claim-wrap').hidden = true;
  show('step-verify');
  dlg.showModal();
  setTimeout(() => $('#holder').focus(), 50);
}

async function busy(btn, label, fn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

$('#verify-btn').addEventListener('click', () => {
  const holder = $('#holder').value.trim();
  const err = $('#verify-err'); err.textContent = '';
  if (!isAddr(holder)) { err.textContent = 'Enter a valid wallet address (0x followed by 40 characters).'; return; }
  busy($('#verify-btn'), 'Checking…', async () => {
    const r = await api('/api/verify', { collection: current.id, holderWallet: holder });
    if (r.error) { err.textContent = r.error; return; }
    if (!r.eligible) { err.textContent = r.message; return; }
    verifiedHolder = holder;
    $('#holder-short').textContent = short(holder);
    show('step-claim');
  });
});
$('#holder').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#verify-btn').click(); });

for (const r of document.querySelectorAll('input[name=dest]')) {
  r.addEventListener('change', () => {
    const other = document.querySelector('input[name=dest]:checked').value === 'other';
    $('#claim-wrap').hidden = !other;
    if (other) $('#claim').focus();
  });
}

$('#back-btn').addEventListener('click', () => { show('step-verify'); $('#holder').select(); });

$('#claim-btn').addEventListener('click', () => {
  const err = $('#claim-err'); err.textContent = '';
  const same = document.querySelector('input[name=dest]:checked').value === 'same';
  const claimWallet = same ? verifiedHolder : $('#claim').value.trim();
  const xHandle = $('#xh').value.trim().replace(/^@/, '');
  if (!same && !isAddr(claimWallet)) { err.textContent = 'Enter a valid wallet to receive the GTD.'; return; }
  if (!/^[A-Za-z0-9_]{1,15}$/.test(xHandle)) { err.textContent = 'Enter your X handle.'; return; }
  busy($('#claim-btn'), 'Saving…', async () => {
    const r = await api('/api/claim', { collection: current.id, holderWallet: verifiedHolder, sameWallet: same, claimWallet, xHandle });
    if (!r.ok) { err.textContent = r.error || 'Could not save your claim.'; return; }
    $('#done-wallet').textContent = r.claimWallet;
    const text = `Just claimed my @niblekins GTD as a ${current.name} holder 🐰👁️`;
    $('#share-btn').href = 'https://x.com/intent/post?text=' + encodeURIComponent(text);
    show('step-done');
    load();
  });
});

dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
load();
