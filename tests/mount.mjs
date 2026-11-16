/**
 * 挂载冒烟：模拟 Cordis ctx（假 llm + 假 webServer），跑完整 apply → run → summary 流程。
 * 断言：
 *   - 目录行全部进矩阵（含 provider 级失败 → 红行）
 *   - OFM 已判定行零 ping（省钱路径生效）
 *   - 非 OFM 行走自家 ping，成功→黄/绿，TRANSPORT 失败→红，QUOTA 失败→灰
 *   - /api/model-probe/summary 路由可应答，围栏拒绝 cross-site
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 隔离：index.js 在模块加载时解析 DSH_HOME，测试绝不能写真实 ~/.dsh。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mpd-mount-'))
process.env.DSH_HOME = TMP_HOME

const { apply } = await import('../index.js')

const pinged = []

const fakeLlm = {
  listProviders: () => [
    { id: 'our-free-model', name: 'Our Free Model' },
    { id: 'qodercn', name: 'Qoder' },
    { id: 'broken', name: 'Broken Provider' },
  ],
  listModels: async provider => {
    if (provider === 'broken') throw Object.assign(new Error('ECONNREFUSED 127.0.0.1:9999'), { code: 'TRANSPORT' })
    if (provider === 'our-free-model') {
      return [
        { id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash' },   // OFM availability: throttled → 灰
        { id: 'beam-free', name: 'Beam' },                          // OFM: region-blocked → 红
        { id: 'fresh-model-free', name: 'Fresh Free' },             // OFM 无记录 → 自家 ping
      ]
    }
    return [{ id: 'qmodel_38max', name: 'Q Model 38 Max' }]
  },
  stream: options => {
    pinged.push(`${options.provider}/${options.model}`)
    // broken 路由不会到这里；fresh-model-free 成功；qmodel 配额失败（藏在 finish 里）
    if (options.model === 'qmodel_38max') {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'insufficient credits' } } }
      })()
    }
    return (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'pong' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

const routes = new Map()
const fakeWebServer = {
  register: route => { routes.set(route.path, route); return () => routes.delete(route.path) },
}

const effects = []
const fakeCtx = {
  llm: fakeLlm,
  get: name => (name === 'webServer' ? fakeWebServer : name === 'connection' ? undefined : undefined),
  webServer: fakeWebServer,
  effect: factory => { const d = factory(); effects.push(d) },
  logger: { info: () => {}, warn: () => {}, withScope: () => ({ info: () => {}, warn: () => {} }) },
}

const svc = apply(fakeCtx, {})
assert.ok(svc, 'apply 返回服务对象')
assert.ok(routes.has('/api/model-probe'), 'API 前缀路由已注册')

// 直接跑一轮深度测试（不等 6s 定时器）
const outcome = await svc.run({ deep: true })
assert.ok(outcome.ok, 'run 成功')
const s = svc.summary()

const row = key => s.rows.find(r => r.key === key)

// OFM throttled → 灰，且没有 ping 它
const mimo = row('our-free-model/mimo-v2.6-flash-free')
assert.equal(mimo.color, 'gray', 'OFM throttled → gray')
assert.equal(mimo.source, 'ofm', 'OFM 复用来源')

// OFM region-blocked → 红
const beam = row('our-free-model/beam-free')
assert.equal(beam.color, 'red', 'OFM region-blocked → red')

// OFM 无记录 → 自家 ping 成功 → 免密车道 free → 绿
const fresh = row('our-free-model/fresh-model-free')
assert.equal(fresh.color, 'green', 'fresh-model-free ping 成功且 id 含 free → green')
assert.equal(fresh.source, 'ping')

// 非 OFM provider ping 流内 QUOTA → 灰
const q = row('qodercn/qmodel_38max')
assert.equal(q.color, 'gray', '流内 QUOTA failure → gray')

// provider 级失败 → 红行
const broken = row('broken/(provider)')
assert.equal(broken.color, 'red', 'provider listModels 失败 → red')

// OFM 已判定的行绝不进 ping 列表
assert.ok(!pinged.includes('our-free-model/mimo-v2.6-flash-free'), 'OFM 已判定行不 ping')
assert.ok(!pinged.includes('our-free-model/beam-free'), 'OFM 已判定行不 ping')
assert.ok(pinged.includes('our-free-model/fresh-model-free'), '无 OFM 记录行 ping 了')
assert.ok(pinged.includes('qodercn/qmodel_38max'), '非 OFM provider ping 了')

// 计数
assert.ok(s.counts.gray >= 2 && s.counts.red >= 2 && s.counts.green >= 1, `counts=${JSON.stringify(s.counts)}`)

// HTTP 面：同源放行 + cross-site 拒绝
const handler = routes.get('/api/model-probe').handler
function fakeRes() {
  return { status: 0, body: '', writeHead(st) { this.status = st }, end(b) { this.body = b } }
}
{
  const res = fakeRes()
  await handler({ method: 'GET', url: '/api/model-probe/summary', headers: { host: '127.0.0.1:1835', origin: 'http://127.0.0.1:1835' } }, res)
  assert.equal(res.status, 200, 'summary 200')
  const payload = JSON.parse(res.body)
  assert.ok(Array.isArray(payload.rows), 'payload.rows 数组')
}
{
  const res = fakeRes()
  await handler({ method: 'GET', url: '/api/model-probe/summary', headers: { host: '127.0.0.1:1835', 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' } }, res)
  assert.equal(res.status, 403, 'cross-site 403')
}
{
  const res = fakeRes()
  await handler({ method: 'GET', url: '/api/model-probe/nope', headers: { host: '127.0.0.1:1835' } }, res)
  assert.equal(res.status, 404, '未知路由 404')
}

// settings 持久化
{
  const res = fakeRes()
  await handler({ method: 'POST', url: '/api/model-probe/settings', headers: { host: '127.0.0.1:1835' }, async *[Symbol.asyncIterator]() { yield JSON.stringify({ deepTest: false, pingTimeoutMs: 15000 }) } }, res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.settings.deepTest, false)
  assert.equal(payload.settings.pingTimeoutMs, 15000)
}

for (const d of effects) d()
fs.rmSync(TMP_HOME, { recursive: true, force: true })
console.log('=== 挂载冒烟全部通过 ===')
console.log('pinged:', pinged)
console.log('counts:', JSON.stringify(s.counts))
