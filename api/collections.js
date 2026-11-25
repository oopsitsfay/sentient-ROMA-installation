import { COLLECTIONS, OPEN, STORAGE_READY, CHAIN_NAMES, claimable, claimCounts, snapshotCount, send, handle } from "../lib/core.js";

// Public list of partner collections with spots claimed. Holder lists are never published.
export default handle(async (req, res) => {
  let counts = {};
  let storage = STORAGE_READY;
  if (storage) try {
    counts = await claimCounts();
  } catch (err) {
    console.error("claim counts unavailable", err.message);
    storage = false;
  }
  const open = OPEN && storage;
  send(res, 200, {
    open,
    collections: COLLECTIONS.map((c) => {
      const claimed = counts[c.id] ?? 0;
      return {
        id: c.id,
        name: c.name,
        x: c.x,
        chain: c.chain,
        chainName: CHAIN_NAMES[c.chain] ?? c.chain,
        image: c.image || null,
        opensea: c.opensea || null,
        color: c.color,
        spots: c.spots,
        claimed,
        holders: snapshotCount(c.id),
        open: open && claimable(c) && (c.spots == null || claimed < c.spots),
      };
    }),
  });
});
