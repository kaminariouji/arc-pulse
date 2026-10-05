// Modul murni: encode panggilan + decode hasil untuk BountyAdapter ArcBounty di Arc mainnet.
// Tanpa dependensi — sengaja, supaya bundle Worker tetap kecil dan tidak ada npm install.

export const ARC = {
  chainId: 5042,
  name: 'Arc Mainnet',
  rpc: 'https://rpc.blockdaemon.mainnet.arc.io',
  explorer: 'https://arcexplorer.org',
  // USDC native Arc: antarmuka ERC-20 6 desimal di atas USDC native 18 desimal.
  usdc: '0x3600000000000000000000000000000000000000',
  adapter: '0x73c617e808ED5c7Ca41413DFC6EE940dDcBb0b8D',
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
}

export const SEL = {
  totalBounties: '0x85feeb23',
  getOpenBounties: '0x3b705d35',
  getBountyMeta: '0x374d94d3',
  totalSupply: '0x18160ddd',
}

// ERC-8004 IdentityRegistry (AgentIdentity / AGENT). Ini kontrak ERC-1967 proxy:
// alamat di ARC.identityRegistry hanyalah proxy; implementasinya dibaca dari slot
// 0x360894a1…bbc. Semua fungsi di bawah dipanggil ke alamat PROXY.
export const SEL8004 = {
  ownerOf: '0x6352211e',
  tokenURI: '0xc87b56dd',
  getAgentWallet: '0x00339509',
  name: '0x06fdde03',
  symbol: '0x95d89b41',
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function bytesToHex(u8) {
  let s = ''
  for (const b of u8) s += b.toString(16).padStart(2, '0')
  return s
}

export function hexToBytes(h) {
  const s = h.startsWith('0x') ? h.slice(2) : h
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16)
  return out
}

export function pad32(hex) {
  return hex.replace(/^0x/, '').padStart(64, '0')
}

export function encUint(v) {
  return BigInt(v).toString(16).padStart(64, '0')
}

export function encString(s) {
  const b = enc.encode(s)
  let out = encUint(b.length)
  for (let i = 0; i < b.length; i += 32) {
    let chunk = ''
    for (let j = i; j < Math.min(i + 32, b.length); j++) chunk += b[j].toString(16).padStart(2, '0')
    out += chunk.padEnd(64, '0')
  }
  return out
}

// --- decode ---

export function word(hex, i) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  return h.slice(i * 64, (i + 1) * 64)
}

export function decUint(hex, i) {
  return BigInt('0x' + word(hex, i))
}

export function decAddr(hex, i) {
  return '0x' + word(hex, i).slice(24)
}

export function decBool(hex, i) {
  return decUint(hex, i) !== 0n
}

// byteOff = offset dalam BYTE dari awal data hex
export function decString(hex, byteOff) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const len = Number(BigInt('0x' + h.slice(byteOff * 2, byteOff * 2 + 64)))
  const start = byteOff * 2 + 64
  return dec.decode(hexToBytes(h.slice(start, start + len * 2)))
}

export function decStringArray(hex, byteOff) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const n = Number(BigInt('0x' + h.slice(byteOff * 2, byteOff * 2 + 64)))
  const out = []
  for (let k = 0; k < n; k++) {
    const w = byteOff * 2 + 64 + k * 64
    const rel = Number(BigInt('0x' + h.slice(w, w + 64)))
    // Offset elemen array-of-dynamic relatif ke posisi SETELAH word panjang,
    // bukan ke word panjang itu sendiri (diverifikasi terhadap kontrak live).
    out.push(decString(hex, byteOff + 32 + rel))
  }
  return out
}

export function decUintArray(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const off = Number(BigInt('0x' + h.slice(0, 64)))
  const n = Number(BigInt('0x' + h.slice(off * 2, off * 2 + 64)))
  const out = []
  for (let k = 0; k < n; k++) {
    const w = off * 2 + 64 + k * 64
    out.push(BigInt('0x' + h.slice(w, w + 64)))
  }
  return out
}

const DYN = { 4: 'string', 5: 'string', 6: 'string[]', 12: 'string', 16: 'string', 21: 'string', 22: 'string', 23: 'string' }

export function decodeBountyMeta(hex) {
  const t = Number(decUint(hex, 0)) // offset tuple, dalam byte
  const at = (i) => t + i * 32
  const f = (i) => word(hex, at(i) / 32)
  const dyn = (i, kind) => {
    const rel = Number(BigInt('0x' + f(i)))
    return kind === 'string' ? decString(hex, t + rel) : decStringArray(hex, t + rel)
  }
  const u = (i) => BigInt('0x' + f(i))
  const a = (i) => '0x' + f(i).slice(24)
  const b = (i) => BigInt('0x' + f(i)) !== 0n

  return {
    jobId: Number(u(0)),
    poster: a(1),
    reward: u(2).toString(),
    rewardUsdc: Number(u(2)) / 1e6,
    deadline: Number(u(3)),
    deadlineIso: new Date(Number(u(3)) * 1000).toISOString(),
    descriptionCid: dyn(4, 'string'),
    category: dyn(5, 'string'),
    tags: dyn(6, 'string[]'),
    agentId: Number(u(7)),
    agentOnly: b(8),
    humanOnly: b(9),
    whitelistedProvider: a(10),
    assignedProvider: a(11),
    submittedResultHash: dyn(12, 'string'),
    submittedAt: Number(u(13)),
    isTaken: b(14),
    rejectedAt: Number(u(15)),
    rejectionReasonHash: dyn(16, 'string'),
    inDispute: b(17),
    resolved: b(18),
    disputeInitiator: a(19),
    disputeRaisedAt: Number(u(20)),
    disputeReasonHash: dyn(21, 'string'),
    disputeResponseHash: dyn(22, 'string'),
    disputeRulingHash: dyn(23, 'string'),
    requireWorkerBond: b(24),
    workerBond: u(25).toString(),
    workerBondUsdc: Number(u(25)) / 1e6,
    status: b(18) ? 'resolved' : b(14) ? 'taken' : 'open',
  }
}

// --- RPC ---

export async function rpc(method, params, timeoutMs = 15000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(ARC.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctl.signal,
    })
    const j = await r.json()
    if (j.error) throw new Error(j.error.message || 'rpc error')
    return j.result
  } finally {
    clearTimeout(t)
  }
}

export async function call(to, data) {
  return rpc('eth_call', [{ to, data }, 'latest'])
}

export async function totalBounties() {
  return BigInt(await call(ARC.adapter, SEL.totalBounties))
}

export async function getOpenBounties(offset = 0, limit = 100) {
  // head: [offset string, offset, limit] lalu ekor string ('' -> panjang 0)
  const data = SEL.getOpenBounties + encUint(0x60) + encUint(offset) + encUint(limit) + encUint(0)
  return decUintArray(await call(ARC.adapter, data))
}

export async function getBountyMeta(id) {
  return decodeBountyMeta(await call(ARC.adapter, SEL.getBountyMeta + encUint(id)))
}

// Seluruh riwayat papan: id 0..total-1. Papan ArcBounty kecil (belasan bounty),
// jadi menarik semuanya masih satu batch dan jauh lebih informatif daripada
// hanya yang terbuka — saat ini yang terbuka nol, jadi filter itu menampilkan hampa.
export async function allBountyMetas() {
  const total = Number(await totalBounties())
  if (total <= 0) return []
  const ids = []
  for (let i = 0; i < total; i++) ids.push(i)
  const metas = await bountyMetas(ids)
  return metas.filter(Boolean)
}

export async function usdcTotalSupply() {
  return BigInt(await call(ARC.usdc, SEL.totalSupply))
}

// --- ERC-8004 IdentityRegistry ---

// RPC Arc menolak batch > 100 dengan error -32600 ("batch size N exceeds limit of 100").
// Terukur: 100 lolos, 200 ditolak. Jadi potong sendiri, jangan bergantung pada batas itu.
export const MAX_BATCH = 100

// Selector error ERC-721 `ERC721NonexistentToken(uint256)` — satu-satunya revert
// yang dianggap normal di sini (artinya token itu memang belum pernah di-mint).
const ERC721_NONEXISTENT = '0x7e273289'

// Satu HTTP request untuk banyak eth_call sekaligus (JSON-RPC batch).
// Penting di Cloudflare Workers: batas subrequest per request itu ketat.
//
// Kontrak fungsi ini: null berarti "tidak ada data" HANYA kalau RPC memang bilang
// begitu. Kegagalan transport atau error tak terduga DILEMPAR, tidak pernah jadi null —
// supaya "agent tidak ada" tidak pernah tertukar dengan "RPC sedang rusak".
export async function callBatch(requests, timeoutMs = 20000) {
  if (!requests.length) return []
  const out = new Array(requests.length).fill(null)

  for (let i = 0; i < requests.length; i += MAX_BATCH) {
    const part = requests.slice(i, i + MAX_BATCH)
    const body = part.map((r, k) => ({
      jsonrpc: '2.0',
      id: k + 1,
      method: 'eth_call',
      params: [{ to: r.to, data: r.data }, 'latest'],
    }))
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    let arr
    try {
      const res = await fetch(ARC.rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
      const j = await res.json()
      // Batch yang ditolak dijawab objek tunggal (HTTP 200!) — jangan dianggap "kosong".
      if (!Array.isArray(j)) throw new Error('RPC menolak batch: ' + JSON.stringify(j).slice(0, 200))
      arr = j
    } finally {
      clearTimeout(t)
    }

    const byId = new Map(arr.map((x) => [x.id, x]))
    for (let k = 0; k < part.length; k++) {
      const x = byId.get(k + 1)
      if (!x) throw new Error('RPC tidak menjawab permintaan #' + (i + k))
      if (x.error) {
        const d = typeof x.error.data === 'string' ? x.error.data : ''
        if (d.startsWith(ERC721_NONEXISTENT)) continue // token belum di-mint
        throw new Error('eth_call gagal: ' + String(x.error.message || '').slice(0, 160))
      }
      // '0x' = alamat tanpa kode / tidak mengembalikan apa pun → tetap null.
      if (x.result && x.result !== '0x') out[i + k] = x.result
    }
  }
  return out
}

// getBountyMeta untuk banyak id dalam satu subrequest (sebelumnya satu per id).
export async function bountyMetas(ids) {
  const out = await callBatch(ids.map((id) => ({ to: ARC.adapter, data: SEL.getBountyMeta + encUint(id) })))
  return out.map((hex) => {
    if (!hex) return null
    try { return decodeBountyMeta(hex) } catch { return null }
  })
}

const uintArg = (v) => encUint(v)

export async function agentOwner(id) {
  return decAddr(await call(ARC.identityRegistry, SEL8004.ownerOf + uintArg(id)), 0)
}

export async function agentWallet(id) {
  return decAddr(await call(ARC.identityRegistry, SEL8004.getAgentWallet + uintArg(id)), 0)
}

export async function agentURI(id) {
  return decString(await call(ARC.identityRegistry, SEL8004.tokenURI + uintArg(id)), 32)
}

// Ambil owner+wallet+URI untuk sekumpulan id dalam SATU subrequest.
export async function agentRows(ids) {
  const reqs = []
  for (const id of ids) {
    reqs.push({ to: ARC.identityRegistry, data: SEL8004.ownerOf + uintArg(id) })
    reqs.push({ to: ARC.identityRegistry, data: SEL8004.getAgentWallet + uintArg(id) })
    reqs.push({ to: ARC.identityRegistry, data: SEL8004.tokenURI + uintArg(id) })
  }
  const out = await callBatch(reqs)
  return ids.map((id, k) => {
    const owner = out[k * 3]
    if (!owner) return null // tokenId belum pernah di-mint
    const wallet = out[k * 3 + 1]
    const uri = out[k * 3 + 2]
    return {
      agentId: id,
      owner: decAddr(owner, 0),
      agentWallet: wallet ? decAddr(wallet, 0) : null,
      agentURI: uri ? decString(uri, 32) : null,
    }
  })
}

// true = token ada, false = belum pernah di-mint.
// Kegagalan RPC DILEMPAR lewat callBatch, tidak pernah disamarkan jadi "tidak ada".
export async function agentExists(ids) {
  const out = await callBatch(ids.map((id) => ({ to: ARC.identityRegistry, data: SEL8004.ownerOf + uintArg(id) })))
  return out.map((r) => !!r && r !== '0x')
}

// Jumlah agent = id terbesar yang ada (mint berurutan dari 1; celahnya diverifikasi
// terpisah — lihat cek-celah.mjs). Lompatan eksponensial dikirim dalam SATU batch,
// lalu binary search ~10 langkah.
export async function agentCount(hi = 16384) {
  const probes = []
  for (let v = 1; v <= hi; v *= 2) probes.push(v)
  const ada = await agentExists(probes)

  let bawah = 0
  let atas = 0
  for (let i = 0; i < probes.length; i++) {
    if (ada[i]) bawah = probes[i]
    else { atas = probes[i]; break }
  }
  if (!atas) return bawah // semua probe ada sampai hi — menyerah, laporkan yang terukur
  while (bawah + 1 < atas) {
    const mid = Math.floor((bawah + atas) / 2)
    const [ok] = await agentExists([mid])
    if (ok) bawah = mid
    else atas = mid
  }
  return bawah
}

export async function registryName() {
  const [n, s] = await Promise.all([
    call(ARC.identityRegistry, SEL8004.name),
    call(ARC.identityRegistry, SEL8004.symbol),
  ])
  return { name: decString(n, 32), symbol: decString(s, 32) }
}

export async function network() {
  const [blockHex, gasHex, chainHex] = await Promise.all([
    rpc('eth_blockNumber', []),
    rpc('eth_gasPrice', []),
    rpc('eth_chainId', []),
  ])
  return {
    chainId: Number(BigInt(chainHex)),
    block: Number(BigInt(blockHex)),
    gasPriceWei: BigInt(gasHex).toString(),
    gasPriceGwei: Number(BigInt(gasHex)) / 1e9,
  }
}
