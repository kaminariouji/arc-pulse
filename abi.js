// Pure module: encode calls and decode results for the ArcBounty BountyAdapter on Arc mainnet.
// No dependencies — deliberate, so the Worker bundle stays small and there is no npm install.

export const ARC = {
  chainId: 5042,
  name: 'Arc Mainnet',
  rpc: 'https://rpc.blockdaemon.mainnet.arc.io',
  explorer: 'https://arcexplorer.org',
  // Arc native USDC: the 6-decimal ERC-20 interface over native 18-decimal USDC.
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

// ERC-8004 IdentityRegistry (AgentIdentity / AGENT). This is an ERC-1967 proxy:
// the address in ARC.identityRegistry is only the proxy; the implementation is read
// from slot 0x360894a1…bbc. Every function below is called against the PROXY address.
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

// byteOff = offset in BYTES from the start of the hex data
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
    // An array-of-dynamic element's offset is relative to the position AFTER the
    // length word, not to the length word itself (verified against the live contract).
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

export function decodeBountyMeta(hex) {
  const t = Number(decUint(hex, 0)) // tuple offset, in bytes
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
  // head: [offset string, offset, limit] then the string tail ('' -> length 0)
  const data = SEL.getOpenBounties + encUint(0x60) + encUint(offset) + encUint(limit) + encUint(0)
  return decUintArray(await call(ARC.adapter, data))
}

export async function getBountyMeta(id) {
  return decodeBountyMeta(await call(ARC.adapter, SEL.getBountyMeta + encUint(id)))
}

// The whole board history. ArcBounty's board is small (a dozen or so bounties), so
// pulling all of it is still one batch and far more informative than only the open
// ones — right now zero are open, so that filter renders empty.
//
// Note: getBountyMeta does NOT revert for an id that was never used; it returns a
// zeroed struct. And totalBounties() counts slot 0, which was never filled (16
// counted, 15 real). So the filter is `deadline > 0`, not "the call succeeded".
export async function allBountyMetas() {
  const total = Number(await totalBounties())
  if (total <= 0) return []
  const ids = []
  for (let i = 0; i <= total; i++) ids.push(i)
  const metas = await bountyMetas(ids)
  return metas.filter((m) => m && m.deadline > 0)
}

export async function usdcTotalSupply() {
  return BigInt(await call(ARC.usdc, SEL.totalSupply))
}

// --- ERC-8004 IdentityRegistry ---

// Arc's RPC rejects batches over 100 with error -32600 ("batch size N exceeds limit
// of 100"). Measured: 100 passes, 200 is rejected. So chunk it ourselves rather than
// relying on that limit.
export const MAX_BATCH = 100

// ERC-721 `ERC721NonexistentToken(uint256)` selector — the only revert treated as
// normal here (it means that token was never minted).
const ERC721_NONEXISTENT = '0x7e273289'

// One HTTP request for many eth_calls at once (JSON-RPC batch).
// This matters on Cloudflare Workers: the per-request subrequest budget is tight.
//
// Contract of this function: null means "no data" ONLY when the RPC actually said so.
// Transport failures and unexpected errors are THROWN, never turned into null — so
// "this agent does not exist" can never be confused with "the RPC is broken".
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
      // A rejected batch is answered with a single object (HTTP 200!) — not "empty".
      if (!Array.isArray(j)) throw new Error('RPC rejected the batch: ' + JSON.stringify(j).slice(0, 200))
      arr = j
    } finally {
      clearTimeout(t)
    }

    const byId = new Map(arr.map((x) => [x.id, x]))
    for (let k = 0; k < part.length; k++) {
      const x = byId.get(k + 1)
      if (!x) throw new Error('RPC did not answer request #' + (i + k))
      if (x.error) {
        const d = typeof x.error.data === 'string' ? x.error.data : ''
        if (d.startsWith(ERC721_NONEXISTENT)) continue // token was never minted
        throw new Error('eth_call failed: ' + String(x.error.message || '').slice(0, 160))
      }
      // '0x' = address with no code / nothing returned → stays null.
      if (x.result && x.result !== '0x') out[i + k] = x.result
    }
  }
  return out
}

// getBountyMeta for many ids in one subrequest (previously one per id).
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

// owner + wallet + URI for a set of ids in ONE subrequest.
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
    if (!owner) return null // tokenId was never minted
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

// true = the token exists, false = it was never minted.
// RPC failures are THROWN by callBatch, never disguised as "does not exist".
export async function agentExists(ids) {
  const out = await callBatch(ids.map((id) => ({ to: ARC.identityRegistry, data: SEL8004.ownerOf + uintArg(id) })))
  return out.map((r) => !!r && r !== '0x')
}

// The agent count is the largest existing id (mints are sequential from 1; the
// absence of gaps is verified separately — see verify-no-gaps.mjs). The exponential
// probes go out as ONE batch, then a ~10-step binary search.
export async function agentCount(hi = 16384) {
  const probes = []
  for (let v = 1; v <= hi; v *= 2) probes.push(v)
  const exists = await agentExists(probes)

  let lo = 0
  let high = 0
  for (let i = 0; i < probes.length; i++) {
    if (exists[i]) lo = probes[i]
    else { high = probes[i]; break }
  }
  if (!high) return lo // every probe up to hi exists — give up and report what was measured
  while (lo + 1 < high) {
    const mid = Math.floor((lo + high) / 2)
    const [ok] = await agentExists([mid])
    if (ok) lo = mid
    else high = mid
  }
  return lo
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
