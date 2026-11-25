# Niblekins: partner GTD claim

A standalone claim page for holders of Niblekins partner NFT collections, on Robinhood Chain and Ethereum. There's no
wallet connection. A holder picks their collection and pastes the wallet that holds the NFT. The page checks that
wallet against the holder snapshot, or live on-chain if it bought after the snapshot. The holder then chooses which
wallet gets the guaranteed spot.

## Pieces

| Path | What |
|---|---|
| `collections.json` | Partner collections: chain, contract, OpenSea link, artwork, optional `spots` cap |
| `data/holders.json` | Holder snapshot, made by `npm run snapshot` |
| `public/` | The page (`index.html`), the admin page (`admin.html`) and the artwork |
| `api/` | `collections`, `verify`, `claim` and `admin` (Vercel functions) |
| `lib/core.js` | Holder checks, the live `balanceOf` check and claim storage |

The rules are one claim per holding wallet per collection, one spot per receiving wallet, and one spot per X account.

## Running on Vercel

- **Storage:** claims are stored in Upstash Redis, through `KV_REST_API_URL` and `KV_REST_API_TOKEN` (set when Upstash is connected in Vercel).
- **Admin page:** `/admin` needs `ADMIN_KEY` and has a CSV download for the mint list.
- **Closing claims:** set `GTD_CLOSED=1`.
- **Other RPCs:** set `RPC_ROBINHOOD` or `RPC_ETHEREUM` to use RPCs other than the default public ones.

## Updating the holder snapshot

```
NODE_USE_ENV_PROXY=1 npm run snapshot    # or: npm run snapshot -- vaultlings rektguy
```

Commit `data/holders.json` afterwards, and the next deploy uses it.

## Local preview

```
npm install && npm run dev    # http://localhost:3000; claims go to data/claims.local.json
```
