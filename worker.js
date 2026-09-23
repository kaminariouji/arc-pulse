// Arc Pulse — API + dasbor Arc mainnet (chain 5042) yang bisa dibaca agen.
//
// Kenapa ini ada: papan bounty ArcBounty hanya menyajikan statistiknya di browser
// (dibaca langsung dari kontrak), dan facade resminya hanya melayani Arc *Testnet*
// serta berbayar. Tidak ada REST API publik untuk Arc mainnet. Worker ini menutup
// celah itu: data kontrak Arc mainnet yang sudah didekode, siap dibaca agen.
//
// Semua pembacaan read-only lewat eth_call — tanpa kunci, tanpa gas, tanpa akun.
import {
  ARC, network, totalBounties, getOpenBounties, getBountyMeta, usdcTotalSupply,
} from './abi.js'

const CACHE_SECONDS = 20

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

async function board() {
  const [n, total, openIds] = await Promise.all([network(), totalBounties(), getOpenBounties(0, 200)])
  const items = []
  for (const id of openIds) {
    try { items.push(await getBountyMeta(id)) } catch { /* lewati bounty yang gagal dibaca */ }
  }
  return { network: n, total, openIds: openIds.map(Number), items }
}

async function stats() {
  const [n, total, sup] = await Promise.all([network(), totalBounties(), usdcTotalSupply()])
  return {
    chain: { id: n.chainId, name: ARC.name, explorer: ARC.explorer, rpc: ARC.rpc },
    block: n.block,
    gasPriceGwei: Number(n.gasPriceGwei.toFixed(4)),
    usdc: {
      address: ARC.usdc,
      totalSupplyUsdc: Number(sup) / 1e6,
      decimals: 6,
      note: 'Antarmuka ERC-20 6 desimal di atas USDC native Arc; USDC juga gas token di Arc.',
    },
    arcbounty: {
      adapter: ARC.adapter,
      totalBounties: Number(total),
    },
  }
}

async function ipfsText(cid) {
  const url = 'https://ipfs.io/ipfs/' + cid.replace(/^ipfs:\/\//, '')
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return null
    const t = await r.text()
    return t.length > 20000 ? t.slice(0, 20000) : t
  } catch { return null }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const short = (a) => (a && a !== '0x0000000000000000000000000000000000000000' ? a.slice(0, 8) + '…' + a.slice(-4) : '—')
const hoursLeft = (iso) => ((new Date(iso).getTime() - Date.now()) / 36e5)

async function page() {
  const b = await board()
  const sup = await usdcTotalSupply()
  const rows = b.items.map((m) => `
      <tr>
        <td class="mono">#${m.jobId}</td>
        <td><strong>${m.rewardUsdc}</strong> USDC</td>
        <td>${esc(m.category || '—')}</td>
        <td>${(m.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') || '—'}</td>
        <td>${m.agentOnly ? '<span class="pill a">agent-only</span>' : m.humanOnly ? '<span class="pill h">human-only</span>' : '<span class="pill o">open</span>'}</td>
        <td class="mono">${hoursLeft(m.deadlineIso).toFixed(1)}h</td>
        <td class="mono">${short(m.poster)}</td>
      </tr>`).join('')

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arc Pulse — Arc mainnet, readable by agents</title>
<style>
:root{--bg:#0a0d12;--fg:#e6edf3;--dim:#8b949e;--line:#1f2630;--acc:#5b9dff;--ok:#3fb950;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:40px 20px}
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
.tag{background:#161b22;border:1px solid var(--line);border-radius:5px;padding:1px 7px;font-size:12px;color:var(--dim)}
.pill{border-radius:20px;padding:2px 9px;font-size:12px}
.pill.a{background:rgba(91,157,255,.15);color:var(--acc)}.pill.h{background:rgba(210,153,34,.15);color:var(--warn)}.pill.o{background:rgba(63,185,80,.15);color:var(--ok)}
a{color:var(--acc)}code{background:#161b22;padding:1px 6px;border-radius:5px;font-size:13px}
.end{display:grid;gap:8px;margin-top:8px}
.end div{border-left:2px solid var(--line);padding-left:12px}
footer{margin-top:44px;color:var(--dim);font-size:13px;border-top:1px solid var(--line);padding-top:18px}
</style></head><body><div class="wrap">
<h1>Arc Pulse</h1>
<p class="sub">Arc mainnet (chain 5042), dibaca langsung dari kontrak dan RPC publik. Read-only, tanpa akun, tanpa kunci — dirancang supaya agen bisa mengonsumsinya.</p>

<div class="grid">
  <div class="card"><div class="k">Block</div><div class="v">${b.network.block.toLocaleString('en-US')}</div></div>
  <div class="card"><div class="k">Gas</div><div class="v">${b.network.gasPriceGwei.toFixed(1)} <span style="font-size:13px;color:var(--dim)">gwei</span></div></div>
  <div class="card"><div class="k">USDC supply</div><div class="v">${(Number(sup) / 1e6 / 1e6).toFixed(2)}M</div></div>
  <div class="card"><div class="k">Bounties posted</div><div class="v">${b.total}</div></div>
  <div class="card"><div class="k">Open now</div><div class="v">${b.items.length}</div></div>
</div>

<h2>Open ArcBounty board</h2>
${b.items.length ? `<table><thead><tr><th>Job</th><th>Reward</th><th>Category</th><th>Tags</th><th>Access</th><th>Left</th><th>Poster</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="sub">Tidak ada bounty terbuka saat ini.</p>'}

<h2>API</h2>
<div class="end">
  <div><code>GET /api/stats</code> — jaringan, gas, supply USDC, jumlah bounty</div>
  <div><code>GET /api/bounties</code> — semua bounty terbuka, metadata terdekode</div>
  <div><code>GET /api/bounties/:id</code> — satu bounty; tambahkan <code>?full=1</code> untuk menarik teks deskripsi dari IPFS</div>
  <div><code>GET /llms.txt</code> — ringkasan untuk agen</div>
</div>

<footer>Data on-chain Arc mainnet, cache ${CACHE_SECONDS}s. Kontrak ArcBounty <span class="mono">${short(ARC.adapter)}</span> · <a href="${ARC.explorer}">${ARC.explorer.replace('https://', '')}</a></footer>
</div></body></html>`
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const p = url.pathname.replace(/\/+$/, '') || '/'

    try {
      if (p === '/health') return json({ ok: true, service: 'arc-pulse', chain: ARC.chainId })

      if (p === '/llms.txt') {
        const txt = [
          '# Arc Pulse',
          '',
          '> Read-only, agent-readable data API for Arc mainnet (chain 5042). No API key, no account, no gas.',
          '',
          'Arc is Circle\'s L1 where USDC is the native gas token. ArcBounty is its on-chain USDC bounty board',
          '(ERC-8183 escrow + ERC-8004 identity/reputation). Its public facade only serves Arc Testnet and is paid;',
          'there is no public REST API for Arc mainnet. This service fills that gap.',
          '',
          '## Endpoints',
          '- GET /api/stats — chain id, latest block, gas price, USDC total supply, total bounties posted',
          '- GET /api/bounties — every open bounty with decoded metadata (reward, category, tags, access mode, deadline, poster)',
          '- GET /api/bounties/{id} — one bounty; add ?full=1 to resolve the IPFS task description',
          '- GET /health',
          '',
          '## Contract addresses (Arc mainnet, chain 5042)',
          '- ArcBounty BountyAdapter: ' + ARC.adapter,
          '- USDC (ERC-20 view over native USDC, 6 decimals): ' + ARC.usdc,
          '- ERC-8004 IdentityRegistry: ' + ARC.identityRegistry,
          '- RPC: ' + ARC.rpc,
          '',
          '## Notes',
          '- All values are read via eth_call against the public RPC. Nothing is cached longer than ' + CACHE_SECONDS + ' seconds.',
          '- USDC amounts are decimal USDC (6 decimals on the ERC-20 interface).',
          '- To take a bounty you need USDC on Arc for gas; this API is read-only by design.',
          '',
        ].join('\n')
        return new Response(txt, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': `public, max-age=${CACHE_SECONDS}` } })
      }

      if (p === '/api/stats') return json(await stats())

      if (p === '/api/bounties') {
        const b = await board()
        return json({
          chain: ARC.chainId,
          block: b.network.block,
          totalBounties: Number(b.total),
          openCount: b.items.length,
          bounties: b.items,
        })
      }

      const m = p.match(/^\/api\/bounties\/(\d+)$/)
      if (m) {
        const b = await getBountyMeta(m[1])
        if (url.searchParams.get('full') === '1' && b.descriptionCid) {
          b.descriptionText = await ipfsText(b.descriptionCid)
        }
        return json(b)
      }

      if (p === '/') return new Response(await page(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${CACHE_SECONDS}` } })

      return json({ error: 'not found', endpoints: ['/', '/api/stats', '/api/bounties', '/api/bounties/:id', '/llms.txt', '/health'] }, 404)
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502)
    }
  },
}
