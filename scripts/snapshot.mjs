#!/usr/bin/env node
// Holder snapshot for partner GTD claims (see collections.json).
//
// For every partner collection in collections.json that has a contract, replays all of the
// contract's transfers (ERC-721 Transfer, ERC-1155 TransferSingle/TransferBatch) from its chain (the collection's
// "chain": "robinhood" by default, or "ethereum") and writes the
// wallets that hold at least one token now to data/holders.json. Commit that file and redeploy:
// the snapshot is what the site checks claims against.
//
//   pnpm gtd:snapshot                       all collections with a contract
//   pnpm gtd:snapshot blokyz funkari        only these (others keep their previous snapshot)
//   RPC_URL_ROBINHOOD=https://… / RPC_URL_ETHEREUM=https://…   other RPCs (defaults: the chains' public RPCs)
// Node's fetch ignores HTTPS_PROXY; behind a proxy run it with NODE_USE_ENV_PROXY=1.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(root, "collections.json");
const OUT = join(root, "data/holders.json");
/** Public RPC per chain, and the widest block range its eth_getLogs accepts for one address. */
const CHAINS = {
  robinhood: { rpc: process.env.RPC_URL_ROBINHOOD || "https://rpc.mainnet.chain.robinhood.com", maxRange: 10_000_000 },
  // The free Ethereum RPC serves current state but not old logs, so Ethereum collections are read token by token.
  ethereum: { rpc: process.env.RPC_URL_ETHEREUM || "https://ethereum-rpc.publicnode.com", maxRange: 50_000, byOwnerOf: true },
};

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d4cbcd8bf43ff3e9c";
const ZERO = "0x0000000000000000000000000000000000000000";
const NOT_HOLDERS = new Set([ZERO, "0x000000000000000000000000000000000000dead"]);

let id = 0;
async function rpc(RPC, method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw Object.assign(new Error(body.error.message), { rpc: true });
      return body.result;
    } catch (err) {
      if (err.rpc || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

const topicAddress = (t) => `0x${t.slice(26)}`.toLowerCase();
const words = (data) => (data.slice(2).match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`));

/**
 * All of the contract's logs from `from` to `to`, in block ranges that shrink when the RPC refuses one and grow when it
 * doesn't. No topic filter: RPCs allow far wider ranges for a plain address query; transfers are picked out below.
 */
async function* logs(chain, address, from, to) {
  let step = chain.maxRange;
  for (let start = from; start <= to; ) {
    const end = Math.min(start + step - 1, to);
    let batch;
    try {
      batch = await rpc(chain.rpc, "eth_getLogs", [{ address, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }]);
    } catch (err) {
      if (step <= 10) throw err;
      step = Math.max(10, Math.floor(step / 2));
      continue;
    }
    yield* batch;
    start = end + 1;
    step = Math.min(step * 2, chain.maxRange);
    process.stdout.write(`  block ${end.toLocaleString("en-US")} / ${to.toLocaleString("en-US")}\r`);
  }
}

/** One JSON-RPC batch of eth_calls at `block`; each result is the return data, or null if the call reverted. */
async function callBatch(url, calls, block) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [c, block] }))),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error(body?.error?.message ?? "batch refused");
      const out = new Array(calls.length).fill(null);
      for (const r of body) out[r.id] = r.result && r.result !== "0x" ? r.result : null;
      return out;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/**
 * ERC-721 holders from current state: ownerOf(id) for every token id from 0 (up to totalSupply when it exists), until 200
 * ids in a row don't exist (so burned tokens and collections starting at 1 are covered). All at one block.
 */
async function holdersByOwnerOf(chain, contract, latest) {
  const block = `0x${latest.toString(16)}`;
  const [supplyHex] = await callBatch(chain.rpc, [{ to: contract, data: "0x18160ddd" }], block);
  // Some collections (rektguy) have no totalSupply(): then the 200-misses rule alone decides where to stop.
  const supply = supplyHex ? Number(BigInt(supplyHex)) : 0;
  const owners = new Set();
  let misses = 0;
  let found = 0;
  for (let id = 0; id <= supply || misses < 200; id += 100) {
    const ids = Array.from({ length: 100 }, (_, i) => id + i);
    const res = await callBatch(chain.rpc, ids.map((n) => ({ to: contract, data: `0x6352211e${n.toString(16).padStart(64, "0")}` })), block);
    for (const r of res) {
      if (r) {
        owners.add(`0x${r.slice(26, 66)}`.toLowerCase());
        found++;
        misses = 0;
      } else misses++;
    }
    process.stdout.write(`  token ${id + 99} (${found} found)\r`);
  }
  const holders = [...owners].filter((a) => !NOT_HOLDERS.has(a)).sort();
  return { holders, transfers: found };
}

async function holdersOf(chain, contract, latest) {
  if (chain.byOwnerOf) return holdersByOwnerOf(chain, contract, latest);
  const balance = new Map();
  const move = (from, to, n) => {
    if (from !== ZERO) balance.set(from, (balance.get(from) ?? 0n) - n);
    balance.set(to, (balance.get(to) ?? 0n) + n);
  };
  let transfers = 0;
  for await (const l of logs(chain, contract, 0, latest)) {
    const [topic] = l.topics;
    if (topic === TRANSFER && l.topics.length === 4) move(topicAddress(l.topics[1]), topicAddress(l.topics[2]), 1n);
    else if (topic === SINGLE) move(topicAddress(l.topics[2]), topicAddress(l.topics[3]), words(l.data)[1] ?? 0n);
    else if (topic === BATCH) {
      // data: offset(ids), offset(values), ids.length, ...ids, values.length, ...values
      const w = words(l.data);
      const n = Number(w[2] ?? 0n);
      for (const v of w.slice(4 + n, 4 + 2 * n)) move(topicAddress(l.topics[2]), topicAddress(l.topics[3]), v);
    } else continue; // an ERC-20 style Transfer (3 topics): not an NFT
    transfers++;
  }
  const holders = [...balance].filter(([a, n]) => n > 0n && !NOT_HOLDERS.has(a)).map(([a]) => a).sort();
  return { holders, transfers };
}

const only = process.argv.slice(2);
const collections = JSON.parse(readFileSync(CONFIG, "utf8"));
for (const name of only) if (!collections.some((c) => c.id === name)) throw new Error(`No collection "${name}" in gtd-collections.json`);
const out = JSON.parse(readFileSync(OUT, "utf8"));
const latest = {};

for (const c of collections) {
  if (only.length > 0 && !only.includes(c.id)) continue;
  if (!/^0x[0-9a-fA-F]{40}$/.test(c.contract)) {
    console.log(`- ${c.name}: no contract in gtd-collections.json, skipped`);
    continue;
  }
  const chainName = c.chain || "robinhood";
  const chain = CHAINS[chainName];
  if (!chain) throw new Error(`${c.name}: unknown chain "${chainName}" (use ${Object.keys(CHAINS).join(" or ")})`);
  latest[chainName] ??= parseInt(await rpc(chain.rpc, "eth_blockNumber", []), 16);
  console.log(`- ${c.name}: scanning ${chainName} up to block ${latest[chainName]}`);
  const { holders, transfers } = await holdersOf(chain, c.contract, latest[chainName]);
  out[c.id] = { chain: chainName, contract: c.contract.toLowerCase(), block: latest[chainName], takenAt: new Date().toISOString(), holders };
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`); // saved after each collection, so an interrupted run keeps its progress
  console.log(`- ${c.name}: ${holders.length} holders (${transfers} ${chain.byOwnerOf ? "tokens" : "transfers"})`.padEnd(60));
}

writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
console.log(`Saved ${OUT.slice(root.length + 1)}. Commit it and redeploy.`);
