import { collections, snapshotInfo, allClaims, send } from '../lib/core.js';

// Public list of collections with snapshot size and spots taken.
export default async function handler(req, res) {
  const snap = snapshotInfo();
  const claims = await allClaims();
  send(res, 200, {
    open: process.env.WL_CLOSED !== '1',
    collections: collections.map((c) => ({
      id: c.id, name: c.name, x: c.x, color: c.color, image: c.image || null,
      spots: c.spots ?? null,
      claimed: claims.filter((k) => k.collection === c.id).length,
      holders: snap[c.id]?.count ?? 0,
      ready: (snap[c.id]?.count ?? 0) > 0,
    })),
  });
}
