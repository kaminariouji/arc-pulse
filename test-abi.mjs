import { totalBounties, getOpenBounties, getBountyMeta, usdcTotalSupply, network, ARC } from './abi.js'
const n = await network()
console.log('network:', JSON.stringify(n))
console.log('totalBounties:', (await totalBounties()).toString())
const sup = await usdcTotalSupply()
console.log('USDC totalSupply:', (Number(sup)/1e6).toLocaleString('en-US'), 'USDC')
const open = await getOpenBounties(0, 100)
console.log('open:', open.map(String).join(', '))
for (const id of open) {
  const m = await getBountyMeta(id)
  console.log(JSON.stringify({ jobId: m.jobId, rewardUsdc: m.rewardUsdc, category: m.category, tags: m.tags, agentOnly: m.agentOnly, humanOnly: m.humanOnly, status: m.status, deadlineIso: m.deadlineIso, cid: m.descriptionCid }))
}
