# Niblekins: partner GTD claim

A whitelist (GTD) claim site for holders of Niblekins partner collections on Robinhood Chain.
There's no wallet connection. A holder picks their collection, pastes the wallet that holds the NFT,
and chooses which wallet gets the GTD spot.

## How it works

1. `scripts/snapshot.mjs` reads every Transfer event of each partner contract over the
   Robinhood Chain RPC and writes the current holders to `data/holders.json`.
2. The site (`public/`) lists the collections. A collection becomes claimable once its snapshot has holders.
3. `/api/verify` checks the pasted wallet against the snapshot.
   `/api/claim` saves the holding wallet, the claim wallet and the X handle.
   Each holding wallet can claim once per collection, and each claim wallet can only get one spot.
4. `/admin` (needs `ADMIN_KEY`) shows every claim and downloads the CSV for the mint list.

## Setup

1. Put each contract address in `collections.json` and set `chain.rpc` to the Robinhood Chain RPC URL.
   Optional fields per collection:
   - `spots`: a cap on claims
   - `minHeld`: the minimum NFTs held, default 1
   - `startBlock`: the deploy block, which makes the snapshot faster
   - `image`: a logo URL, otherwise coloured initials are shown
2. Run `npm run snapshot`, then commit `data/holders.json`.
   Run it again whenever you want a fresh snapshot.
3. Deploy to Vercel. In the Vercel Marketplace, connect an **Upstash Redis** store, which sets the
   `KV_REST_API_*` variables. Then set these environment variables:
   - `ADMIN_KEY`: the password for `/admin`
   - `WL_CLOSED=1` (optional): closes claims

## Local preview

```
npm run dev   # http://localhost:3000
```

Without Redis, claims are saved to `data/claims.local.json`.
