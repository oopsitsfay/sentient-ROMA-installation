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
// Production: a private Vercel Blob store (BLOB_READ_WRITE_TOKEN). Each claim writes three marker files, each only if
// it doesn't exist yet, which makes "one claim per holding wallet per collection, per receiving wallet and per X
// account" hold even when two people submit at the same moment. Local dev without a token: a JSON file.
const useBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
let blob = null;
const blobApi = async () => (blob ??= await import("@vercel/blob"));

const keys = (r) => ({
  holder: `claims/holder/${r.collection}/${r.holderWallet}.json`,
  wallet: `claims/wallet/${r.claimWallet}.json`,
  x: `claims/x/${r.x.toLowerCase()}.json`,
});

const localFile = path.join(root, "data", "claims.local.json");
const readLocal = () => (fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, "utf8")) : {});
const writeLocal = (d) => fs.writeFileSync(localFile, JSON.stringify(d, null, 1));

async function createOnce(pathname, json) {
  if (!useBlob) {
    const d = readLocal();
    if (d[pathname]) return false;
    d[pathname] = JSON.parse(json);
    writeLocal(d);
    return true;
  }
  const { put } = await blobApi();
  try {
    await put(pathname, json, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json" });
    return true;
  } catch (err) {
    if (/already exists/i.test(err.message)) return false;
    throw err;
  }
}

async function remove(pathname) {
  if (!useBlob) {
    const d = readLocal();
    delete d[pathname];
    return writeLocal(d);
  }
  const { del } = await blobApi();
  await del(pathname).catch(() => {});
}

async function exists(pathname) {
  if (!useBlob) return Boolean(readLocal()[pathname]);
  const { head } = await blobApi();
  try {
    await head(pathname);
    return true;
  } catch (err) {
    if (err?.constructor?.name === "BlobNotFoundError" || /not found|does not exist/i.test(err.message)) return false;
    throw err;
  }
}

export const holderUsed = (collection, wallet) => exists(`claims/holder/${collection}/${wallet}.json`);

/** Saves a claim. Returns { ok: true } or { ok: false, reason: "holder_used" | "claim_used" | "x_used" }. */
export async function saveClaim(rec) {
  const k = keys(rec);
  const json = JSON.stringify(rec);
  if (!(await createOnce(k.holder, json))) return { ok: false, reason: "holder_used" };
  if (!(await createOnce(k.wallet, json))) {
    await remove(k.holder);
    return { ok: false, reason: "claim_used" };
  }
  if (!(await createOnce(k.x, json))) {
    await remove(k.holder);
    await remove(k.wallet);
    return { ok: false, reason: "x_used" };
  }
  countsCache = null;
  return { ok: true };
}

async function listHolderKeys() {
  if (!useBlob) return Object.keys(readLocal()).filter((p) => p.startsWith("claims/holder/"));
  const { list } = await blobApi();
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: "claims/holder/", limit: 1000, cursor });
    out.push(...page.blobs.map((b) => b.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

let countsCache = null;
/** Claims per collection (cached for 20 s per instance). */
export async function claimCounts() {
  if (countsCache && Date.now() - countsCache.at < 20_000) return countsCache.counts;
  const counts = {};
  for (const p of await listHolderKeys()) {
    const id = p.split("/")[2];
    counts[id] = (counts[id] ?? 0) + 1;
  }
  countsCache = { at: Date.now(), counts };
  return counts;
}

/** Every claim, oldest first (admin export). */
export async function allClaims() {
  const paths = await listHolderKeys();
  if (!useBlob) {
    const d = readLocal();
    return paths.map((p) => d[p]).sort((a, b) => a.at.localeCompare(b.at));
  }
  const { get } = await blobApi();
  const out = [];
  for (let i = 0; i < paths.length; i += 20) {
    const batch = await Promise.all(
      paths.slice(i, i + 20).map(async (p) => {
        const r = await get(p, { access: "private", useCache: false });
        return r ? JSON.parse(await new Response(r.stream).text()) : null;
      }),
    );
    out.push(...batch.filter(Boolean));
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
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
