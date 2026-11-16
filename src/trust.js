/**
 * 请求信任围栏（与 dsh-our-free-model 的 src/trust.js 同语义的精简复刻）。
 *
 * 本插件的前缀路由比内核的 `/api` 更长，webServer 最长前缀优先，所以这些
 * 路由先于内核自身的准入检查执行——不围栏就等于对任何 loopback 调用方开门。
 * 两层：优先用组合挂载的 `connection` 服务的 admit/requestRejection（与内核
 * 对 `/api` 完全同一决定）；服务缺席时用结构性复刻（loopback host、
 * 跨站拒绝、Origin/Referer 与 Host 权威一致）。
 *
 * @module src/trust.js
 */

const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

function structuralReason(req) {
  const host = authorityOf(req.headers.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 'host-not-loopback'
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 'cross-site'
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const authority = authorityOf(raw.trim())
    if (authority === null) return `${header}-invalid`
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) return `${header}-mismatch`
  }
  return undefined
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {object|undefined} connection 宿主 connection 服务（可晚绑定）
 * @returns {number|undefined} 拒绝状态码，或 undefined 放行
 */
export function rejectionFor(req, connection) {
  let decision
  try {
    const admit = connection?.admit
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req)
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined
      if (status === undefined) return undefined
      decision = status
    } else {
      const reject = connection?.requestRejection
      if (typeof reject === 'function') {
        const status = reject.call(connection, req)
        if (status === undefined) return undefined
        decision = status
      }
    }
  } catch {
    return 503
  }
  if (decision !== undefined) return decision
  return structuralReason(req) === undefined ? undefined : 403
}
