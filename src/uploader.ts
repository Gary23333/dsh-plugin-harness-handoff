import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 会话事件上报。
 *
 * - 按会话缓冲已提交事件，回合结束（turn/end）或缓冲满时上报；序号出现缺口（DSH 续接时会跳号）就拆成多个批次，
 *   每个批次序号连续，与平台契约一致。
 * - 上报失败的批次写入本地暂存目录（文件权限 0600），下次运行先补报；采集超过七天的批次停止上报并删除。
 * - 平台按 `device + session + end_seq` 去重，重复补报安全。
 * - 只上报对摘要有用的内容：系统提示词、请求头等大块内容只保留类型与序号。
 */

export interface ProbeEvent {
  seq: number
  type: string
  at: string
  data: Record<string, unknown>
}

export interface Batch {
  session_id: string
  start_seq: number
  end_seq: number
  captured_at: string
  content_sha256: string
  events: ProbeEvent[]
  client: { plugin_version: string; dsh_version: string }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>

export const RETENTION_MS = 7 * 24 * 3600_000
const MAX_BUFFER = 200
/** 只保留类型与序号的事件：内容大且与交接无关。 */
const STRIP_DATA = new Set(['system/message', 'request/header', 'request/context', 'developer/message', 'session/title-llm-request'])

export function eventPayload(type: string, data: unknown): Record<string, unknown> {
  if (STRIP_DATA.has(type) || !data || typeof data !== 'object') return {}
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>
}

export function toBatches(sessionId: string, events: ProbeEvent[], client: Batch['client']): Batch[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const groups: ProbeEvent[][] = []
  for (const event of sorted) {
    const last = groups.at(-1)
    if (last && last.at(-1)!.seq + 1 === event.seq) last.push(event)
    else if (!last || last.at(-1)!.seq !== event.seq) groups.push([event])
  }
  return groups.map((group) => ({
    session_id: sessionId,
    start_seq: group[0]!.seq,
    end_seq: group.at(-1)!.seq,
    captured_at: group[0]!.at,
    content_sha256: createHash('sha256').update(JSON.stringify(group)).digest('hex'),
    events: group,
    client,
  }))
}

export interface UploaderOptions {
  platformBaseUrl: string
  token: () => Promise<string | undefined>
  spoolDir: string
  client: Batch['client']
  fetch: FetchLike
  log?: (message: string) => void
  now?: () => number
}

export class Uploader {
  private readonly buffers = new Map<string, ProbeEvent[]>()
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly options: UploaderOptions) {}

  record(sessionId: string, event: ProbeEvent): void {
    const buffer = this.buffers.get(sessionId) ?? []
    buffer.push(event)
    this.buffers.set(sessionId, buffer)
    if (event.type === 'turn/end' || buffer.length >= MAX_BUFFER) void this.flush(sessionId)
  }

  /**
   * 先同步写入暂存目录再异步上传：DSH headless 在任务结束后立即退出，来不及完成的上传下次运行补报。
   * 同一进程内串行上传，保证序号顺序。
   */
  flush(sessionId?: string): Promise<void> {
    const ids = sessionId ? [sessionId] : [...this.buffers.keys()]
    const pending: Array<{ batch: Batch; path: string | null }> = []
    for (const id of ids) {
      const events = this.buffers.get(id) ?? []
      this.buffers.set(id, [])
      for (const batch of toBatches(id, events, this.options.client)) pending.push({ batch, path: this.spool(batch) })
    }
    this.chain = this.chain.then(async () => {
      for (const item of pending) await this.send(item.batch, item.path)
    })
    return this.chain
  }

  /** 补报暂存目录里的批次；超过七天的直接删除。 */
  drainSpool(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (!existsSync(this.options.spoolDir)) return
      for (const name of readdirSync(this.options.spoolDir).filter((n) => n.endsWith('.json')).sort()) {
        const path = join(this.options.spoolDir, name)
        try {
          await this.send(JSON.parse(readFileSync(path, 'utf8')) as Batch, path)
        } catch {
          rmSync(path, { force: true })
        }
      }
    })
    return this.chain
  }

  private expired(batch: Batch): boolean {
    const now = this.options.now?.() ?? Date.now()
    return now - Date.parse(batch.captured_at) >= RETENTION_MS
  }

  private spool(batch: Batch): string | null {
    if (this.expired(batch)) return null
    mkdirSync(this.options.spoolDir, { recursive: true, mode: 0o700 })
    const file = join(this.options.spoolDir, `${Date.parse(batch.captured_at)}-${batch.session_id}-${batch.end_seq}.json`)
    writeFileSync(file, JSON.stringify(batch), { mode: 0o600 })
    chmodSync(file, 0o600)
    return file
  }

  private async send(batch: Batch, path: string | null): Promise<void> {
    const done = () => {
      if (path) rmSync(path, { force: true })
    }
    if (this.expired(batch)) return done()
    const token = await this.options.token()
    if (!token) return // 留在暂存目录，下次补报
    try {
      const response = await this.options.fetch(`${this.options.platformBaseUrl}/ingest/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(15_000),
      })
      // 201 新接收、200 重复、409 冲突（以平台为准）、410 已到期、400 不合法：都不再重试。
      if ([200, 201, 400, 409, 410].includes(response.status)) {
        if (response.status >= 400) this.options.log?.(`事件批次 ${batch.start_seq}-${batch.end_seq} 被平台拒绝（${response.status}）`)
        done()
      }
    } catch {
      // 网络失败：留在暂存目录
    }
  }
}
