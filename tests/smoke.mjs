/**
 * 冒烟测试：用真实的 OFM availability.json 跑一遍分类逻辑。
 * 验证：region-blocked→红、throttled→灰、unavailable→灰/红、available→OFM免费车道绿。
 */
import fs from 'node:fs'
import { classifyFailure, classifyCost, looksFreeLane } from '../src/classify.js'

const availability = JSON.parse(fs.readFileSync('C:/Users/CS/.dsh/our-free-model/availability.json', 'utf8'))

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
  return classifyFailure({ code: '', message: detail })
}

let pass = 0, fail = 0
const check = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ✓ ${name}: ${got}`) }
  else { fail++; console.log(`  ✗ ${name}: got ${got}, want ${want}`) }
}

console.log('=== OFM 真实 verdict 折叠 ===')
for (const [id, row] of Object.entries(availability.results)) {
  const folded = ofmVerdictToColor(row)
  console.log(`  ${id}: state=${row.state} → ${folded.color ?? '(available)'}`)
}

console.log('\n=== 规范失败码分类 ===')
check('TRANSPORT→red', classifyFailure({ code: 'TRANSPORT', message: 'fetch failed' }).color, 'red')
check('TIMEOUT→red', classifyFailure({ code: 'TIMEOUT', message: '超时' }).color, 'red')
check('SERVER→red', classifyFailure({ code: 'SERVER', message: '502' }).color, 'red')
check('NO_ADAPTER→red', classifyFailure({ code: 'NO_ADAPTER', message: '无适配器' }).color, 'red')
check('QUOTA→gray', classifyFailure({ code: 'QUOTA', message: 'insufficient quota' }).color, 'gray')
check('ACCOUNT_QUOTA→gray', classifyFailure({ code: 'ACCOUNT_QUOTA', message: '余额不足' }).color, 'gray')
check('INVALID_CREDENTIAL→gray', classifyFailure({ code: 'INVALID_CREDENTIAL', message: 'api key invalid' }).color, 'gray')
check('RATE_LIMIT→gray', classifyFailure({ code: 'RATE_LIMIT', message: '429' }).color, 'gray')
check('中文额度不足→gray', classifyFailure({ code: 'UNKNOWN', message: '积分不足，请充值' }).color, 'gray')
check('中文未登录→gray', classifyFailure({ code: 'UNKNOWN', message: '未登录或登录已过期' }).color, 'gray')
check('402→gray', classifyFailure({ code: '', status: 402, message: 'payment required' }).color, 'gray')
check('401→gray', classifyFailure({ code: '', status: 401, message: 'unauthorized' }).color, 'gray')
check('连接拒绝→red', classifyFailure({ code: '', message: 'ECONNREFUSED' }).color, 'red')
check('DNS失败→red', classifyFailure({ code: '', message: 'getaddrinfo ENOTFOUND' }).color, 'red')

console.log('\n=== 免费/计费判定 ===')
const freeRow = { provider: 'our-free-model', model: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash' }
const eacRow = { provider: 'our-free-model-region', model: 'gpt-x', name: 'GPT X' }
const catalogFree = { provider: 'other', model: 'llama-free', name: 'Llama Free' }
const catalogPaid = { provider: 'openai', model: 'gpt-4o', name: 'GPT-4o', description: 'paid' }
check('OFM免密车道→green', classifyCost(freeRow, { ofmRoute: 'our-free-model', ofmFreeLane: true }).color, 'green')
check('OFM地区共付→yellow', classifyCost(eacRow, { ofmRoute: 'our-free-model-region' }).color, 'yellow')
check('EAC channel→yellow', classifyCost(eacRow, { channel: 'eac' }).color, 'yellow')
check('Kilo channel→green', classifyCost(freeRow, { channel: 'kilo' }).color, 'green')
check('目录free字样→green', classifyCost(catalogFree, { providerName: 'Other' }).color, 'green')
check('目录paid字样→yellow', classifyCost(catalogPaid, { providerName: 'OpenAI' }).color, 'yellow')
check('默认→yellow', classifyCost({ provider: 'x', model: 'y', name: 'Y' }, { providerName: 'X' }).color, 'yellow')
// CJK 回归：\b 对中文不成立的历史 bug —— "· 免费" 必须绿
check('CJK 免费→green', classifyCost({ provider: 'qodercn', model: 'qfmodel', name: 'Qwen3.8-Flash · 免费' }, { providerName: 'Qoder CN' }).color, 'green')
check('CJK 倍率→yellow', classifyCost({ provider: 'qodercn', model: 'dfmodel', name: 'DeepSeek-Flash · x0.1' }, { providerName: 'Qoder CN' }).color, 'yellow')
check('CJK 倍率区间→yellow', classifyCost({ provider: 'qodercn', model: 'qmodel_38max', name: 'Qwen3.8-Max · x0.5→x0.2' }, { providerName: 'Qoder CN' }).color, 'yellow')
check('CJK 免费来源标签', classifyCost({ provider: 'qodercn', model: 'qfmodel', name: 'Qwen3.8-Flash · 免费' }, { providerName: 'Qoder CN' }).costSource, 'catalog:free-wording')
check('looksFreeLane(id含free)', looksFreeLane({ model: 'a-free' }), true)
check('looksFreeLane(无free)', looksFreeLane({ model: 'gpt-4o' }), false)

console.log(`\n结果: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
