/**
 * 判定与取数：四色分类 + Our Free Model 复用。
 *
 * 颜色语义（与 UI 一致）：
 *   green   可用 · 免费      —— ping 成功且该路由不计费
 *   yellow  可用 · 计费      —— ping 成功且计费（token/积分消耗）
 *   gray    不可用 · 额度    —— QUOTA / ACCOUNT_QUOTA / INVALID_CREDENTIAL /
 *                              额度类措辞（积分或费用不足、未登录、未配 key）
 *   red     不可用 · 连不上  —— TRANSPORT / TIMEOUT / SERVER / DNS / 连接拒绝
 *
 * 判定优先级（每一层都比下一层更省、更准）：
 *   1. OFM /summary：route 命中 our-free-model / -region 的行直接采用它的
 *      availability verdict（它已经真实 ping 过，且 detail 带 gateway 语义）；
 *   2. OFM /pool + 目录 channel 字段：EAC 共付车道 → 计费（yellow 家族），
 *      kilo/免费车道 → 免费；
 *   3. 宿主目录元数据（model.description / name 里的 free 字样）；
 *   4. 本插件自己的 ping（唯一花钱的一层，默认关，"深度测试"才开）。
 *
 * @module src/classify.js
 */

/** 宿主 llm 规范失败码 → 红/灰。其余码按 message 措辞兜底。 */
const RED_CODES = new Set([
  'TRANSPORT', 'TIMEOUT', 'SERVER', 'NO_ADAPTER', 'ABORTED',
])
const GRAY_CODES = new Set([
  'QUOTA', 'ACCOUNT_QUOTA', 'INVALID_CREDENTIAL', 'RATE_LIMIT',
])

/** 额度/计费类措辞（宿主 isQuotaExceededError 的超集，补充国内网关文案）。 */
const QUOTA_PHRASE = new RegExp([
  String.raw`\binsufficient[\s_-]+(?:quota|balance|credits?|fund)\b`,
  String.raw`\b(?:quota|usage[\s_-]+limit|credit)[\s_-]+(?:exceeded|exhausted|depleted|reached)\b`,
  String.raw`\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b`,
  String.raw`\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b`,
  String.raw`\bout[\s_-]+of[\s_-]+(?:credits?|budget|quota)\b`,
  String.raw`余额不足|额度不足|积分不足|欠费|超出配额|配额用尽|用尽积分|无可用额度`,
  String.raw`(?:billing|payment)[\s_-]+(?:required|enabled|setup)`,
].join('|'), 'i')

/** 未配置凭据类措辞：归灰（属于"账户/额度侧"而非链路侧）。 */
const CRED_PHRASE = new RegExp([
  String.raw`\b(?:missing|invalid|expired|not[\s_-]set)[\s_-]+(?:api[\s_-]+key|credential|token)\b`,
  String.raw`\b(?:key|token)[\s_-]+(?:required|invalid|expired)\b`,
  String.raw`\bunauthorized\b|\bforbidden\b|未登录|请先登录|登录已过期|未配置.{0,6}(?:key|密钥|api)`,
].join('|'), 'i')

/** 免费字样（目录元数据兜底）。
 *  注意：\b 是 ASCII 词边界，对 CJK 字符永远不成立（"· 免费" 里 \b免费\b
 *  匹配不到），所以中文词必须裸匹配；英文 free 保留边界以免误伤
 *  "freestyle" 之类。 */
const FREE_PHRASE = /(?:^|[\s\-_:/])free(?:$|[\s\-_:/])|免费|零成本|:free$/i

/** 计费字样（目录元数据兜底，弱于"无 free 字样即计费"的默认）。CJK 同理裸匹配。 */
const PAID_PHRASE = /\b(?:paid|billing|per[\s_-]token|priced)\b|按量计费|计费|收费|消耗积分/i

/** 积分倍率字样：`· x0.1`、`· x0.5→x0.2` —— 带倍率即按倍率消耗积分（计费）。 */
const MULTIPLIER_PHRASE = /[x×]\s*\d?(?:\.\d+)?\s*(?:→|->)?\s*[x×]?\s*0?\.\d+/i

/**
 * 一次 ping 的结论 → 四色。
 * @param {{ok:boolean, code?:string, message?:string, status?:number}} result
 * @returns {{color:'red'|'gray', reason:string}}
 */
export function classifyFailure(result) {
  const code = String(result?.code ?? '')
  const detail = `${code} ${result?.message ?? ''}`
  if (QUOTA_PHRASE.test(detail)) return { color: 'gray', reason: result?.message || '额度/积分不足' }
  if (CRED_PHRASE.test(detail)) return { color: 'gray', reason: result?.message || '凭据未配置或已失效' }
  if (GRAY_CODES.has(code)) return { color: 'gray', reason: result?.message || '额度/凭据受限' }
  if (RED_CODES.has(code)) return { color: 'red', reason: result?.message || '无法连接' }
  const status = Number(result?.status ?? 0)
  if (status >= 400 && status < 500 && (status === 401 || status === 403)) return { color: 'gray', reason: result?.message || `HTTP ${status}（访问受限）` }
  if (status === 402) return { color: 'gray', reason: result?.message || '需要付费/额度' }
  if (status >= 400) return { color: 'red', reason: result?.message || `HTTP ${status}` }
  return { color: 'red', reason: result?.message || '未知连接错误' }
}

/**
 * ping 成功时的 免费/计费 判定，按上面的优先级逐层降级。
 * @param {object} model - 目录行 {provider, model, name, description}
 * @param {object} facts - {ofmRoute, ofmFreeLane, channel, providerName}
 * @returns {{color:'green'|'yellow', costSource:string}}
 */
export function classifyCost(model, facts = {}) {
  if (facts.ofmRoute === 'our-free-model') {
    const freeLane = facts.ofmFreeLane !== false
    return freeLane
      ? { color: 'green', costSource: 'ofm:free-lane' }
      : { color: 'yellow', costSource: 'ofm:lane' }
  }
  if (facts.ofmRoute === 'our-free-model-region') return { color: 'yellow', costSource: 'ofm:region-co-paid' }
  const channel = String(facts.channel ?? '')
  if (channel === 'eac') return { color: 'yellow', costSource: 'ofm:eac-co-paid' }
  if (channel === 'kilo') return { color: 'green', costSource: 'ofm:kilo-free' }
  if (channel === 'aggregate') {
    const userKeys = facts.hasUserKey === true
    return userKeys
      ? { color: 'yellow', costSource: 'ofm:aggregate-key' }
      : { color: 'yellow', costSource: 'ofm:aggregate' }
  }
  const text = `${model?.name ?? ''} ${model?.description ?? ''}`
  if (FREE_PHRASE.test(text)) return { color: 'green', costSource: 'catalog:free-wording' }
  if (MULTIPLIER_PHRASE.test(text)) return { color: 'yellow', costSource: 'catalog:multiplier' }
  if (PAID_PHRASE.test(text)) return { color: 'yellow', costSource: 'catalog:paid-wording' }
  const provider = `${facts.providerName ?? ''} ${model?.provider ?? ''}`
  if (FREE_PHRASE.test(provider)) return { color: 'green', costSource: 'catalog:provider-free' }
  return { color: 'yellow', costSource: 'default:assumed-paid' }
}

/** 目录行是否看起来属于 OFM 免费车道（id/文案兜底，用于宿主目录不带 channel 时）。 */
export function looksFreeLane(model) {
  const id = String(model?.model ?? model?.id ?? '')
  const text = `${id} ${model?.name ?? ''} ${model?.description ?? ''}`
  return /(?:^|[-_:.])free(?:$|[-_.:])/.test(id) || FREE_PHRASE.test(text)
}
