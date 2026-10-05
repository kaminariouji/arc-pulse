// End-to-end test for the Arc Pulse worker. No argument → local dev; argument → that base URL.
const BASE = (process.argv[2] || 'http://127.0.0.1:8799').replace(/\/+$/, '')
console.log('Target:', BASE)

let passed = 0
let failed = 0
const check = (name, condition, info = '') => {
  if (condition) { passed++; console.log('  PASS', name, info ? '— ' + info : '') }
  else { failed++; console.log('  FAIL', name, info ? '— ' + info : '') }
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
const toolPayload = (res) => JSON.parse(res.body.result.content[0].text)

console.log('\n— docs & liveness —')
for (const [path, verify] of [
  ['/health', (b) => b.ok === true && b.chain === 5042],
  ['/openapi.json', (b) => b.openapi === '3.1.0' && b.paths['/mcp']],
  ['/llms.txt', (b) => typeof b === 'string' && b.includes('/api/agents')],
  ['/skill.md', (b) => typeof b === 'string' && b.includes('ERC-8004')],
  ['/.well-known/ai-plugin.json', (b) => b.schema_version === 'v1' && b.auth.type === 'none'],
]) {
  const r = await get(path)
  check('GET ' + path, r.status === 200 && verify(r.body))
}

console.log('\n— REST —')
{
  const r = await get('/api/stats')
  const a = r.body.agents
  check('/api/stats', r.status === 200 && a.standard === 'ERC-8004' && a.registered > 0,
    `${a.name}/${a.symbol}, ${a.registered} agents, block ${r.body.block}`)
}
{
  const r = await get('/api/agents?limit=3')
  check('/api/agents?limit=3', r.status === 200 && r.body.agents.length === 3 && r.body.count === 3,
    r.body.agents.map((x) => '#' + x.agentId).join(' '))
  check('  row shape', r.body.agents.every((x) => /^0x[0-9a-f]{40}$/.test(x.owner) && 'agentId' in x && 'agentURI' in x))
}
{
  const r = await get('/api/agents?limit=999')
  check('limit clamped to 60', r.body.limit === 60, 'limit=' + r.body.limit)
}
{
  const r = await get('/api/agents?offset=1400&limit=5')
  check('offset near the end', r.status === 200 && r.body.agents.length > 0, 'count=' + r.body.count)
}
{
  const r = await get('/api/agents/999999')
  check('unknown agent → 404', r.status === 404)
}
{
  const r = await get('/api/bounties')
  check('/api/bounties', r.status === 200 && Array.isArray(r.body.bounties) && r.body.count === r.body.bounties.length,
    `${r.body.count} bounties, ${r.body.summary.resolved} resolved, ${r.body.summary.resolvedRewardUsdc} USDC`)
  check('  no uninitialised slot leaks in', r.body.bounties.every((b) => b.deadline > 0))
}
{
  const r = await get('/api/bounties?status=open')
  check('/api/bounties?status=open', r.status === 200 && r.body.bounties.every((b) => b.status === 'open'), 'count=' + r.body.count)
}
{
  const r = await get('/api/bounties/1')
  check('/api/bounties/1', r.status === 200 && r.body.jobId === 1 && typeof r.body.rewardUsdc === 'number',
    `${r.body.rewardUsdc} USDC, ${r.body.category}, ${r.body.status}`)
}
{
  const r = await get('/')
  check('HTML dashboard', r.status === 200 && r.body.includes('Arc Pulse') && r.body.includes('Registered agents'))
}
{
  const r = await get('/no-such-route')
  check('unknown route → 404', r.status === 404 && Array.isArray(r.body.endpoints))
}
{
  const r = await fetch(BASE + '/mcp', { method: 'OPTIONS' })
  check('CORS preflight → 204', r.status === 204 && r.headers.get('access-control-allow-origin') === '*')
}

console.log('\n— MCP —')
{
  const r = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  check('initialize', r.body.result.protocolVersion === '2024-11-05' && r.body.result.serverInfo.name === 'arc-pulse')
}
{
  const r = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = r.body.result.tools.map((t) => t.name)
  check('tools/list', names.length === 5, names.join(', '))
  check('  every tool has a schema', r.body.result.tools.every((t) => t.inputSchema && t.description.length > 40))
}
for (const [tool, args] of [
  ['arc_stats', {}],
  ['arc_bounties', {}],
  ['arc_bounty', { id: 1 }],
  ['arc_agents', { limit: 2 }],
  ['arc_agent', { id: 14, resolve: true }],
]) {
  const r = await mcp({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: tool, arguments: args } })
  const payload = toolPayload(r)
  const good = !r.body.result.isError && payload && typeof payload === 'object'
  check('tools/call ' + tool, good, good ? '' : JSON.stringify(payload).slice(0, 120))
}
{
  const r = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'arc_bounty', arguments: { id: 'not a number' } } })
  check('bad tool argument → isError, not a crash', r.body.result.isError === true)
}
{
  const r = await mcp({ jsonrpc: '2.0', id: 4, method: 'no/such/method' })
  check('unknown method → -32601', r.body.error && r.body.error.code === -32601)
}
{
  const r = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })
  check('notification → 202 with no body', r.status === 202 && r.body === null)
}
{
  const r = await mcp([
    { jsonrpc: '2.0', id: 10, method: 'tools/list' },
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'arc_stats', arguments: {} } },
  ])
  check('JSON-RPC batch', Array.isArray(r.body) && r.body.length === 2 && r.body[0].id === 10 && r.body[1].id === 11)
}
{
  const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })
  const j = await res.json()
  check('malformed body → -32700', res.status === 400 && j.error.code === -32700)
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
