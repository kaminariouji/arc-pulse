# Arc Pulse

A dependency-free, read-only data API for **Arc mainnet** (chain id 5042) — Circle's L1 where USDC is the native gas token.

Arc Pulse exposes the two halves of Arc's agent economy as plain JSON:

1. **ArcBounty** — the on-chain USDC bounty board (ERC-8183 escrow).
2. **ERC-8004 IdentityRegistry** — the agent identity registry: every registered agent as an ERC-721 with an `agentWallet` and an `agentURI`.

It speaks REST, and it also speaks **MCP**, so an AI agent can call it as a tool without any glue code. No wallet, no gas, no API key.

**Live:** https://arc-pulse.kaminariouji.workers.dev

## Why this exists

ArcBounty renders its board client-side, so the data only exists inside a browser tab. The official facade API targets Arc **testnet** and is paywalled. There was no public REST or MCP view of Arc **mainnet** state.

Arc Pulse fills that gap. One HTTP call returns the fully decoded board and the full agent registry.

## Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /api/stats` | Chain id, latest block, gas price, USDC total supply, bounty totals, registered agent count |
| `GET /api/bounties?status=all\|open\|resolved` | The whole ArcBounty board, decoded (defaults to `all` — see note below) |
| `GET /api/bounties/:id` | One bounty by id |
| `GET /api/bounties/:id?full=1` | Same, plus the task text resolved from IPFS |
| `GET /api/agents?offset=&limit=` | ERC-8004 agent identities: `agentId`, `owner`, `agentWallet`, `agentURI` (max 60/page) |
| `GET /api/agents/:id` | One identity |
| `GET /api/agents/:id?resolve=1` | Same, plus the parsed `agentURI` (`data:`, `ipfs://`, `https://`) |
| `POST /mcp` | MCP JSON-RPC 2.0 — `initialize`, `tools/list`, `tools/call`, `ping` |
| `GET /openapi.json` | OpenAPI 3.1 spec |
| `GET /skill.md` | Agent-facing skill description |
| `GET /llms.txt` | Machine-readable summary for LLM agents |
| `GET /.well-known/ai-plugin.json` | Plugin manifest |
| `GET /health` | Liveness probe |
| `GET /` | Dark-mode HTML dashboard |

### Example

```bash
curl https://arc-pulse.kaminariouji.workers.dev/api/agents/14?resolve=1
```

```json
{
  "agentId": 14,
  "owner": "0x092f4483526ebc2476c247cb88d166adb7c3232f",
  "agentWallet": "0x092f4483526ebc2476c247cb88d166adb7c3232f",
  "agentURI": "ipfs://QmdFqfwbmCJMH6YZj5avN9mAQMnpFRJMYsMNvAbE8SDm3G",
  "chain": 5042,
  "metadata": {
    "kind": "json",
    "contentType": "application/json",
    "json": {
      "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      "name": "Polite Arc Research Agent",
      "registrations": [
        { "agentId": 14, "agentRegistry": "eip155:5042:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }
      ]
    }
  }
}
```

### MCP

```bash
curl -X POST https://arc-pulse.kaminariouji.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"arc_stats","arguments":{}}}'
```

Five tools: `arc_stats`, `arc_bounties`, `arc_bounty`, `arc_agents`, `arc_agent`. The endpoint is stateless — a single POST is a complete MCP session, no handshake state required. Notifications are answered `202`. JSON-RPC batches are supported.

## Live numbers

As of the last deployment, read straight off Arc mainnet:

- **1,419** registered ERC-8004 agent identities (`AgentIdentity` / `AGENT`), ids 1–1419 with **zero gaps** — verified by scanning every id, not by trusting the highest one.
- **16** bounties ever posted on ArcBounty; **15 resolved**, 0 currently open, **38 USDC** in resolved rewards.
- USDC total supply: ~511M.

The board having zero open bounties is *why* `/api/bounties` defaults to `status=all`. An endpoint that only returns open bounties would return an empty array and look broken.

## What it uses Arc for

- Reads live state from Arc mainnet (chain id **5042**) over JSON-RPC: block number, gas price, chain id.
- Decodes the ArcBounty `BountyAdapter` at `0x73c617e808ED5c7Ca41413DFC6EE940dDcBb0b8D`, including the 26-field `getBountyMeta` tuple.
- Reports Arc's native USDC (the gas token) through its ERC-20 interface at `0x3600000000000000000000000000000000000000`.
- Reads the ERC-8004 `IdentityRegistry` at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` — an ERC-1967 proxy over implementation `0x7274e874ca62410a93bd8bf61c69d8045e399c02`.

Every call is `eth_call` against a public RPC. Nothing is signed, nothing is written on-chain.

## Design notes

- **Zero npm dependencies.** The Worker imports one local module.
- **Hand-written ABI codec** (`abi.js`): selectors, 32-byte word packing, and dynamic-type decoding including `string[]` and the 26-field `getBountyMeta` tuple. The explorer publishes no ABI for these contracts, so selectors were derived by hashing signatures.
- **Edge-cached** 20s; the expensive agent count is cached 600s.

### Things that were measured, not assumed

**The RPC caps JSON-RPC batches at 100.** Arc's RPC answers an oversized batch with HTTP **200** and a top-level error object rather than an HTTP error. An early version of `callBatch` treated any missing per-item result as "this token does not exist" — so a 450-call batch silently reported that *all 1,419 agents were missing*. `callBatch` now chunks at 100 and throws on any non-per-item error; `null` means "the RPC said this doesn't exist" and nothing else.

**`ipfs.io` no longer serves server-side requests.** It answers non-browser fetches with `429` and the body *"This IPFS gateway is switching to a service worker gateway only."* `dweb.link` behaves the same way. The gateway chain is therefore `ipfs.filebase.io` first, then those two as fallbacks — measured, not guessed.

**Roughly half of all `agentURI` values are dead.** Publishers host them on domains that no longer resolve (`kleos.network`, `apexfaucet.xyz`) or return `405`. `?resolve=1` reports those as `kind: "error"` with every attempt listed, rather than hiding the failure or inventing a result.

**Non-text `agentURI` values are not dumped into JSON.** Several agents point their `agentURI` at a JPEG. Those return `{ "kind": "binary", "contentType": "image/jpeg", "bytes": 46597 }` instead of a wall of mojibake.

### The `string[]` offset trap

Decoding an array of dynamic types is easy to get subtly wrong: each element's offset is relative to the position **after** the length word, not to the length word itself. Getting this wrong makes tags decode as a block of zero bytes followed by concatenated text. `abi.js` documents the fix inline.

### Counting agents

`ownerOf` reverts with `ERC721NonexistentToken` for ids that were never minted, so "how many agents exist" is a search problem, not a `totalSupply()` call — the registry exposes no counter. `agentCount()` probes powers of two in a single batch, then binary-searches the gap: ~11 requests. `cek-celah.mjs` independently scans *every* id to confirm the count equals the highest id (no burns, no gaps).

## Files

| File | Purpose |
|---|---|
| `worker.js` | Cloudflare Worker: routing, MCP server, JSON shaping, OpenAPI/skill/llms docs, HTML dashboard |
| `abi.js` | Hand-written ABI encoder/decoder + Arc RPC helpers (batching, agent enumeration) |
| `uji.mjs` | End-to-end test suite — 30 assertions across REST, MCP, docs and error paths. Takes an optional base URL. |
| `cek-celah.mjs` | Independent audit: scans every agent id to prove the count has no gaps |
| `test-abi.mjs` | Smoke test that runs the ABI module against live Arc mainnet |
| `wrangler.toml` | Worker config |

## Test

```bash
node uji.mjs                                        # against local wrangler dev
node uji.mjs https://arc-pulse.kaminariouji.workers.dev   # against production
```

## Deploy your own

```bash
npm install -g wrangler
wrangler deploy
```

`wrangler.toml` sets `main = "worker.js"`. No bindings, no secrets, no environment variables.

## License

MIT
