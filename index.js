/**
 * dsh-ofm-extension — 模型测活矩阵（宿主半边）。
 *
 * 职责：
 *   1. 目录：ctx.llm.listProviders() × listModels(provider)，即模型选择器
 *      所见的全部候选（与宿主 buildModelCatalog 同源，不做额外过滤）；
 *   2. 判定：优先复用 Our Free Model 已持久化的真实测活结果
 *      （$DSH_HOME/our-free-model/availability.json + catalog.json）——它已经
 *      逐模型 ping 过并记录了 state/detail，本插件读文件即可，零额外请求；
 *      其余行在"深度测试"开启时才由本插件发最小 ping（maxTokens 极小）；
 *   3. 四色：绿=可用·免费 / 黄=可用·计费 / 灰=不可用·额度不足 / 红=不可用·
 *      无法连接（src/classify.js）；
 *   4. 持久化到 $DSH_HOME/model-probe/results.json，客户端经
 *      /api/model-probe/{summary,run} 读写（信任围栏同 OFM）。
 *
 * OFM 缺席（未安装/未探测）时全部降级为自带 ping + 目录措辞判定，插件照常工作。
 *
 * @module index.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyCost, classifyFailure, looksFreeLane } from './src/classify.js'
import { pingModel } from './src/ping.js'
import { rejectionFor } from './src/trust.js'

export const name = 'dsh-ofm-extension'
export const inject = ['llm', 'webServer']

const PKG = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const VERSION = String(PKG.version ?? '0.0.0')

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : path.join(os.homedir(), '.dsh')
}
const HOME = dshHome()
const DATA_DIR = path.join(HOME, 'model-probe')
const RESULTS_FILE = path.join(DATA_DIR, 'results.json')

/** OFM 的持久化目录；安装与否每次读取时现判，不缓存。 */
const OFM_DIR = path.join(HOME, 'our-free-model')

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(value, null, 2))
    fs.renameSync(temp, file)
    return true
  } catch {
    return false
  }
}

// ── OFM 复用层 ───────────────────────────────────────────────────────────────

/**
 * 把 OFM availability.json 的一行 verdict 折算成四色；不可用时的红/灰由
 * detail 措辞决定（throttled / limit / quota → 灰；unreachable / fetch failed
 * / 连接类 → 红；region-blocked 属"此出口不可达" → 红）。
 */
function ofmVerdictToColor(entry) {
  const state = String(entry?.state ?? '')
  const detail = String(entry?.detail ?? '')
  if (state === 'available') return { color: null }
  if (state === 'region-blocked') return { color: 'red', reason: detail || '此网络出口无法连接该模型（地区限制）' }
  if (state === 'unavailable') {
    const quotaish = /limit|quota|credit|balance|usage|不足|unavailable in your/i.test(detail)
    return { color: quotaish ? 'gray' : 'red', reason: detail || (quotaish ? '额度/用量受限' : '上游不再路由该模型') }
  }
  if (state === 'throttled') {
    const quotaish = /limit|quota|credit|usage|rate/i.test(detail)
    return { color: quotaish ? 'gray' : 'red', reason: detail || (quotaish ? '免费额度已用完' : '请求被限流') }
  }
  // unknown：OFM 明确"无法判定"。实测该态 detail 多为免费层准入/额度文案
  // （"free tier can only be used from within OpenCode"），先过通用额度/凭据
  // 分类器，分不出才按措辞兜底红。
  const parsed = classifyFailure({ code: '', message: detail })
  if (parsed.color === 'gray') return parsed
  if (/free tier|free usage|only be used from|subscribe|download it|不可用|无法使用/i.test(detail)) {
    return { color: 'gray', reason: detail || '免费层准入/额度受限' }
  }
  return parsed
}

/**
 * 读 OFM 的两份持久化文件。返回：
 *   verdicts   modelId -> {color, reason, probedAt, latencyMs, source:'ofm'}
 *   freeLane   Set<baseId>（免密车道行 → 免费候选）
 *   channels   modelId -> 'eac'|'kilo'|'aggregate'（共付/免费/自带你 key）
 *   catalogAt  目录探测时间
 */
function readOfmFacts() {
  const verdicts = new Map()
  const freeLane = new Set()
  const channels = new Map()
  const availability = readJsonSafe(path.join(OFM_DIR, 'availability.json'))
  const catalog = readJsonSafe(path.join(OFM_DIR, 'catalog.json'))
  for (const [id, row] of Object.entries(availability?.results ?? {})) {
    const folded = ofmVerdictToColor(row)
    verdicts.set(id, { ...folded, probedAt: Number(row?.at ?? 0) || 0, latencyMs: row?.latencyMs })
  }
  for (const id of catalog?.entries ?? []) freeLane.add(String(id))
  const rowChannel = row => {
    const ch = String(row?.channel ?? '')
    return ch === 'eac' || ch === 'kilo' || ch === 'aggregate' ? ch : null
  }
  for (const key of ['kiloRows', 'eacRows', 'aggregateRows', 'comboRows']) {
    for (const row of catalog?.[key] ?? []) {
      const ch = rowChannel(row)
      if (ch && row?.id) channels.set(String(row.id), ch)
    }
  }
  return { verdicts, freeLane, channels, catalogAt: Number(catalog?.at ?? 0) || 0, availabilityAt: Number(availability?.at ?? 0) || 0 }
}

// ── 目录层 ───────────────────────────────────────────────────────────────────

/** 宿主目录：每个注册 provider 的 listModels；provider 级失败也入矩阵（红）。 */
async function collectCatalog(ctx) {
  const rows = []
  const providerFailures = []
  let providers = []
  try {
    providers = ctx.llm.listProviders()
  } catch (error) {
    return { rows, providerFailures: [{ provider: '(all)', name: 'llm 服务', message: error?.message ?? String(error) }] }
  }
  for (const provider of providers) {
    let models = []
    try {
      models = await ctx.llm.listModels(provider.id)
    } catch (error) {
      providerFailures.push({ provider: provider.id, name: provider.name, message: error?.message ?? String(error) })
      continue
    }
    for (const model of models) {
      rows.push({
        key: `${provider.id}/${model.id}`,
        provider: provider.id,
        providerName: provider.name,
        model: model.id,
        name: model.name ?? model.id,
        description: model.description,
      })
    }
  }
  return { rows, providerFailures }
}

/**
 * 单行免费/计费判定：OFM 车道事实优先，其次目录措辞。
 * @param {object} row 目录行
 * @param {object} ofm readOfmFacts() 结果
 */
function costOf(row, ofm) {
  const isOfmRoute = row.provider === 'our-free-model' || row.provider === 'our-free-model-region'
  if (isOfmRoute) {
    const channel = ofm.channels.get(row.model)
    if (channel) return classifyCost(row, { channel, providerName: row.providerName })
    const facts = {
      ofmRoute: row.provider,
      ofmFreeLane: ofm.freeLane.has(row.model) || looksFreeLane(row),
      providerName: row.providerName,
    }
    return classifyCost(row, facts)
  }
  const channel = ofm.channels.get(row.model) ?? ofm.channels.get(row.key)
  if (channel) return classifyCost(row, { channel, hasUserKey: true, providerName: row.providerName })
  return classifyCost(row, { providerName: row.providerName })
}

// ── 运行编排 ─────────────────────────────────────────────────────────────────

const MAX_PARALLEL = 4
const PING_TIMEOUT_MS = 30_000

/** 并发受限的 map，保留顺序与结果对象。 */
async function bounded(items, limit, worker) {
  const out = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(lanes)
  return out
}

function createRunner(ctx, log) {
  /** 运行状态：idle | running；同刻只允许一轮。 */
  const runState = { phase: 'idle', startedAt: 0, done: 0, total: 0, abort: null }

  let results = readJsonSafe(RESULTS_FILE) ?? { version: 1, at: 0, settings: { deepTest: true, pingTimeoutMs: PING_TIMEOUT_MS }, rows: {}, providerFailures: [] }
  if (results.version !== 1) results = { version: 1, at: 0, settings: { deepTest: true, pingTimeoutMs: PING_TIMEOUT_MS }, rows: {}, providerFailures: [] }
  // 分类器升级迁移：旧版 \b免费\b 对 CJK 失效，把"· 免费"误落到默认计费。
  // 对 ping 成功且 costSource 非 OFM 来源的行，用新分类器重算颜色，
  // 无需重新 ping（ping 结论不变，只有 免费/计费 标签变了）。
  const CLASSIFY_VERSION = 2
  if ((results.settings.classifyVersion ?? 1) < CLASSIFY_VERSION) {
    for (const row of Object.values(results.rows)) {
      if (row.source === 'ping' && (row.color === 'green' || row.color === 'yellow')
        && !String(row.costSource ?? '').startsWith('ofm:')) {
        const cost = classifyCost(row, { providerName: row.providerName })
        row.color = cost.color
        row.costSource = cost.costSource
      }
    }
    results.settings.classifyVersion = CLASSIFY_VERSION
    writeJsonAtomic(RESULTS_FILE, results)
  }

  function persist() {
    results.settings.deepTestVersion = VERSION
    writeJsonAtomic(RESULTS_FILE, results)
  }

  async function run({ deep } = {}) {
    if (runState.phase === 'running') return { alreadyRunning: true }
    const deepTest = deep ?? results.settings.deepTest
    runState.phase = 'running'
    runState.startedAt = Date.now()
    runState.done = 0
    runState.abort = new AbortController()
    const ofm = readOfmFacts()
    const { rows, providerFailures } = await collectCatalog(ctx)
    runState.total = rows.length

    const nextRows = {}
    const tested = bounded(rows, MAX_PARALLEL, async row => {
      // 第一层：OFM 已对该模型 id 做过真实探测（availability.json）。
      const verdict = ofm.verdicts.get(row.model)
      const isOfmRoute = row.provider === 'our-free-model' || row.provider === 'our-free-model-region'
      if (verdict !== undefined) {
        if (verdict.color !== null) {
          // OFM 报不可用 → 直接采用红/灰，绝不重复花钱。
          row.color = verdict.color
          row.reason = verdict.reason
          row.costSource = 'ofm:verdict'
          row.probedAt = verdict.probedAt
          row.latencyMs = verdict.latencyMs
          row.source = 'ofm'
          runState.done += 1
          return row
        }
        if (isOfmRoute) {
          // OFM 报可用且本行就在 OFM 路由上 → 免费/计费由车道事实决定。
          const cost = costOf(row, ofm)
          row.color = cost.color
          row.costSource = cost.costSource
          row.reason = ''
          row.probedAt = verdict.probedAt
          row.latencyMs = verdict.latencyMs
          row.source = 'ofm'
          runState.done += 1
          return row
        }
      }
      // 第二层：自带 ping（仅深度测试开启；中止后不再发起新请求）。
      if (!deepTest || runState.abort.signal.aborted) {
        const prev = results.rows[row.key]
        if (prev && prev.source === 'ping' && prev.color) {
          // 快速读取继承上一轮 ping 结论（含免费/计费标签），不重发请求。
          row.color = prev.color
          row.reason = prev.reason ?? ''
          row.costSource = prev.costSource
          row.latencyMs = prev.latencyMs
          row.probedAt = prev.probedAt
          row.source = 'ping'
          row.inherited = true
        } else {
          row.color = null
          row.reason = deepTest ? '已中止，未测' : '未深度测试'
          row.source = 'catalog'
        }
        runState.done += 1
        return row
      }
      const ping = await pingModel(ctx, row.provider, row.model, results.settings.pingTimeoutMs)
      row.latencyMs = ping.latencyMs
      row.probedAt = Date.now()
      row.source = 'ping'
      if (ping.ok) {
        const cost = costOf(row, ofm)
        row.color = cost.color
        row.costSource = cost.costSource
        row.reason = ''
      } else {
        const failure = classifyFailure(ping)
        row.color = failure.color
        row.reason = failure.reason
      }
      runState.done += 1
      return row
    }).then(list => {
      for (const row of list) nextRows[row.key] = row
    })

    await tested
    const aborted = runState.abort.signal.aborted
    results.rows = { ...nextRows }
    // provider 级失败（listModels 抛错）→ 合成整组红行：连不上是路由级事实。
    for (const failure of providerFailures) {
      results.rows[`${failure.provider}/(provider)`] = {
        key: `${failure.provider}/(provider)`,
        provider: failure.provider,
        providerName: failure.name,
        model: '(整个路由)',
        name: `${failure.name} · 目录读取失败`,
        color: 'red',
        reason: failure.message,
        source: 'catalog',
        probedAt: Date.now(),
      }
    }
    results.providerFailures = providerFailures
    results.at = Date.now()
    results.catalogAt = ofm.catalogAt
    results.ofmAvailabilityAt = ofm.availabilityAt
    results.aborted = aborted
    if (aborted) results.partial = true
    runState.phase = 'idle'
    persist()
    return { ok: true, aborted, rows: Object.keys(results.rows).length, providerFailures }
  }

  function stop() {
    runState.abort?.abort()
    runState.phase = 'idle'
  }

  function summary() {
    const counts = { green: 0, yellow: 0, gray: 0, red: 0, unknown: 0 }
    for (const row of Object.values(results.rows)) {
      if (row.color === 'green') counts.green += 1
      else if (row.color === 'yellow') counts.yellow += 1
      else if (row.color === 'gray') counts.gray += 1
      else if (row.color === 'red') counts.red += 1
      else counts.unknown += 1
    }
    const ofmNow = readOfmFacts()
    return {
      version: VERSION,
      at: results.at,
      running: runState.phase === 'running',
      progress: { done: runState.done, total: runState.total },
      settings: results.settings,
      counts,
      rows: Object.values(results.rows),
      providerFailures: [
        ...results.providerFailures,
        // provider 级失败 → 该 provider 的行全标红（连不上是路由级事实）。
      ],
      ofm: {
        installed: ofmNow.catalogAt > 0 || ofmNow.availabilityAt > 0,
        availabilityAt: ofmNow.availabilityAt,
        verdicts: ofmNow.verdicts.size,
      },
      home: HOME,
    }
  }

  function saveSettings(patch) {
    if (typeof patch?.deepTest === 'boolean') results.settings.deepTest = patch.deepTest
    if (Number.isFinite(patch?.pingTimeoutMs) && patch.pingTimeoutMs >= 3000 && patch.pingTimeoutMs <= 180000) {
      results.settings.pingTimeoutMs = Math.trunc(patch.pingTimeoutMs)
    }
    persist()
    return results.settings
  }

  return { run, stop, summary, saveSettings, runState }
}

// ── HTTP 面 ──────────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req) {
  let data = ''
  for await (const chunk of req) data += chunk
  if (data === '') return {}
  try { return JSON.parse(data) } catch { return {} }
}

export function apply(ctx, config) {
  const log = message => ctx.logger?.withScope?.('model-probe')?.info?.(message) ?? ctx.logger?.info?.(`model-probe: ${message}`)
  const runner = createRunner(ctx, log)

  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  const webServer = ctx.get('webServer') ?? ctx.webServer

  const handler = async (req, res) => {
    const rejection = rejectionFor(req, typeof ctx.get === 'function' ? ctx.get('connection') : connection)
    if (rejection !== undefined) return sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.replace(/^\/api\/model-probe/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    try {
      if (method === 'GET' && route === '/summary') return sendJson(res, 200, runner.summary())
      if (method === 'POST' && route === '/run') {
        const body = await readBody(req)
        // background:true → 立即返回，进度经 /summary 轮询（客户端默认走这条）。
        if (body?.background !== false) {
          runner.run({ deep: typeof body?.deep === 'boolean' ? body.deep : undefined })
            .catch(error => log(`background run failed: ${error?.message ?? error}`))
          return sendJson(res, 202, { started: true })
        }
        const outcome = await runner.run({ deep: typeof body?.deep === 'boolean' ? body.deep : undefined })
        return sendJson(res, 200, outcome)
      }
      if (method === 'POST' && route === '/stop') {
        runner.stop()
        return sendJson(res, 200, { stopped: true })
      }
      if (method === 'POST' && route === '/settings') {
        const body = await readBody(req)
        return sendJson(res, 200, { settings: runner.saveSettings(body) })
      }
      return sendJson(res, 404, { error: `unknown route "${route}"` })
    } catch (error) {
      log(`route ${route} failed: ${error?.message ?? error}`)
      return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() => {
    if (webServer === undefined) {
      log('webServer 服务缺席，仅提供宿主内存结果（API 未挂载）')
      return () => {}
    }
    const dispose = webServer.register({ kind: 'prefix', path: '/api/model-probe', handler })
    return dispose
  })

  // 启动即做一轮轻量目录读取（不 ping），让矩阵先有行；深度补测只在结果
  // 过期（默认 6 小时）或完全没有 ping 结论时才跑——重启不该反复烧额度。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      runner.run({ deep: false }).then(() => {
        const s = runner.summary()
        if (!s.settings.deepTest || s.running) return undefined
        const staleMs = Number.isFinite(s.settings.autoRerunHours) ? s.settings.autoRerunHours * 3600_000 : 6 * 3600_000
        const hasPing = s.rows.some(row => row.source === 'ping')
        const fresh = s.at > 0 && Date.now() - s.at < staleMs
        if (hasPing && fresh) {
          log(`结果新鲜（${Math.round((Date.now() - s.at) / 60000)} 分钟前），跳过自动全量测试`)
          return undefined
        }
        return runner.run({ deep: true })
      }).catch(error => log(`auto run failed: ${error?.message ?? error}`))
    }, 6000)
    timer.unref?.()
    return () => clearTimeout(timer)
  })

  log(`已挂载 /api/model-probe（持久化：${RESULTS_FILE}）`)
  return { name: 'dsh-ofm-extension', summary: () => runner.summary(), run: options => runner.run(options) }
}

export const config = {}
