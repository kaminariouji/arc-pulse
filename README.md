# Arc Pulse

A dependency-free, read-only REST API for **Arc mainnet** — Circle's L1 where USDC is the native gas token.

Arc Pulse decodes the on-chain **ArcBounty** board (ERC-8183 escrow + ERC-8004 agent identity) and exposes it as plain JSON, so any agent or script can read Arc's USDC bounty market with a single HTTP call. No wallet, no gas, no API key.

**Live:** https://arc-pulse.kaminariouji.workers.dev

## Why this exists

ArcBounty only shows its board in a browser, and the official facade API targets Arc **testnet** and is itself paywalled. There was no public REST API for the Arc **mainnet** bounty board. Arc Pulse fills that gap.

## Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /api/stats` | Chain id, latest block, gas price, USDC total supply, total bounty count |
| `GET /api/bounties` | Every open bounty with fully decoded metadata |
| `GET /api/bounties/:id` | One bounty by id |
| `GET /api/bounties/:id?full=1` | Same, plus the task text pulled from IPFS |
| `GET /llms.txt` | Machine-readable description for LLM agents |
| `GET /health` | Liveness probe |
| `GET /` | Dark-mode HTML dashboard |

Example:

```bash
curl https://arc-pulse.kaminariouji.workers.dev/api/bounties
```

```json
{
  "chain": 5042,
  "block": 22463856,
  "totalBounties": 15,
  "openCount": 2,
  "bounties": [
    {
      "jobId": 14,
      "rewardUsdc": 2,
      "deadlineIso": "2026-09-30T05:49:38.000Z",
      "category": "other",
      "tags": ["onboarding", "ux", "report"],
      "humanOnly": true,
      "status": "open"
    }
  ]
}
```

## What it uses Arc for

- Reads live state from Arc mainnet (chain id **5042**) over JSON-RPC.
- Decodes the ArcBounty `BountyAdapter` at `0x73c617e808ED5c7Ca41413DFC6EE940dDcBb0b8D`.
- Reports Arc's native USDC (the gas token) ERC-20 interface at `0x3600000000000000000000000000000000000000`.
- Resolves bounty task text from IPFS (`ipfs://` → `https://ipfs.io/ipfs/`).

All reads are `eth_call` / `eth_getLogs` against a public RPC. Nothing is signed, nothing is written.

## Design notes

- **Zero npm dependencies.** The Cloudflare Worker imports only a local ABI module.
- **Hand-written ABI codec** (`abi.js`) — selectors, 32-byte word packing, and dynamic-type decoding including `string[]` and the 26-field `getBountyMeta` tuple.
- Edge-cached for 20 seconds so repeated reads don't hammer the RPC.

### The `string[]` offset trap

Decoding an array of dynamic types is easy to get subtly wrong: each element's offset is relative to the position **after** the length word, not to the length word itself. Getting this wrong makes tags decode as a block of zero bytes followed by concatenated text. `abi.js` documents the fix inline.

## Deploy your own

```bash
npm install -g wrangler
wrangler deploy
```

`wrangler.toml` sets `main = "worker.js"`. No bindings, no secrets, no environment variables.

## Files

| File | Purpose |
|---|---|
| `worker.js` | Cloudflare Worker: routing, JSON shaping, HTML dashboard, IPFS fetch |
| `abi.js` | Hand-written ABI encoder/decoder + Arc RPC helpers |
| `test-abi.mjs` | Smoke test that runs the ABI module against live Arc mainnet |
| `wrangler.toml` | Worker config |

## License

MIT
