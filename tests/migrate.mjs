/**
 * 迁移验证：把真实 results.json 放进临时 DSH_HOME，apply() 后确认
 * classifyVersion 迁移把 "· 免费" 行从 yellow 重算为 green（不重新 ping）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpd-migrate-'))
fs.mkdirSync(path.join(tmp, 'model-probe'), { recursive: true })
fs.copyFileSync('C:/Users/CS/.dsh/model-probe/results.json', path.join(tmp, 'model-probe', 'results.json'))
process.env.DSH_HOME = tmp

const { apply } = await import('../index.js')

const pinged = []
const fakeLlm = {
  listProviders: () => [],
  listModels: async () => { pinged.push('called'); return [] },
  stream: () => { pinged.push('stream'); return (async function* () {})() },
}
const routes = new Map()
const fakeCtx = {
  llm: fakeLlm,
  get: () => undefined,
  effect: f => { const d = f(); return d },
  logger: { info: () => {}, warn: () => {}, withScope: () => ({ info: () => {}, warn: () => {} }) },
}
const svc = apply(fakeCtx, {})
const s = svc.summary()

const qf = s.rows.find(r => r.key === 'qodercn/qfmodel')
assert.ok(qf, 'qfmodel 行存在')
console.log('qfmodel:', qf.name, '→', qf.color, qf.costSource)
assert.equal(qf.color, 'green', '迁移后 "· 免费" 行 = green')
assert.equal(qf.costSource, 'catalog:free-wording')

const df = s.rows.find(r => r.key === 'qodercn/dfmodel')
assert.equal(df.color, 'yellow', '倍率行保持 yellow')
assert.equal(df.costSource, 'catalog:multiplier')

// OFM 来源行不受迁移影响
const ofmRow = s.rows.find(r => String(r.costSource ?? '').startsWith('ofm:'))
if (ofmRow) console.log('OFM 行未动:', ofmRow.key, ofmRow.color, ofmRow.costSource)

assert.equal(pinged.length, 0, '迁移不触发任何 ping')
assert.equal(s.settings.classifyVersion, 2, 'classifyVersion 已写入')
console.log('counts:', JSON.stringify(s.counts))
console.log('=== 迁移验证通过 ===')
fs.rmSync(tmp, { recursive: true, force: true })
