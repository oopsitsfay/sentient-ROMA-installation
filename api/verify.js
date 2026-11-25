import { getCollection, isAddress, norm, holds, findByHolder, readBody, send } from '../lib/core.js';

// Step 1: is this wallet in the holder snapshot for the collection, and is it still unused?
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const { collection, holderWallet } = await readBody(req);
  const c = getCollection(collection);
  if (!c) return send(res, 400, { error: 'Unknown collection.' });
  if (!isAddress(holderWallet)) return send(res, 400, { error: 'That is not a valid wallet address (0x + 40 characters).' });
  const h = norm(holderWallet);
  if (!holds(c.id, h)) return send(res, 200, { eligible: false, message: `This wallet is not in the ${c.name} holder snapshot.` });
  if (await findByHolder(c.id, h)) return send(res, 200, { eligible: false, message: `This wallet has already been used to claim with ${c.name}.` });
  send(res, 200, { eligible: true });
}
