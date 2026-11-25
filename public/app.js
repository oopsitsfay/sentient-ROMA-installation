const $ = (s) => document.querySelector(s);
const grid = $("#grid");
const dlg = $("#dlg");
let current = null;
let verifiedHolder = null;

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a.trim()) && !/^0x0{40}$/i.test(a.trim());
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const initials = (n) => n.replace(/^the\s+/i, "").split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase();

function art(el, c) {
  el.style.background = c.color;
  el.textContent = "";
  if (c.image) {
    const img = new Image();
    img.src = c.image;
    img.alt = "";
    img.loading = "lazy";
    el.append(img);
  } else el.textContent = initials(c.name);
}

async function api(path, body) {
  let r;
  try {
    r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  } catch {
    return { ok: false, message: "Can't reach the server. Check your connection and try again." };
  }
  const j = await r.json().catch(() => ({ message: "Something went wrong. Try again." }));
  return { ok: r.ok, ...j };
}

async function load() {
  const d = await api("/api/collections");
  if (!d.collections) {
    grid.innerHTML = "";
    const li = document.createElement("li");
    li.className = "card";
    li.style.padding = "20px";
    li.innerHTML = `<span class="muted small"></span> <a href="#">Try again</a>`;
    li.querySelector("span").textContent = `Couldn't load the partner collections${d.message ? ` (${d.message})` : ""}.`;
    li.querySelector("a").onclick = (e) => (e.preventDefault(), load());
    grid.append(li);
    return;
  }
  if (!d.open) {
    const s = $("#status");
    s.className = "badge badge-warn";
    s.innerHTML = "<i></i>Opening soon";
  }
  $("#count").textContent = `${d.collections.length} collections`;
  grid.innerHTML = "";
  for (const c of d.collections) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    const full = c.spots != null && c.claimed >= c.spots;
    const state = c.open ? "open" : full ? "full" : "soon";
    b.className = "tile";
    b.disabled = !c.open;
    b.dataset.testid = `gtd-tile-${c.id}`;
    b.setAttribute("data-testid", `gtd-tile-${c.id}`);
    b.dataset.state = state;
    const sub = (c.spots != null ? `${Math.max(c.spots - c.claimed, 0)} of ${c.spots} spots left` : `@${c.x}`) + (c.chain === "robinhood" ? "" : ` · ${c.chainName}`);
    b.innerHTML = `<span class="art art-lg"></span><span class="meta"><span class="name"></span><span class="sub"></span></span>${
      state === "open" ? '<span class="go">Claim →</span>' : `<span class="badge">${state === "full" ? "Full" : "Soon"}</span>`
    }`;
    art(b.querySelector(".art"), c);
    b.querySelector(".name").textContent = c.name;
    b.querySelector(".sub").textContent = sub;
    b.addEventListener("click", () => open(c));
    li.append(b);
    grid.append(li);
  }
}

function show(step) {
  for (const id of ["step-verify", "step-claim", "step-done"]) $(`#${id}`).hidden = id !== step;
}

function open(c) {
  current = c;
  verifiedHolder = null;
  art($("#dlg-art"), c);
  $("#dlg-title").textContent = `Claim with ${c.name}`;
  $("#dlg-sub").textContent = `For ${c.name} holders on ${c.chainName}`;
  const links = $("#dlg-links");
  links.innerHTML = "";
  const add = (href, text) => {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = text;
    links.append(a);
  };
  add(`https://x.com/${c.x}`, `@${c.x}`);
  if (c.opensea) add(c.opensea, "OpenSea ↗");
  for (const id of ["#holder", "#claim", "#xh"]) $(id).value = "";
  $("#verify-err").textContent = "";
  $("#claim-err").textContent = "";
  document.querySelector("input[name=dest][value=same]").checked = true;
  $("#claim-wrap").hidden = true;
  show("step-verify");
  dlg.showModal();
  setTimeout(() => $("#holder").focus(), 60);
}

async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

$("#step-verify").addEventListener("submit", (e) => {
  e.preventDefault();
  const holder = $("#holder").value.trim();
  const err = $("#verify-err");
  err.textContent = "";
  if (!isAddr(holder)) return void (err.textContent = "That isn't a valid wallet address (0x followed by 40 characters).");
  busy($("#verify-btn"), "Checking…", async () => {
    const r = await api("/api/verify", { collection: current.id, holderWallet: holder });
    if (!r.ok || !r.eligible) return void (err.textContent = r.message || "This wallet can't claim.");
    verifiedHolder = holder;
    $("#holder-short").textContent = short(holder);
    show("step-claim");
  });
});

for (const r of document.querySelectorAll("input[name=dest]")) {
  r.addEventListener("change", () => {
    const other = document.querySelector("input[name=dest]:checked").value === "other";
    $("#claim-wrap").hidden = !other;
    if (other) $("#claim").focus();
  });
}

$("#back-btn").addEventListener("click", () => {
  $("#claim-err").textContent = "";
  show("step-verify");
  $("#holder").select();
});

$("#step-claim").addEventListener("submit", (e) => {
  e.preventDefault();
  const err = $("#claim-err");
  err.textContent = "";
  const same = document.querySelector("input[name=dest]:checked").value === "same";
  const claimWallet = same ? verifiedHolder : $("#claim").value.trim();
  const xHandle = $("#xh").value.trim().replace(/^@/, "");
  if (!same && !isAddr(claimWallet)) return void (err.textContent = "Paste a valid wallet to receive the GTD spot.");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(xHandle)) return void (err.textContent = "Enter your X username.");
  busy($("#claim-btn"), "Saving…", async () => {
    const r = await api("/api/claim", { collection: current.id, holderWallet: verifiedHolder, sameWallet: same, claimWallet, xHandle });
    if (!r.ok) return void (err.textContent = r.message || "Could not save your claim.");
    $("#done-wallet").textContent = r.claimWallet;
    $("#share-btn").href = `https://x.com/intent/post?text=${encodeURIComponent(`Claimed my @Niblekins GTD as a ${current.name} holder 👁️`)}`;
    show("step-done");
    load();
  });
});

dlg.addEventListener("click", (e) => {
  if (e.target === dlg) dlg.close();
});
load();
