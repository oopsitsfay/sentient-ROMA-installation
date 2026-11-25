// Shared logic for the API routes: config, holder lists, validation and storage.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(root, 'collections.json'), 'utf8'));

let holdersCache = null;
function loadHolders() {
  if (holdersCache) return holdersCache;
  const file = path.join(root, 'data', 'holders.json');
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  holdersCache = {};
  for (const [id, entry] of Object.entries(raw)) {
    holdersCache[id] = new Set((entry.holders || []).map((a) => a.toLowerCase()));
  }
  return holdersCache;
}

export const collections = config.collections;
export const getCollection = (id) => collections.find((c) => c.id === id);
export const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a.trim());
export const norm = (a) => a.trim().toLowerCase();

export function holds(collectionId, wallet) {
  const set = loadHolders()[collectionId];
  return !!set && set.has(norm(wallet));
}

export function snapshotInfo() {
  const file = path.join(root, 'data', 'holders.json');
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  for (const [id, e] of Object.entries(raw)) out[id] = { count: (e.holders || []).length, block: e.block ?? null, takenAt: e.takenAt ?? null };
  return out;
}

// ---------- storage ----------
// Production: Upstash Redis over REST (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN,
// or KV_REST_API_URL + KV_REST_API_TOKEN, which Vercel adds when you connect Upstash).
// Local dev without those vars: a JSON file in data/claims.local.json.
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redis(cmd) {
  const r = await fetch(RURL, { method: 'POST', headers: { Authorization: `Bearer ${RTOK}` }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const localFile = path.join(root, 'data', 'claims.local.json');
const readLocal = () => (fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : { holder: {}, claim: {}, list: [] });
const writeLocal = (d) => fs.writeFileSync(localFile, JSON.stringify(d, null, 2));

// A holding wallet can be used once per collection; a claim wallet can only receive one spot.
const holderKey = (c, h) => `${c}:${h}`;

export async function findByHolder(collectionId, holder) {
  const k = holderKey(collectionId, holder);
  if (RURL) { const v = await redis(['HGET', 'wl:holder', k]); return v ? JSON.parse(v) : null; }
  return readLocal().holder[k] || null;
}

export async function findByClaim(claimWallet) {
  if (RURL) { const v = await redis(['HGET', 'wl:claim', claimWallet]); return v ? JSON.parse(v) : null; }
  return readLocal().claim[claimWallet] || null;
}

// Returns { ok: true } or { ok: false, reason }.
export async function saveClaim(rec) {
  const hk = holderKey(rec.collection, rec.holderWallet);
  const json = JSON.stringify(rec);
  if (RURL) {
    // HSETNX makes each slot first-come-first-served even under concurrent requests.
    const a = await redis(['HSETNX', 'wl:holder', hk, json]);
    if (a === 0) return { ok: false, reason: 'holder_used' };
    const b = await redis(['HSETNX', 'wl:claim', rec.claimWallet, json]);
    if (b === 0) { await redis(['HDEL', 'wl:holder', hk]); return { ok: false, reason: 'claim_used' }; }
    await redis(['RPUSH', 'wl:list', json]);
    return { ok: true };
  }
  const d = readLocal();
  if (d.holder[hk]) return { ok: false, reason: 'holder_used' };
  if (d.claim[rec.claimWallet]) return { ok: false, reason: 'claim_used' };
  d.holder[hk] = rec; d.claim[rec.claimWallet] = rec; d.list.push(rec);
  writeLocal(d);
  return { ok: true };
}

export async function allClaims() {
  if (RURL) return (await redis(['LRANGE', 'wl:list', '0', '-1'])).map((s) => JSON.parse(s));
  return readLocal().list;
}

export async function countFor(collectionId) {
  return (await allClaims()).filter((c) => c.collection === collectionId).length;
}

// ---------- tiny helpers ----------
export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  let s = '';
  for await (const ch of req) s += ch;
  return s ? JSON.parse(s) : {};
}

export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
