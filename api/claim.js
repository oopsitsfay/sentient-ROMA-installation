import { STORAGE_READY, OPEN, getCollection, isAddress, holds, claimable, claimCounts, normalizeHandle, saveClaim, rateLimited, sameOrigin, readBody, send, handle } from "../lib/core.js";

// Step 2: record the GTD spot. Every check from /api/verify runs again here.
export default handle(async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed", message: "POST only" });
  if (!OPEN) return send(res, 403, { error: "closed", message: "GTD claims are closed." });
  if (!STORAGE_READY) return send(res, 503, { error: "not_ready", message: "Claims open shortly. Try again in a few minutes." });
  if (!sameOrigin(req)) return send(res, 403, { error: "forbidden_origin", message: "Use the claim page." });
  if (rateLimited(req)) return send(res, 429, { error: "rate_limited", message: "Too many attempts. Wait a minute and try again." });
  const b = await readBody(req);
  const c = getCollection(b.collection);
  if (!c || !claimable(c)) return send(res, 400, { error: "unknown_collection", message: "This collection isn't open for claims yet." });
  if (!isAddress(b.holderWallet)) return send(res, 400, { error: "invalid_address", message: "The holding wallet isn't a valid address." });
  const claimRaw = b.sameWallet ? b.holderWallet : b.claimWallet;
  if (!isAddress(claimRaw)) return send(res, 400, { error: "invalid_address", message: "Paste a valid wallet to receive the GTD spot." });
  const x = normalizeHandle(b.xHandle);
  if (!x || x.toLowerCase() === "niblekins") return send(res, 400, { error: "invalid_x_handle", message: "Enter your own X username." });

  const holderWallet = b.holderWallet.trim().toLowerCase();
  const claimWallet = claimRaw.trim().toLowerCase();
  if (!(await holds(c, holderWallet))) return send(res, 403, { error: "not_holder", message: `This wallet doesn't hold a ${c.name} NFT.` });
  if (c.spots != null && ((await claimCounts())[c.id] ?? 0) >= c.spots) return send(res, 409, { error: "full", message: `All ${c.name} GTD spots are taken.` });

  const r = await saveClaim({ collection: c.id, holderWallet, claimWallet, x, at: new Date().toISOString() });
  if (!r.ok) {
    const message = {
      holder_used: `This wallet has already claimed a GTD spot with ${c.name}.`,
      claim_used: "That wallet already has a GTD spot.",
      x_used: `@${x} has already claimed a GTD spot.`,
    }[r.reason];
    return send(res, 409, { error: r.reason, message });
  }
  send(res, 201, { ok: true, claimWallet });
});
