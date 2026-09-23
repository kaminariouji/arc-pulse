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

export async function usdcTotalSupply() {
  return BigInt(await call(ARC.usdc, SEL.totalSupply))
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
