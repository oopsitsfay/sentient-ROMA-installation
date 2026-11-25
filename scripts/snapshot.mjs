// Builds data/holders.json: the current holders of every collection in collections.json.
// It replays every Transfer event of each contract from the chain's RPC, so no API key is needed.
//
//   node scripts/snapshot.mjs                 # all collections that have a contract set
//   node scripts/snapshot.mjs blokyz funkari  # only these
//   RPC_URL=https://... node scripts/snapshot.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'collections.json'), 'utf8'));
const RPC = process.env.RPC_URL || cfg.chain.rpc;
if (!/^https?:\/\//.test(RPC)) { console.error('Set chain.rpc in collections.json or RPC_URL.'); process.exit(1); }

const T721 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer
const T1155S = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62'; // TransferSingle
const T1155B = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d4cbcd8bf43ff3e9c'; // TransferBatch
const ZERO = '0x0000000000000000000000000000000000000000';
const BURN = new Set([ZERO, '0x000000000000000000000000000000000000dead']);

let id = 0;
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { rpc: true });
      return j.result;
    } catch (e) {
      if (e.rpc || attempt >= 4) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt));
    }
  }
}

const addr = (topic) => '0x' + topic.slice(26).toLowerCase();
const words = (data) => (data.slice(2).match(/.{64}/g) || []).map((w) => BigInt('0x' + w));

async function* logs(contract, topics, from, to) {
  let step = 50_000;
  for (let start = from; start <= to; ) {
    const end = Math.min(start + step - 1, to);
    try {
      yield* await rpc('eth_getLogs', [{ address: contract, topics: [topics], fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }]);
      start = end + 1;
      if (step < 500_000) step *= 2;
    } catch (e) {
      if (step <= 10) throw e;
      step = Math.floor(step / 4); // RPC refused the range: retry with a smaller one
    }
  }
}

async function snapshot(c, latest) {
  const bal = new Map();
  const move = (from, to, n) => {
    if (from !== ZERO) bal.set(from, (bal.get(from) || 0n) - n);
    bal.set(to, (bal.get(to) || 0n) + n);
  };
  let events = 0;
  for await (const l of logs(c.contract, [T721, T1155S, T1155B], c.startBlock || 0, latest)) {
    events++;
    if (l.topics[0] === T721 && l.topics.length === 4) move(addr(l.topics[1]), addr(l.topics[2]), 1n);
    else if (l.topics[0] === T1155S) { const [, v] = words(l.data); move(addr(l.topics[2]), addr(l.topics[3]), v); }
    else if (l.topics[0] === T1155B) {
      // data = offset_ids, offset_values, [len, ids...], [len, values...]
      const w = words(l.data); const n = Number(w[2]); const vals = w.slice(3 + n + 1, 3 + n + 1 + n);
      for (const v of vals) move(addr(l.topics[2]), addr(l.topics[3]), v);
    }
    if (events % 5000 === 0) process.stdout.write(`  ${events} transfers…\r`);
  }
  const min = BigInt(c.minHeld || 1);
  const holders = [...bal].filter(([a, n]) => n >= min && !BURN.has(a)).map(([a]) => a).sort();
  return { holders, events };
}

const only = process.argv.slice(2);
const latest = parseInt(await rpc('eth_blockNumber', []), 16);
const outFile = path.join(root, 'data', 'holders.json');
const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
console.log(`Snapshot at block ${latest} via ${RPC}`);

for (const c of cfg.collections) {
  if (only.length && !only.includes(c.id)) continue;
  if (!/^0x[0-9a-fA-F]{40}$/.test(c.contract || '')) { console.log(`- ${c.name}: no contract set, skipped`); continue; }
  const { holders, events } = await snapshot(c, latest);
  out[c.id] = { name: c.name, contract: c.contract.toLowerCase(), block: latest, takenAt: new Date().toISOString(), holders };
  console.log(`- ${c.name}: ${holders.length} holders (${events} transfers)`);
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(`Saved ${outFile}`);
