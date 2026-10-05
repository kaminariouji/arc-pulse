// Uji end-to-end worker Arc Pulse. Tanpa argumen → dev lokal; dengan argumen → URL itu.
const BASE = (process.argv[2] || 'http://127.0.0.1:8799').replace(/\/+$/, '')
console.log('Sasaran:', BASE)

let lulus = 0
let gagal = 0
const ok = (nama, syarat, info = '') => {
  if (syarat) { lulus++; console.log('  PASS', nama, info ? '— ' + info : '') }
  else { gagal++; console.log('  FAIL', nama, info ? '— ' + info : '') }
}

const get = async (path) => {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(60000) })
  const ct = r.headers.get('content-type') || ''
  return { status: r.status, ct, body: ct.includes('json') ? await r.json() : await r.text() }
}
const mcp = async (payload) => {
  const r = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  })
  return { status: r.status, body: r.status === 202 ? null : await r.json() }
}
const isiTool = (res) => JSON.parse(res.body.result.content[0].text)

console.log('\n— dokumen & liveness —')
for (const [path, cek] of [
  ['/health', (b) => b.ok === true && b.chain === 5042],
  ['/openapi.json', (b) => b.openapi === '3.1.0' && b.paths['/mcp']],
  ['/llms.txt', (b) => typeof b === 'string' && b.includes('/api/agents')],
  ['/skill.md', (b) => typeof b === 'string' && b.includes('ERC-8004')],
  ['/.well-known/ai-plugin.json', (b) => b.schema_version === 'v1' && b.auth.type === 'none'],
]) {
  const r = await get(path)
  ok('GET ' + path, r.status === 200 && cek(r.body))
}

console.log('\n— REST —')
{
  const r = await get('/api/stats')
  const a = r.body.agents
  ok('/api/stats', r.status === 200 && a.standard === 'ERC-8004' && a.registered > 0,
    `${a.name}/${a.symbol}, ${a.registered} agent, blok ${r.body.block}`)
}
{
  const r = await get('/api/agents?limit=3')
  ok('/api/agents?limit=3', r.status === 200 && r.body.agents.length === 3 && r.body.count === 3,
    r.body.agents.map((x) => '#' + x.agentId).join(' '))
  ok('  bentuk baris', r.body.agents.every((x) => /^0x[0-9a-f]{40}$/.test(x.owner) && 'agentId' in x && 'agentURI' in x))
}
{
  const r = await get('/api/agents?limit=999')
  ok('limit dipagari ke 60', r.body.limit === 60, 'limit=' + r.body.limit)
}
{
  const r = await get('/api/agents?offset=1400&limit=5')
  ok('offset dekat ujung', r.status === 200 && r.body.agents.length > 0, 'count=' + r.body.count)
}
{
  const r = await get('/api/agents/999999')
  ok('agent tidak ada → 404', r.status === 404)
}
{
  const r = await get('/api/bounties')
  ok('/api/bounties', r.status === 200 && Array.isArray(r.body.bounties) && r.body.count === r.body.bounties.length,
    `${r.body.count} bounty, ${r.body.summary.resolved} resolved, ${r.body.summary.resolvedRewardUsdc} USDC`)
}
{
  const r = await get('/api/bounties?status=open')
  ok('/api/bounties?status=open', r.status === 200 && r.body.bounties.every((b) => b.status === 'open'), 'count=' + r.body.count)
}
{
  const r = await get('/api/bounties/1')
  ok('/api/bounties/1', r.status === 200 && r.body.jobId === 1 && typeof r.body.rewardUsdc === 'number',
    `${r.body.rewardUsdc} USDC, ${r.body.category}, ${r.body.status}`)
}
{
  const r = await get('/')
  ok('halaman HTML', r.status === 200 && r.body.includes('Arc Pulse') && r.body.includes('Registered agents'))
}
{
  const r = await get('/tidak-ada')
  ok('404 rute tak dikenal', r.status === 404 && Array.isArray(r.body.endpoints))
}
{
  const r = await fetch(BASE + '/mcp', { method: 'OPTIONS' })
  ok('CORS preflight → 204', r.status === 204 && r.headers.get('access-control-allow-origin') === '*')
}

console.log('\n— MCP —')
{
  const r = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  ok('initialize', r.body.result.protocolVersion === '2024-11-05' && r.body.result.serverInfo.name === 'arc-pulse')
}
{
  const r = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const nama = r.body.result.tools.map((t) => t.name)
  ok('tools/list', nama.length === 5, nama.join(', '))
  ok('  tiap tool punya schema', r.body.result.tools.every((t) => t.inputSchema && t.description.length > 40))
}
for (const [tool, args] of [
  ['arc_stats', {}],
  ['arc_bounties', {}],
  ['arc_bounty', { id: 1 }],
  ['arc_agents', { limit: 2 }],
  ['arc_agent', { id: 14, resolve: true }],
]) {
  const r = await mcp({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: tool, arguments: args } })
  const isi = isiTool(r)
  const baik = !r.body.result.isError && isi && typeof isi === 'object'
  ok('tools/call ' + tool, baik, baik ? '' : JSON.stringify(isi).slice(0, 120))
}
{
  const r = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'arc_bounty', arguments: { id: 'bukan angka' } } })
  ok('tool dgn arg salah → isError, bukan crash', r.body.result.isError === true)
}
{
  const r = await mcp({ jsonrpc: '2.0', id: 4, method: 'tidak/ada' })
  ok('method tak dikenal → -32601', r.body.error && r.body.error.code === -32601)
}
{
  const r = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })
  ok('notifikasi → 202 tanpa badan', r.status === 202 && r.body === null)
}
{
  const r = await mcp([
    { jsonrpc: '2.0', id: 10, method: 'tools/list' },
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'arc_stats', arguments: {} } },
  ])
  ok('batch JSON-RPC', Array.isArray(r.body) && r.body.length === 2 && r.body[0].id === 10 && r.body[1].id === 11)
}
{
  const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{rusak' })
  const j = await res.json()
  ok('badan rusak → -32700', res.status === 400 && j.error.code === -32700)
}

console.log(`\nHASIL: ${lulus} lulus, ${gagal} gagal`)
process.exit(gagal ? 1 : 0)
