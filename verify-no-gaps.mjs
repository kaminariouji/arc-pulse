// Independent audit: is the agent count REAL, or just the highest id (are there gaps/burns)?
// Scans EVERY id rather than trusting the binary search in abi.js.
import { agentCount, agentRows } from './abi.js'

const MAX = await agentCount()
console.log('agentCount() reports the highest id:', MAX)

const CHUNK = 150 // 150 ids x 3 calls = 450 eth_calls; callBatch splits that into 5 batches
const ids = []
for (let i = 1; i <= MAX; i++) ids.push(i)

let present = 0
const missing = []
for (let i = 0; i < ids.length; i += CHUNK) {
  const slice = ids.slice(i, i + CHUNK)
  const rows = await agentRows(slice)
  for (let k = 0; k < slice.length; k++) {
    if (rows[k]) present++
    else missing.push(slice[k])
  }
  process.stdout.write(`\r  scanned ${Math.min(i + CHUNK, MAX)}/${MAX} — present ${present}, missing ${missing.length}`)
}
console.log('')
console.log('highest existing id        :', MAX)
console.log('ids that actually exist    :', present)
console.log('ids missing                :', missing.length)
if (missing.length) console.log('missing ids (max 40)       :', missing.slice(0, 40).join(', '))
console.log(present === MAX ? '\nCONCLUSION: no gaps — agentCount() is accurate.' : '\nCONCLUSION: GAPS FOUND — agentCount() overstates the agent count.')
