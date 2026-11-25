// Shared logic for the API routes: partner collections, holder checks and claim storage.
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";

const root = process.cwd();
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));

export const COLLECTIONS = read("collections.json");
const SNAPSHOT = read("data/holders.json");
const holderSets = new Map(COLLECTIONS.map((c) => [c.id, new Set((SNAPSHOT[c.id]?.holders ?? []).map((a) => a.toLowerCase()))]));

export const CHAIN_NAMES = { robinhood: "Robinhood Chain", ethereum: "Ethereum" };
const RPC = {
  robinhood: process.env.RPC_ROBINHOOD || "https://rpc.mainnet.chain.robinhood.com",
  ethereum: process.env.RPC_ETHEREUM || "https://ethereum-rpc.publicnode.com",
};

export const OPEN = process.env.GTD_CLOSED !== "1";
export const getCollection = (id) => COLLECTIONS.find((c) => c.id === id);
export const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a.trim()) && !/^0x0{40}$/i.test(a.trim());
export const snapshotCount = (id) => holderSets.get(id)?.size ?? 0;
const hasContract = (c) => /^0x[0-9a-fA-F]{40}$/.test(c.contract || "");
export const claimable = (c) => snapshotCount(c.id) > 0 || hasContract(c);

/** X username from "@name", "name" or an x.com profile link; null if invalid. */
export function normalizeHandle(input) {
  let v = String(input || "").trim();
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i.exec(v);
  if (m) v = m[1];
  v = v.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(v) ? v : null;
}

/** balanceOf(wallet) > 0 on the collection's chain right now; false when the chain can't be asked in time. */
async function holdsNow(c, wallet) {
  if (!hasContract(c) || !RPC[c.chain]) return false;
  try {
    const res = await fetch(RPC[c.chain], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: c.contract, data: `0x70a08231${wallet.slice(2).padStart(64, "0")}` }, "latest"],
      }),
      signal: AbortSignal.timeout(6000),
    });
    const body = await res.json();
    return typeof body.result === "string" && /^0x[0-9a-f]+$/i.test(body.result) && BigInt(body.result) > 0n;
  } catch (err) {
    console.warn("live holder check failed", c.id, err.message);
    return false;
  }
}

/** The holder snapshot first (instant), then the chain itself for wallets that bought after it was taken. */
export async function holds(c, wallet) {
  return holderSets.get(c.id)?.has(wallet) || (await holdsNow(c, wallet));
}

// ---------- claim storage ----------
// Production: Upstash Redis over REST (KV_REST_API_URL / KV_REST_API_TOKEN, added when Upstash is connected in Vercel).
// Each claim is written to three hashes with HSETNX ("set only if missing"), which makes "one claim per holding wallet
// per collection, per receiving wallet and per X account" hold even when two people submit at the same moment.
// Local dev without Redis: a JSON file.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);
/** On Vercel without a connected store there is nowhere to keep claims: the page shows "Opening soon". */
export const STORAGE_READY = useRedis || !process.env.VERCEL;

async function redis(path, body) {
  const res = await fetch(`${REDIS_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`storage: ${json.error ?? res.status}`);
  return json;
}
const cmd = async (...args) => (await redis("", args)).result;
const pipeline = async (cmds) => (await redis("/pipeline", cmds)).map((r) => {
  if (r.error) throw new Error(`storage: ${r.error}`);
  return r.result;
});

const holderHash = (collection) => `gtd:holder:${collection}`;

const localFile = path.join(root, "data", "claims.local.json");
const readLocal = () => (fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, "utf8")) : {});
const writeLocal = (d) => fs.writeFileSync(localFile, JSON.stringify(d, null, 1));

/** HSETNX: true if the field was free and is now set. */
async function setOnce(hash, field, json) {
  if (useRedis) return (await cmd("HSETNX", hash, field, json)) === 1;
  const d = readLocal();
  d[hash] ??= {};
  if (d[hash][field]) return false;
  d[hash][field] = json;
  writeLocal(d);
  return true;
}

async function unset(hash, field) {
  if (useRedis) return cmd("HDEL", hash, field);
  const d = readLocal();
  if (d[hash]) delete d[hash][field];
  writeLocal(d);
}

export async function holderUsed(collection, wallet) {
  if (useRedis) return (await cmd("HEXISTS", holderHash(collection), wallet)) === 1;
  return Boolean(readLocal()[holderHash(collection)]?.[wallet]);
}

/** Saves a claim. Returns { ok: true } or { ok: false, reason: "holder_used" | "claim_used" | "x_used" }. */
export async function saveClaim(rec) {
  const json = JSON.stringify(rec);
  const h = holderHash(rec.collection);
  if (!(await setOnce(h, rec.holderWallet, json))) return { ok: false, reason: "holder_used" };
  if (!(await setOnce("gtd:wallet", rec.claimWallet, json))) {
    await unset(h, rec.holderWallet);
    return { ok: false, reason: "claim_used" };
  }
  if (!(await setOnce("gtd:x", rec.x.toLowerCase(), json))) {
    await unset(h, rec.holderWallet);
    await unset("gtd:wallet", rec.claimWallet);
    return { ok: false, reason: "x_used" };
  }
  return { ok: true };
}

/** Claims per collection. */
export async function claimCounts() {
  if (useRedis) {
    const n = await pipeline(COLLECTIONS.map((c) => ["HLEN", holderHash(c.id)]));
    return Object.fromEntries(COLLECTIONS.map((c, i) => [c.id, Number(n[i])]));
  }
  const d = readLocal();
  return Object.fromEntries(COLLECTIONS.map((c) => [c.id, Object.keys(d[holderHash(c.id)] ?? {}).length]));
}

/** Every claim, oldest first (admin export). */
export async function allClaims() {
  let values = [];
  if (useRedis) {
    for (const flat of await pipeline(COLLECTIONS.map((c) => ["HVALS", holderHash(c.id)]))) values.push(...flat);
  } else {
    const d = readLocal();
    for (const c of COLLECTIONS) values.push(...Object.values(d[holderHash(c.id)] ?? {}));
  }
  return values.map((v) => JSON.parse(v)).sort((a, b) => a.at.localeCompare(b.at));
}

// ---------- request helpers ----------
const hits = new Map();
/** Per-instance limit: 30 POSTs per IP per minute. */
export function rateLimited(req) {
  const ip = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const key = createHmac("sha256", "gtd").update(ip).digest("hex");
  const now = Date.now();
  const w = hits.get(key);
  if (!w || now - w.start > 60_000) {
    if (hits.size > 10_000) hits.clear();
    hits.set(key, { start: now, n: 1 });
    return false;
  }
  return ++w.n > 30;
}

/** Same-site check: browsers always send Origin on POST, and other sites can't forge it. */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === String(host).split(",")[0].trim();
  } catch {
    return false;
  }
}

export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 4096) throw new Error("too large");
  }
  return s ? JSON.parse(s) : {};
}

export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

/** Wraps a handler so an unexpected error answers 500 with a short reason instead of crashing. */
export const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error("api error", err);
    send(res, 500, { error: "internal", message: `Something went wrong (${String(err.message).slice(0, 80)}). Try again shortly.` });
  }
};
