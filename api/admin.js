import { timingSafeEqual } from "node:crypto";
import { COLLECTIONS, allClaims, snapshotCount, send, handle } from "../lib/core.js";

// GET /api/admin (header x-admin-key) -> JSON; ?format=csv -> CSV download for the mint list.
export default handle(async (req, res) => {
  const key = process.env.ADMIN_KEY || "";
  const url = new URL(req.url, "http://x");
  const given = String(req.headers["x-admin-key"] || url.searchParams.get("key") || "");
  const ok = key.length >= 8 && given.length === key.length && timingSafeEqual(Buffer.from(given), Buffer.from(key));
  if (!ok) return send(res, 401, { error: "unauthorized", message: "Wrong admin key." });
  const claims = await allClaims();
  if (url.searchParams.get("format") === "csv") {
    const rows = ["claim_wallet,collection,holding_wallet,x_handle,x_profile,claimed_at", ...claims.map((c) => [c.claimWallet, c.collection, c.holderWallet, c.x, `https://x.com/${c.x}`, c.at].join(","))];
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", 'attachment; filename="niblekins-gtd.csv"');
    return res.end(rows.join("\n") + "\n");
  }
  send(res, 200, {
    claims,
    collections: COLLECTIONS.map((c) => ({ id: c.id, name: c.name, holders: snapshotCount(c.id), claimed: claims.filter((k) => k.collection === c.id).length })),
  });
});
