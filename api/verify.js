import { getCollection, isAddress, holds, holderUsed, claimable, rateLimited, sameOrigin, readBody, send, handle } from "../lib/core.js";

// Step 1: does this wallet hold the collection (snapshot, then live on-chain), and has it claimed with it yet?
export default handle(async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed", message: "POST only" });
  if (!sameOrigin(req)) return send(res, 403, { error: "forbidden_origin", message: "Use the claim page." });
  if (rateLimited(req)) return send(res, 429, { error: "rate_limited", message: "Too many attempts. Wait a minute and try again." });
  const { collection, holderWallet } = await readBody(req);
  const c = getCollection(collection);
  if (!c || !claimable(c)) return send(res, 400, { error: "unknown_collection", message: "This collection isn't open for claims yet." });
  if (!isAddress(holderWallet)) return send(res, 400, { error: "invalid_address", message: "That isn't a valid wallet address (0x followed by 40 characters)." });
  const wallet = holderWallet.trim().toLowerCase();
  if (!(await holds(c, wallet))) return send(res, 200, { eligible: false, message: `This wallet doesn't hold a ${c.name} NFT. Paste the wallet that holds it.` });
  if (await holderUsed(c.id, wallet)) return send(res, 200, { eligible: false, message: `This wallet has already claimed a GTD spot with ${c.name}.` });
  send(res, 200, { eligible: true });
});
