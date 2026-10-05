// Audit independen: apakah jumlah agent itu NYATA, atau cuma id tertinggi (ada celah/burn)?
// Memindai SETIAP id, bukan mempercayai pencarian biner di abi.js.
import { agentCount, agentRows } from './abi.js'

const MAX = await agentCount()
console.log('agentCount() melaporkan id tertinggi:', MAX)

const CHUNK = 150 // 150 id x 3 panggilan = 450 eth_call; callBatch memotongnya jadi 5 batch
const ids = []
for (let i = 1; i <= MAX; i++) ids.push(i)

let ada = 0
const hilang = []
for (let i = 0; i < ids.length; i += CHUNK) {
  const bagian = ids.slice(i, i + CHUNK)
  const rows = await agentRows(bagian)
  for (let k = 0; k < bagian.length; k++) {
    if (rows[k]) ada++
    else hilang.push(bagian[k])
  }
  process.stdout.write(`\r  dipindai ${Math.min(i + CHUNK, MAX)}/${MAX} — ada ${ada}, hilang ${hilang.length}`)
}
console.log('')
console.log('id tertinggi yang ada        :', MAX)
console.log('jumlah yang benar-benar ada  :', ada)
console.log('jumlah id hilang             :', hilang.length)
if (hilang.length) console.log('id hilang (maks 40)          :', hilang.slice(0, 40).join(', '))
console.log(ada === MAX ? '\nSIMPULAN: tidak ada celah — angka agentCount() akurat.' : '\nSIMPULAN: ADA CELAH — agentCount() melebih-lebihkan jumlah agent.')
