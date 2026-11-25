import { getCollection, isAddress, norm, holds, saveClaim, countFor, readBody, send } from '../lib/core.js';

// Step 2: record the claim. Every check from /api/verify is repeated here.
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (process.env.WL_CLOSED === '1') return send(res, 403, { error: 'Claims are closed.' });
  const body = await readBody(req);
  const c = getCollection(body.collection);
  if (!c) return send(res, 400, { error: 'Unknown collection.' });
  if (!isAddress(body.holderWallet)) return send(res, 400, { error: 'Holding wallet is not a valid address.' });
  const claimRaw = body.sameWallet ? body.holderWallet : body.claimWallet;
  if (!isAddress(claimRaw)) return send(res, 400, { error: 'Claim wallet is not a valid address.' });
  const x = String(body.xHandle || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(x)) return send(res, 400, { error: 'Enter your X handle (letters, numbers, underscore).' });

  const holderWallet = norm(body.holderWallet);
  const claimWallet = norm(claimRaw);
  if (!holds(c.id, holderWallet)) return send(res, 403, { error: `This wallet is not in the ${c.name} holder snapshot.` });
  if (c.spots && (await countFor(c.id)) >= c.spots) return send(res, 403, { error: `All ${c.name} spots are taken.` });

  const rec = { collection: c.id, holderWallet, claimWallet, x, at: new Date().toISOString() };
  const r = await saveClaim(rec);
  if (!r.ok) {
    const msg = r.reason === 'holder_used'
      ? `This holding wallet has already claimed with ${c.name}.`
      : 'That claim wallet already has a spot.';
    return send(res, 409, { error: msg });
  }
  send(res, 200, { ok: true, claimWallet });
}
