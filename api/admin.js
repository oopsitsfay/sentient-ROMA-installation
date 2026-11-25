import { allClaims, collections, snapshotInfo, send } from '../lib/core.js';

// GET /api/admin            -> JSON of all claims (header x-admin-key: ADMIN_KEY)
// GET /api/admin?format=csv -> CSV download
export default async function handler(req, res) {
  const key = process.env.ADMIN_KEY;
  const given = req.headers['x-admin-key'] || new URL(req.url, 'http://x').searchParams.get('key');
  if (!key || given !== key) return send(res, 401, { error: 'Wrong admin key.' });
  const claims = await allClaims();
  if (new URL(req.url, 'http://x').searchParams.get('format') === 'csv') {
    const rows = ['claim_wallet,collection,holding_wallet,x_handle,claimed_at', ...claims.map((c) => [c.claimWallet, c.collection, c.holderWallet, c.x, c.at].join(','))];
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="niblekins-gtd.csv"');
    return res.end(rows.join('\n'));
  }
  const snap = snapshotInfo();
  send(res, 200, { claims, collections: collections.map((c) => ({ id: c.id, name: c.name, holders: snap[c.id]?.count ?? 0, claimed: claims.filter((k) => k.collection === c.id).length })) });
}
