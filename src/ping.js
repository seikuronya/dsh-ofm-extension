/**
 * 单次测活 ping：走宿主 llm.stream 的正规路由，取最小请求。
 *
 * 结论形态：
 *   { ok:true,  latencyMs, ttftMs }
 *   { ok:false, latencyMs, code, message, status }
 * 失败既可能以 throw 出现（适配器建立流即失败），也可能藏在流内
 * finish 的 {kind:'error', failure} 终止块里——两条路径都要接住，
 * 否则"能在流里报 429 配额"的模型会被误判成可用（OFM probe 同教训）。
 *
 * @module src/ping.js
 */

/** 一条能产生完整回包的极小请求。 */
const PING_TEXT = 'ping'

/**
 * @param {object} ctx - Cordis 上下文（需已 inject 'llm'）
 * @param {string} provider
 * @param {string} model
 * @param {number} timeoutMs
 */
export async function pingModel(ctx, provider, model, timeoutMs = 45_000) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let failure = undefined
  let firstDelta = undefined
  try {
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: PING_TEXT }] }],
      maxTokens: 16,
      signal: controller.signal,
    })) {
      if (firstDelta === undefined && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'block-start')) {
        firstDelta = Date.now()
      }
      if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') {
          const f = chunk.reason.failure ?? {}
          failure = {
            code: typeof f.code === 'string' ? f.code : (kind === 'aborted' ? 'ABORTED' : 'UNKNOWN'),
            message: typeof f.message === 'string' ? f.message : String(kind),
            status: typeof f.status === 'number' ? f.status : undefined,
          }
        }
        break
      }
    }
    if (failure === undefined) {
      return { ok: true, latencyMs: Date.now() - started, ttftMs: firstDelta === undefined ? undefined : firstDelta - started }
    }
    return { ok: false, ...failure, latencyMs: Date.now() - started }
  } catch (error) {
    if (failure !== undefined) return { ok: false, ...failure, latencyMs: Date.now() - started }
    const aborted = controller.signal.aborted
    return {
      ok: false,
      latencyMs: Date.now() - started,
      code: aborted ? 'TIMEOUT' : (typeof error?.code === 'string' ? error.code : 'UNKNOWN'),
      message: aborted ? `超过 ${Math.round(timeoutMs / 1000)}s 无响应` : (error instanceof Error ? error.message : String(error)),
      status: typeof error?.status === 'number' ? error.status : undefined,
    }
  } finally {
    clearTimeout(timer)
  }
}
