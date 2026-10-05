// Arc Pulse — API + dashboard for Arc mainnet (chain 5042), readable by agents.
//
// Why this exists: the ArcBounty board renders its stats client-side in a browser
// (read straight from the contract), and the official facade only serves Arc *Testnet*
// and is paywalled. There was no public REST API for Arc mainnet. This Worker closes
// that gap: decoded Arc mainnet contract data, ready for agents to consume.
//
// Cakupannya dua sisi ekonomi agen di Arc:
//   1. ArcBounty  — the USDC bounty board (ERC-8183 escrow)
//   2. ERC-8004   — IdentityRegistry: identitas agen (ERC-721 + agentWallet + agentURI)
//
// Every read is a read-only eth_call — no key, no gas, no account.
import {
  ARC, network, totalBounties, getBountyMeta, allBountyMetas,
  usdcTotalSupply, agentRows, agentCount, registryName,
} from './abi.js'

const CACHE_SECONDS = 20
const AGENT_COUNT_TTL = 600 // seconds; the agent count changes slowly and the search is expensive
const MAX_AGENTS_PER_PAGE = 60

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
      'access-control-allow-origin': '*',
      ...extra,
    },
  })

// The Cache API holds values that are expensive to compute but rarely change.
async function cached(key, ttl, fn) {
  try {
    const cache = caches.default
    const req = new Request('https://arc-pulse.internal/cache/' + key)
    const hit = await cache.match(req)
    if (hit) return await hit.json()
    const val = await fn()
    await cache.put(
      req,
      new Response(JSON.stringify(val), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` },
      }),
    )
    return val
  } catch {
    return await fn() // if the Cache API is unavailable, carry on anyway
  }
}

// --- ArcBounty ---

async function board() {
  // The whole history in one batch. Right now zero are open and all are resolved,
  // so an "open only" endpoint would look like a broken API — the history is the content.
  const [n, total, all] = await Promise.all([network(), totalBounties(), allBountyMetas()])
  const open = all.filter((b) => b.status === 'open' && b.rewardUsdc > 0)
  const resolved = all.filter((b) => b.resolved)
  const sumUsdc = (a) => Number(a.reduce((s, b) => s + b.rewardUsdc, 0).toFixed(6))
  return {
    network: n,
    total: Number(total),
    all,
    open,
    summary: {
      posted: all.length,
      open: open.length,
      resolved: resolved.length,
      taken: all.filter((b) => b.isTaken).length,
      agentOnly: all.filter((b) => b.agentOnly).length,
      openRewardUsdc: sumUsdc(open),
      resolvedRewardUsdc: sumUsdc(resolved),
    },
  }
}

async function stats() {
  const [n, total, sup, agents, reg] = await Promise.all([
    network(),
    totalBounties(),
    usdcTotalSupply(),
    cached('agent-count', AGENT_COUNT_TTL, () => agentCount()),
    cached('registry-name', 86400, () => registryName()),
  ])
  return {
    chain: { id: n.chainId, name: ARC.name, explorer: ARC.explorer, rpc: ARC.rpc },
    block: n.block,
    gasPriceGwei: Number(n.gasPriceGwei.toFixed(4)),
    usdc: {
      address: ARC.usdc,
      totalSupplyUsdc: Number(sup) / 1e6,
      decimals: 6,
      note: 'ERC-20 6-decimal interface over Arc native USDC; USDC is also the gas token on Arc.',
    },
    arcbounty: {
      adapter: ARC.adapter,
      totalBounties: Number(total),
    },
    agents: {
      registry: ARC.identityRegistry,
      standard: 'ERC-8004',
      name: reg.name,
      symbol: reg.symbol,
      registered: agents,
    },
  }
}

// --- ERC-8004: agent metadata ---

// Public IPFS gateways. This order is measured, not guessed:
//   ipfs.io / dweb.link  → HTTP 429 "switching to a service worker gateway only"
//                          (dead for server-side fetches since 2025)
//   filebase             → 200 application/json, CIDv0 & CIDv1
// So filebase goes first and the rest are fallbacks.
const IPFS_GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://dweb.link/ipfs/', 'https://ipfs.io/ipfs/']
const UA = 'arc-pulse/2.0 (+https://arc-pulse.kaminariouji.workers.dev/skill.md)'
const TEXTUAL = /^(application\/(json|[a-z0-9.+-]+\+json|xml|[a-z0-9.+-]+\+xml)|text\/)/i

const ipfsCid = (uri) => uri.replace(/^ipfs:\/\/(ipfs\/)?/, '')
const gatewayUrls = (cid) => IPFS_GATEWAYS.map((g) => g + cid)

// Fetch any URI through a fallback chain. Returns { kind, ... } — never throws,
// because a broken agentURI is ordinary in the real world, not an exceptional condition.
async function fetchAgentURI(uri, ms = 8000) {
  const urls = uri.startsWith('ipfs://') ? gatewayUrls(ipfsCid(uri)) : [uri]
  const attempts = []
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(ms),
        headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1', 'user-agent': UA },
      })
      if (!r.ok) { attempts.push(url + ' → HTTP ' + r.status); continue }
      const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      if (!TEXTUAL.test(ct)) {
        // Do not dump binary into JSON — just report its type and size.
        const bytes = (await r.arrayBuffer()).byteLength
        return { kind: 'binary', url, contentType: ct || 'unknown', bytes }
      }
      const t = await r.text()
      const base = { url, contentType: ct }
      try { return { kind: 'json', ...base, json: JSON.parse(t) } } catch { return { kind: 'text', ...base, raw: t.slice(0, 2000) } }
    } catch (e) {
      attempts.push(url + ' → ' + String((e && e.message) || e).slice(0, 120))
    }
  }
  return { kind: 'error', uri, attempts }
}

// agentURI may be a data: URI, ipfs:// or https://. All are turned into an object.
async function resolveAgentURI(uri) {
  if (!uri) return null
  if (!uri.startsWith('data:')) return fetchAgentURI(uri)

  const m = uri.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/)
  if (!m) return { kind: 'data', error: 'unparseable data: URI', raw: uri.slice(0, 300) }
  const contentType = m[1] || 'text/plain'
  let body
  try { body = m[2] ? atob(m[3]) : decodeURIComponent(m[3]) } catch { return { kind: 'data', contentType, error: 'data: payload could not be decoded' } }
  try { return { kind: 'data', contentType, json: JSON.parse(body) } } catch { return { kind: 'data', contentType, raw: body.slice(0, 2000) } }
}

async function agentsPage(offset, limit) {
  const total = await cached('agent-count', AGENT_COUNT_TTL, () => agentCount())
  const start = Math.max(1, offset + 1)
  const end = Math.min(total, offset + limit)
  const ids = []
  for (let i = start; i <= end; i++) ids.push(i)
  const rows = ids.length ? (await agentRows(ids)).filter(Boolean) : []
  return { total, offset, limit, count: rows.length, agents: rows }
}

// --- HTML page ---

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const short = (a) => (a && a !== '0x0000000000000000000000000000000000000000' ? a.slice(0, 8) + '…' + a.slice(-4) : '—')
const uriKind = (u) => (!u ? '—' : u.startsWith('data:') ? 'data:' : u.startsWith('ipfs://') ? 'ipfs://' : u.startsWith('https://') ? 'https://' : 'other')

async function page() {
  const [b, sup, agents] = await Promise.all([board(), usdcTotalSupply(), agentsPage(0, 12)])
  const rows = b.all.map((m) => `
      <tr>
        <td class="mono">#${m.jobId}</td>
        <td><strong>${m.rewardUsdc}</strong> USDC</td>
        <td>${esc(m.category || '—')}</td>
        <td>${(m.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') || '—'}</td>
        <td>${m.agentOnly ? '<span class="pill a">agent-only</span>' : m.humanOnly ? '<span class="pill h">human-only</span>' : '<span class="pill o">open</span>'}</td>
        <td>${m.resolved ? '<span class="pill o">resolved</span>' : m.isTaken ? '<span class="pill a">taken</span>' : '<span class="pill h">open</span>'}</td>
        <td class="mono">${m.deadlineIso.slice(0, 10)}</td>
        <td class="mono">${short(m.poster)}</td>
      </tr>`).join('')

  const arows = agents.agents.map((a) => `
      <tr>
        <td class="mono">#${a.agentId}</td>
        <td class="mono">${short(a.owner)}</td>
        <td class="mono">${short(a.agentWallet)}</td>
        <td><span class="tag">${uriKind(a.agentURI)}</span> <span class="dimtxt">${esc((a.agentURI || '').slice(0, 46))}${(a.agentURI || '').length > 46 ? '…' : ''}</span></td>
      </tr>`).join('')

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arc Pulse — Arc mainnet, readable by agents</title>
<style>
:root{--bg:#0a0d12;--fg:#e6edf3;--dim:#8b949e;--line:#1f2630;--acc:#5b9dff;--ok:#3fb950;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:40px 20px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:36px 0 12px;font-weight:600}
p.sub{color:var(--dim);margin:0 0 26px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:#0d1117}
.card .k{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.card .v{font-size:21px;margin-top:4px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.dimtxt{color:var(--dim);font-size:12px}
.tag{background:#161b22;border:1px solid var(--line);border-radius:5px;padding:1px 7px;font-size:12px;color:var(--dim)}
.pill{border-radius:20px;padding:2px 9px;font-size:12px}
.pill.a{background:rgba(91,157,255,.15);color:var(--acc)}.pill.h{background:rgba(210,153,34,.15);color:var(--warn)}.pill.o{background:rgba(63,185,80,.15);color:var(--ok)}
a{color:var(--acc)}code{background:#161b22;padding:1px 6px;border-radius:5px;font-size:13px}
.end{display:grid;gap:8px;margin-top:8px}
.end div{border-left:2px solid var(--line);padding-left:12px}
footer{margin-top:44px;color:var(--dim);font-size:13px;border-top:1px solid var(--line);padding-top:18px}
</style></head><body><div class="wrap">
<h1>Arc Pulse</h1>
<p class="sub">Arc mainnet (chain 5042), read straight from contracts and a public RPC. Read-only, no account, no key — built so agents can consume it.</p>

<div class="grid">
  <div class="card"><div class="k">Block</div><div class="v">${b.network.block.toLocaleString('en-US')}</div></div>
  <div class="card"><div class="k">Gas</div><div class="v">${b.network.gasPriceGwei.toFixed(1)} <span style="font-size:13px;color:var(--dim)">gwei</span></div></div>
  <div class="card"><div class="k">USDC supply</div><div class="v">${(Number(sup) / 1e6 / 1e6).toFixed(2)}M</div></div>
  <div class="card"><div class="k">Bounties posted</div><div class="v">${b.summary.posted}</div></div>
  <div class="card"><div class="k">Resolved reward</div><div class="v">${b.summary.resolvedRewardUsdc} <span style="font-size:13px;color:var(--dim)">USDC</span></div></div>
  <div class="card"><div class="k">Registered agents</div><div class="v">${agents.total}</div></div>
</div>

<h2>ArcBounty board <span class="dimtxt">(all ${b.summary.posted} — ${b.summary.open} open, ${b.summary.resolved} resolved)</span></h2>
${b.all.length ? `<table><thead><tr><th>Job</th><th>Reward</th><th>Category</th><th>Tags</th><th>Access</th><th>Status</th><th>Deadline</th><th>Poster</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="sub">Board is empty.</p>'}

<h2>ERC-8004 agent identities <span class="dimtxt">(first ${agents.count} of ${agents.total})</span></h2>
${agents.agents.length ? `<table><thead><tr><th>Agent</th><th>Owner</th><th>Agent wallet</th><th>agentURI</th></tr></thead><tbody>${arows}</tbody></table>` : '<p class="sub">Registry is empty.</p>'}

<h2>API</h2>
<div class="end">
  <div><code>GET /api/stats</code> — network, gas, USDC supply, bounty totals, registered agent count</div>
  <div><code>GET /api/bounties</code> — the whole ArcBounty board; <code>?status=open|resolved|all</code></div>
  <div><code>GET /api/bounties/:id</code> — one bounty; add <code>?full=1</code> to pull the task text from IPFS</div>
  <div><code>GET /api/agents</code> — ERC-8004 agent identities (owner, agent wallet, agentURI)</div>
  <div><code>GET /api/agents/:id</code> — one agent; <code>?resolve=1</code> to fetch and decode its agentURI</div>
  <div><code>POST /mcp</code> — MCP server: the same tools, callable by any AI agent</div>
  <div><code>GET /openapi.json</code> · <code>/skill.md</code> · <code>/llms.txt</code></div>
</div>

<footer>Data on-chain Arc mainnet, cache ${CACHE_SECONDS}s. ArcBounty <span class="mono">${short(ARC.adapter)}</span> · ERC-8004 registry <span class="mono">${short(ARC.identityRegistry)}</span> · <a href="${ARC.explorer}">${ARC.explorer.replace('https://', '')}</a></footer>
</div></body></html>`
}

// --- MCP (Model Context Protocol) — stateless, JSON-RPC 2.0 ---

const MCP_TOOLS = [
  {
    name: 'arc_stats',
    description: 'Arc mainnet (chain 5042) network summary: latest block, gas price, USDC total supply, total bounties posted, and how many ERC-8004 agent identities are registered.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'arc_bounties',
    description: 'The full ArcBounty board on Arc mainnet — the on-chain USDC bounty escrow (ERC-8183). Returns every bounty ever posted with its decoded reward, category, tags, access mode (agent-only / human-only / open), deadline, poster and status (open / taken / resolved), plus totals. Currently all bounties on this board are resolved and none are open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'arc_bounty',
    description: 'One ArcBounty bounty by its on-chain job id. Set full=true to also resolve the task description text from IPFS.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'On-chain job id' }, full: { type: 'boolean', description: 'Resolve the IPFS task text' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'arc_agents',
    description: 'Registered ERC-8004 agent identities on Arc mainnet. Returns agentId, owner address, agent wallet address and agentURI. Paginated.',
    inputSchema: {
      type: 'object',
      properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_AGENTS_PER_PAGE } },
      additionalProperties: false,
    },
  },
  {
    name: 'arc_agent',
    description: 'One ERC-8004 agent identity by id, including its owner, agent wallet and agentURI. Set resolve=true to fetch and parse the agentURI (supports data:, ipfs:// and https://).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' }, resolve: { type: 'boolean' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
]

async function mcpCallTool(name, args = {}) {
  const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] })
  switch (name) {
    case 'arc_stats': return text(await stats())
    case 'arc_bounties': {
      const b = await board()
      return text({
        chain: ARC.chainId,
        block: b.network.block,
        summary: b.summary,
        bounties: b.all,
      })
    }
    case 'arc_bounty': {
      const id = Number(args.id)
      if (!Number.isInteger(id) || id < 0) throw new Error('id must be an integer')
      const b = await getBountyMeta(id)
      if (args.full && b.descriptionCid) b.descriptionText = await ipfsText(b.descriptionCid)
      return text(b)
    }
    case 'arc_agents': {
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), MAX_AGENTS_PER_PAGE)
      const offset = Math.max(Number(args.offset) || 0, 0)
      return text(await agentsPage(offset, limit))
    }
    case 'arc_agent': {
      const id = Number(args.id)
      if (!Number.isInteger(id) || id < 1) throw new Error('id must be an integer >= 1')
      const rows = (await agentRows([id])).filter(Boolean)
      if (!rows.length) throw new Error('no such agent #' + id)
      const a = rows[0]
      if (args.resolve) a.metadata = await resolveAgentURI(a.agentURI)
      return text(a)
    }
    default: throw new Error('unknown tool: ' + name)
  }
}

async function mcp(request) {
  let body
  try { body = await request.json() } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400) }

  const handle = async (msg) => {
    const { method, id, params } = msg || {}
    if (!method) return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } }
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'arc-pulse', version: '2.0.0' },
          instructions: 'Read-only Arc mainnet data (chain 5042): ArcBounty USDC board and ERC-8004 agent identities. No key, no gas, no account.',
        },
      }
    }
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } }
    if (method === 'tools/call') {
      const name = params && params.name
      try {
        const out = await mcpCallTool(name, (params && params.arguments) || {})
        return { jsonrpc: '2.0', id, result: out }
      } catch (e) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true } }
      }
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (/^notifications\//.test(method)) return null // notifications are not answered
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } }
  }

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean)
    return out.length ? json(out, 200, { 'cache-control': 'no-store' }) : new Response(null, { status: 202 })
  }
  const out = await handle(body)
  if (!out) return new Response(null, { status: 202 })
  return json(out, 200, { 'cache-control': 'no-store' })
}

async function ipfsText(cid) {
  for (const url of gatewayUrls(cid.replace(/^ipfs:\/\//, ''))) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'user-agent': UA } })
      if (!r.ok) continue
      const t = await r.text()
      return t.length > 20000 ? t.slice(0, 20000) : t
    } catch { /* coba gateway berikutnya */ }
  }
  return null
}

// --- specifications for agents ---

const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Arc Pulse',
    version: '2.0.0',
    description:
      'Read-only data API for Arc mainnet (chain 5042), Circle\'s L1 where USDC is the native gas token. Exposes the ArcBounty USDC board (ERC-8183 escrow) and the ERC-8004 agent IdentityRegistry. No API key, no account, no gas.',
    license: { name: 'MIT' },
  },
  servers: [{ url: 'https://arc-pulse.kaminariouji.workers.dev' }],
  paths: {
    '/api/stats': { get: { summary: 'Network + protocol summary', responses: { 200: { description: 'OK' } } } },
    '/api/bounties': {
      get: {
        summary: 'The ArcBounty board — every bounty with decoded metadata and status',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['all', 'open', 'resolved'], default: 'all' }, description: 'Filter by status. Default all, because this board currently has no open bounties.' },
        ],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/bounties/{id}': {
      get: {
        summary: 'One bounty',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'full', in: 'query', schema: { type: 'boolean' }, description: 'Resolve the IPFS task text' },
        ],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/agents': {
      get: {
        summary: 'Registered ERC-8004 agent identities (paginated)',
        parameters: [
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: MAX_AGENTS_PER_PAGE } },
        ],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/agents/{id}': {
      get: {
        summary: 'One ERC-8004 agent identity',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'resolve', in: 'query', schema: { type: 'boolean' }, description: 'Fetch and parse the agentURI (data:, ipfs://, https://)' },
        ],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/mcp': { post: { summary: 'MCP (Model Context Protocol) endpoint — JSON-RPC 2.0, tools: arc_stats, arc_bounties, arc_bounty, arc_agents, arc_agent', responses: { 200: { description: 'OK' } } } },
    '/llms.txt': { get: { summary: 'Agent-readable summary', responses: { 200: { description: 'OK' } } } },
    '/skill.md': { get: { summary: 'Agent skill description', responses: { 200: { description: 'OK' } } } },
    '/health': { get: { summary: 'Liveness', responses: { 200: { description: 'OK' } } } },
  },
}

const SKILL_MD = `# Arc Pulse

Read-only data API for **Arc mainnet** (chain id 5042) — Circle's L1 where USDC is the native gas token.
No API key, no account, no wallet, no gas. Every value comes from \`eth_call\` against a public RPC.

Base URL: \`https://arc-pulse.kaminariouji.workers.dev\`

## What it covers

Two halves of Arc's agent economy:

1. **ArcBounty** — Arc mainnet's on-chain USDC bounty board (ERC-8183 escrow + ERC-8004 identity).
   The public ArcBounty UI is browser-only and the official facade targets *testnet* and is paywalled,
   so there was no public REST view of the mainnet board. This is it.
2. **ERC-8004 IdentityRegistry** — the agent identity registry at
   \`${ARC.identityRegistry}\` (ERC-1967 proxy, implementation \`0x7274e874ca62410a93bd8bf61c69d8045e399c02\`).
   Each registered agent is an ERC-721 token with an \`agentWallet\` and an \`agentURI\`
   (\`data:\`, \`ipfs://\` or \`https://\`).

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | \`/api/stats\` | chain, block, gas, USDC supply, bounty count, registered agent count |
| GET | \`/api/bounties?status=all\\|open\\|resolved\` | the whole ArcBounty board, decoded |
| GET | \`/api/bounties/{id}\` | one bounty (\`?full=1\` pulls the IPFS task text) |
| GET | \`/api/agents?offset=&limit=\` | ERC-8004 identities, paginated |
| GET | \`/api/agents/{id}\` | one identity (\`?resolve=1\` fetches + parses the agentURI) |
| POST | \`/mcp\` | MCP JSON-RPC 2.0: \`initialize\`, \`tools/list\`, \`tools/call\` |
| GET | \`/openapi.json\` | OpenAPI 3.1 spec |
| GET | \`/llms.txt\` | this summary, plain text |
| GET | \`/health\` | liveness |

## MCP tools

- \`arc_stats\` — network + protocol summary
- \`arc_bounties\` — the whole ArcBounty board
- \`arc_bounty\` \`{ id, full? }\` — one bounty
- \`arc_agents\` \`{ offset?, limit? }\` — registered agent identities
- \`arc_agent\` \`{ id, resolve? }\` — one identity

## Notes for callers

- Amounts are decimal USDC (6 decimals on the ERC-20 interface over native USDC).
- Responses are edge-cached ${CACHE_SECONDS}s; the agent count is cached ${AGENT_COUNT_TTL}s.
- The ArcBounty board currently has no open bounties — all of them are resolved. \`/api/bounties\` returns the full history by default for that reason.
- \`agentURI\` is fetched over a gateway fallback chain (IPFS gateways included). A \`kind: "error"\` result means the URI itself is dead on the publisher's side — roughly half of them are. That is reported, never hidden.
- Taking a bounty requires USDC on Arc for gas. This API is read-only by design and never signs anything.
- Don't scrape in a tight loop — cache headers are set, respect them.
`

function llmsTxt(agentTotal) {
  return [
    '# Arc Pulse',
    '',
    '> Read-only, agent-readable data API for Arc mainnet (chain 5042). No API key, no account, no gas.',
    '',
    "Arc is Circle's L1 where USDC is the native gas token. Arc Pulse exposes two things: the",
    'ArcBounty USDC bounty board (ERC-8183 escrow) and the ERC-8004 agent IdentityRegistry.',
    'The official ArcBounty facade only serves Arc Testnet and is paid; there is no public REST API',
    'for Arc mainnet. This service fills that gap.',
    '',
    '## Endpoints',
    '- GET /api/stats — chain id, latest block, gas price, USDC total supply, total bounties, registered agents',
    '- GET /api/bounties?status=all|open|resolved — the whole ArcBounty board with decoded metadata (reward, category, tags, access mode, deadline, poster, status) and totals',
    '- GET /api/bounties/{id} — one bounty; add ?full=1 to resolve the IPFS task description',
    '- GET /api/agents?offset=&limit= — ERC-8004 agent identities (agentId, owner, agentWallet, agentURI)',
    '- GET /api/agents/{id} — one identity; add ?resolve=1 to fetch and parse its agentURI (data:, ipfs://, https://)',
    '- POST /mcp — MCP JSON-RPC 2.0 endpoint (tools: arc_stats, arc_bounties, arc_bounty, arc_agents, arc_agent)',
    '- GET /openapi.json — OpenAPI 3.1 spec',
    '- GET /skill.md — same information as this file, in Markdown',
    '- GET /health',
    '',
    '## Contract addresses (Arc mainnet, chain 5042)',
    '- ArcBounty BountyAdapter: ' + ARC.adapter,
    '- ERC-8004 IdentityRegistry (proxy): ' + ARC.identityRegistry,
    '- USDC (ERC-20 view over native USDC, 6 decimals): ' + ARC.usdc,
    '- RPC: ' + ARC.rpc,
    '',
    '## Notes',
    '- All values are read via eth_call against the public RPC. Nothing is cached longer than ' + CACHE_SECONDS + ' seconds.',
    '- USDC amounts are decimal USDC (6 decimals on the ERC-20 interface).',
    '- Registered agent identities on Arc mainnet: ' + (agentTotal ?? 'see /api/stats') + '.',
    '- To take a bounty you need USDC on Arc for gas; this API is read-only by design.',
    '',
  ].join('\n')
}

const AI_PLUGIN = {
  schema_version: 'v1',
  name_for_human: 'Arc Pulse',
  name_for_model: 'arc_pulse',
  description_for_human: 'Read-only data API for Arc mainnet: the ArcBounty USDC board and ERC-8004 agent identities.',
  description_for_model:
    'Use arc_pulse to read Arc mainnet (chain 5042) without a wallet. It exposes the ArcBounty USDC bounty board (decoded rewards, categories, tags, deadlines, access mode) and the ERC-8004 IdentityRegistry of registered agents (owner, agent wallet, agentURI). No key, no gas, no signing.',
  auth: { type: 'none' },
  api: { type: 'openapi', url: 'https://arc-pulse.kaminariouji.workers.dev/openapi.json' },
  logo_url: 'https://arc-pulse.kaminariouji.workers.dev/health',
  contact_email: 'kaminariouji@gmail.com',
  legal_info_url: 'https://github.com/kaminariouji/arc-pulse/blob/main/LICENSE',
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const p = url.pathname.replace(/\/+$/, '') || '/'

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, accept, mcp-protocol-version',
        },
      })
    }

    try {
      if (p === '/health') return json({ ok: true, service: 'arc-pulse', version: '2.0.0', chain: ARC.chainId })

      if (p === '/mcp') {
        if (request.method === 'POST') return await mcp(request)
        return json({
          protocol: 'mcp',
          transport: 'http',
          usage: 'POST JSON-RPC 2.0 here (initialize, tools/list, tools/call)',
          tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
        })
      }

      if (p === '/llms.txt') {
        let total = null
        try { total = await cached('agent-count', AGENT_COUNT_TTL, () => agentCount()) } catch { /* biarkan null */ }
        return new Response(llmsTxt(total), {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': `public, max-age=${CACHE_SECONDS}` },
        })
      }

      if (p === '/skill.md') {
        return new Response(SKILL_MD, {
          headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': `public, max-age=${CACHE_SECONDS}` },
        })
      }

      if (p === '/openapi.json') return json(OPENAPI)
      if (p === '/.well-known/ai-plugin.json') return json(AI_PLUGIN)

      if (p === '/api/stats') return json(await stats())

      if (p === '/api/bounties') {
        const b = await board()
        const status = (url.searchParams.get('status') || 'all').toLowerCase()
        const list = status === 'open' ? b.open : status === 'resolved' ? b.all.filter((x) => x.resolved) : b.all
        return json({
          chain: ARC.chainId,
          block: b.network.block,
          totalBounties: b.total,
          status,
          summary: b.summary,
          count: list.length,
          bounties: list,
        })
      }

      const mb = p.match(/^\/api\/bounties\/(\d+)$/)
      if (mb) {
        const b = await getBountyMeta(mb[1])
        if (url.searchParams.get('full') === '1' && b.descriptionCid) {
          b.descriptionText = await ipfsText(b.descriptionCid)
        }
        return json(b)
      }

      if (p === '/api/agents') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), MAX_AGENTS_PER_PAGE)
        const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
        const out = await agentsPage(offset, limit)
        return json({ chain: ARC.chainId, registry: ARC.identityRegistry, standard: 'ERC-8004', ...out })
      }

      const ma = p.match(/^\/api\/agents\/(\d+)$/)
      if (ma) {
        const id = Number(ma[1])
        const rows = (await agentRows([id])).filter(Boolean)
        if (!rows.length) return json({ error: 'agent not found', agentId: id }, 404)
        const a = rows[0]
        a.chain = ARC.chainId
        a.registry = ARC.identityRegistry
        if (url.searchParams.get('resolve') === '1') a.metadata = await resolveAgentURI(a.agentURI)
        return json(a)
      }

      if (p === '/') return new Response(await page(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${CACHE_SECONDS}` } })

      return json(
        {
          error: 'not found',
          endpoints: ['/', '/api/stats', '/api/bounties', '/api/bounties/:id', '/api/agents', '/api/agents/:id', '/mcp', '/openapi.json', '/skill.md', '/llms.txt', '/health'],
        },
        404,
      )
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502)
    }
  },
}
