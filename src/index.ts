import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { noteSession, persistenceProbe, purgeLocalSessions, type OwnershipProbe, type SessionPersistenceLike } from './local-retention.js'
import { claimSession } from './session-owner.js'
import { Uploader, eventPayload, type FetchLike } from './uploader.js'

/**
 * DSH 事项交接插件（二期 P2-03 客户端、P2-05 首轮注入）。实测版本 DSH 0.2.2-rc.3。
 *
 * - `session/event`：采集已提交事件，按批次上报平台（见 uploader.ts）。
 * - `agent/pre-step`：先 `next()`（让 harness-auth 等到令牌就绪），再在两秒内向平台匹配事项，
 *   命中则把接续摘要作为一条消息追加进本步输入。超时或失败时本次任务直接以用户输入继续。
 * - 注入消息的来源必须是生产方自有的 kind：DSH 0.2.x（会话格式 v4）拒绝 `kind: 'plugin'`。
 * - 本地留存：采集过的会话记入台账，从首次采集起满七天删除 DSH 本地日志与投影缓存（见 local-retention.ts）。
 * - profile 隔离：同一 `DSH_HOME` 下不同 profile 共用 `sessions/` 与暂存目录；本插件只采集首次看到该会话的
 *   profile 产生的事件，暂存按 profile 前缀隔离，避免 A 以自己身份上传 B 的会话（见 session-owner.ts）。
 *
 * 不依赖任何 DSH 包导入，类型只描述实际用到的最小子集。
 */

export const PLUGIN_VERSION = '0.2.2'
export const SOURCE_KIND = 'harness-handoff'
/**
 * 首轮等待 /matters/resolve 的上限。服务端自身 1.7 秒内必返回，但跨境网络单次往返（含 TLS 建连）实测
 * 1.8–4.2 秒（2026-11-17 新电脑排练），2 秒客户端上限会把已经匹配成功的结果丢掉。
 */
const FIRST_TURN_WAIT_MS = 5000
const PURGE_INTERVAL_MS = 3600_000
const PURGE_DELAY_MS = 60_000

type CredentialRef = string & { readonly __brand?: 'CredentialRef' }

interface UserMessage {
  id?: string
  role?: string
  content?: unknown
  source?: unknown
  [key: string]: unknown
}

type Decision = { kind: 'enter'; messages: UserMessage[]; [key: string]: unknown } | { kind: 'reject' }

interface PreStepPayload {
  agent?: unknown
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

interface SessionEventLike {
  type?: string
  seq?: number
  data?: unknown
}

export interface HandoffContext {
  credentials: { resolve(ref: CredentialRef): Promise<{ value: string } | undefined> }
  effect?: (execute: () => void | (() => void)) => unknown
  on(event: 'session/event', listener: (session: { id?: string } | null, event: SessionEventLike) => void): unknown
  on(event: 'agent/pre-step', listener: (payload: PreStepPayload, next: () => Promise<Decision>) => Promise<Decision>): unknown
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  /** Cordis：读取启动器提供的 profile 信息（不需要声明 inject，读不到时回退）。 */
  get?: (name: string) => unknown
  /** Cordis：服务可用时运行回调（这里用来拿 sessionPersistence 探测会话占用）。 */
  inject?: (deps: string[], callback: (ctx: { sessionPersistence?: SessionPersistenceLike }) => void) => unknown
}

export interface HandoffConfig {
  /** 平台根地址；缺省读 HARNESS_PLATFORM_URL。 */
  platformBaseUrl?: string
  /** 访问令牌的凭证引用，与 harness-auth 的 apiKeyEnv 一致。 */
  apiKeyEnv?: string
  /** 当前 DSH profile 名；缺省从 profileContext 读取，读不到时回退 default。 */
  profile?: string
  /** 暂存目录，默认 $DSH_HOME/harness-team/<profile>/handoff-spool。 */
  spoolDir?: string
  /** 首轮匹配是否启用，默认 true。 */
  inject?: boolean
  /** DSH 本地会话副本七天清理，默认 true。 */
  localRetention?: boolean
  /** 首轮等待事项匹配的毫秒数，默认 5000（含网络往返；服务端自身 1.7 秒内返回）。 */
  firstTurnWaitMs?: number
}

export interface HandoffDeps {
  fetch?: FetchLike
  dshVersion?: string
  now?: () => number
  /** 覆盖 DSH_HOME（测试用）；缺省读环境变量或 ~/.dsh。 */
  dshHome?: string
  /** 首次本地清理的最长等待（默认一分钟；第一轮对话结束会提前开始）。 */
  purgeDelayMs?: number
}

/** profile 名用于目录名：只保留安全字符，避免拼出任意路径。 */
function profileSegment(profile: string): string {
  const safe = profile.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return safe || 'default'
}

/** profile 名优先取启动器上下文；再退回 launcher 写入的 user-agent 后缀。 */
function resolveProfile(ctx: HandoffContext, config: HandoffConfig): string {
  const configured = config.profile?.trim()
  if (configured) return configured
  const fromContext = (ctx.get?.('profileContext') as { name?: unknown } | undefined)?.name
  if (typeof fromContext === 'string' && fromContext.trim()) return fromContext.trim()
  const suffix = process.env.DSH_USER_AGENT_SUFFIX
  if (suffix?.startsWith('dsh-profile/')) {
    try {
      const decoded = decodeURIComponent(suffix.slice('dsh-profile/'.length))
      if (decoded) return decoded
    } catch {
      // 后缀被改动：按未知 profile 处理。
    }
  }
  return 'default'
}

function textOf(messages: UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    const content = message.content
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content)) {
      for (const item of content) if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') parts.push((item as { text: string }).text)
    }
  }
  return parts.join('\n').slice(0, 8000)
}

export function applyHandoff(ctx: HandoffContext, config: HandoffConfig = {}, deps: HandoffDeps = {}): Uploader | undefined {
  const say = (m: string) => ctx.logger?.info?.(`[harness-handoff] ${m}`)
  const platformBaseUrl = (config.platformBaseUrl ?? process.env.HARNESS_PLATFORM_URL)?.replace(/\/$/, '')
  if (!platformBaseUrl) {
    ctx.logger?.warn?.('[harness-handoff] 未配置 platformBaseUrl，交接插件不工作')
    return undefined
  }
  const ref = (config.apiKeyEnv ?? 'HARNESS_PLATFORM_TOKEN') as CredentialRef
  const token = async () => (await ctx.credentials.resolve(ref).catch(() => undefined))?.value
  const doFetch: FetchLike = deps.fetch ?? (async (url, init) => fetch(url, init))
  const dshHome = deps.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profile = resolveProfile(ctx, config)
  const profilePath = profileSegment(profile)
  // 默认每个 profile 独立暂存目录；显式配置共用目录时，文件名仍带 profile 前缀，补报只处理自己的批次。
  const uploader = new Uploader({
    platformBaseUrl,
    token,
    spoolDir: config.spoolDir ?? join(dshHome, 'harness-team', profilePath, 'handoff-spool'),
    spoolPrefix: profilePath,
    client: { plugin_version: PLUGIN_VERSION, dsh_version: deps.dshVersion ?? process.env.DSH_VERSION ?? 'unknown' },
    fetch: doFetch,
    log: say,
  })

  const retention = config.localRetention !== false
  const ledgerPath = join(dshHome, 'harness-team', 'handoff-ledger.json')
  const seen = new Set<string>()
  let startPurge: () => void = () => undefined
  let currentSession: string | undefined

  /**
   * 会话归属：同一 DSH_HOME 下所有 profile 共用 sessions/，打开别人的会话也会触发 session/event。
   * 首次看到会话的 profile 用独占标记认领；其他 profile 一律不采集、不注入、不记留存台账。
   */
  const ownership = new Map<string, boolean>()
  const ownsSession = (id: string): boolean => {
    const cached = ownership.get(id)
    if (cached !== undefined) return cached
    let ok = true
    try {
      const claim = claimSession({ dshHome, sessionId: id, profile, now: new Date(deps.now?.() ?? Date.now()) })
      if (claim) {
        ok = claim.owner === profile
        if (!ok) {
          ctx.logger?.warn?.(`[harness-handoff] 会话 ${id} 属于 profile ${claim.owner}，本 profile（${profile}）不采集、不上报`)
        }
      }
    } catch (error) {
      // 归属标记写不了：不阻断当前会话，服务端还有跨成员归属校验兜底。
      ctx.logger?.warn?.(`[harness-handoff] 会话归属标记失败：${(error as Error).message}`)
    }
    ownership.set(id, ok)
    return ok
  }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (!id || typeof event.seq !== 'number' || !event.type) return
    if (!ownsSession(id)) return
    currentSession = id
    if (retention && !seen.has(id)) {
      seen.add(id)
      try {
        noteSession(ledgerPath, id, new Date(deps.now?.() ?? Date.now()))
      } catch {
        // 台账写入失败不影响对话；该会话只是不会被本地清理
      }
    }
    if (event.type === 'turn/end') startPurge()
    // 键序 seq、type、at、data 与平台契约一致（散列按原始 JSON 计算）。
    uploader.record(id, { seq: event.seq, type: event.type, at: new Date().toISOString(), data: eventPayload(event.type, event.data) })
  })

  const injected = new Set<string>()
  if (config.inject !== false) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter' || payload.signal.aborted) return decision
      const sessionId = (payload.agent as { session?: { id?: string } } | undefined)?.session?.id ?? currentSession
      // 每个会话在本进程只做一次首轮匹配（续接的新进程会再做一次）。
      if (!sessionId || injected.has(sessionId)) return decision
      // 不是本 profile 创建的会话：不注入接续内容，避免把别人的事项带进当前会话。
      if (!ownsSession(sessionId)) return decision
      injected.add(sessionId)
      const input = textOf(payload.messages)
      const accessToken = await token()
      if (!input || !accessToken) return decision
      try {
        const response = await doFetch(`${platformBaseUrl}/matters/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ session_id: sessionId, input_text: input }),
          signal: AbortSignal.any([payload.signal, AbortSignal.timeout(config.firstTurnWaitMs ?? FIRST_TURN_WAIT_MS)]),
        })
        if (response.status !== 200) return decision
        const body = (await response.json()) as { outcome?: string; context?: { text?: string } | null }
        const text = body.context?.text
        if (body.outcome !== 'matched' || !text) return decision
        say('已接续事项上下文')
        const message: UserMessage = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text }] },
        }
        return { ...decision, messages: [...decision.messages, message] }
      } catch {
        // 超时或平台不可用：以用户输入继续，迟到结果不再使用。
        return decision
      }
    })
  }

  ctx.effect?.(() => {
    void uploader.drainSpool()
    return () => {
      void uploader.flush()
    }
  })
  if (!ctx.effect) void uploader.drainSpool()

  if (retention) {
    // 清理不在启动时立刻做：续接（--session-id）的会话在 DSH 打开前没有写锁，可能被误判空闲。
    // 等第一轮对话结束（当前会话已持锁并记入 seen）或启动一分钟后再开始，之后每小时一次。
    let probe: OwnershipProbe | undefined
    let probeReady = !ctx.inject
    let started = false
    let timer: ReturnType<typeof setInterval> | undefined
    const purge = () =>
      purgeLocalSessions({ dshHome, ledgerPath, probe, skip: new Set(seen), now: deps.now })
        .then((r) => {
          if (r.purged.length) say(`已删除 ${r.purged.length} 个满七天的本地会话副本`)
        })
        .catch((error: unknown) => ctx.logger?.warn?.(`[harness-handoff] 本地留存清理失败：${(error as Error).message}`))
    startPurge = () => {
      if (started || !probeReady) return
      started = true
      void purge()
      timer = setInterval(() => void purge(), PURGE_INTERVAL_MS)
      timer.unref?.()
    }
    const delay = setTimeout(() => startPurge(), deps.purgeDelayMs ?? PURGE_DELAY_MS)
    delay.unref?.()
    if (ctx.inject) {
      // 只在 sessionPersistence 可用时清理：用它的单写者锁确认会话没有被任何进程使用。
      ctx.inject(['sessionPersistence'], (sub) => {
        if (!sub.sessionPersistence) return
        probe = persistenceProbe(sub.sessionPersistence)
        probeReady = true
      })
    }
    ctx.effect?.(() => () => {
      clearTimeout(delay)
      if (timer) clearInterval(timer)
    })
  }
  return uploader
}

export default {
  name: '@harness/dsh-plugin-handoff',
  inject: ['credentials'],
  apply(ctx: HandoffContext, config?: HandoffConfig): void {
    applyHandoff(ctx, config ?? {})
  },
}

export { Uploader, toBatches, eventPayload } from './uploader.js'
export { purgeLocalSessions, noteSession, readLedger, localCopies } from './local-retention.js'
export { claimSession, readSessionOwner, sessionOwnerDir, sessionOwnerPath, clearSessionOwner } from './session-owner.js'
