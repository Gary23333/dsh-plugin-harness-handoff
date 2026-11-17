import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { RETENTION_MS } from './uploader.js'

/**
 * DSH 本地会话副本的七天留存（P2-08 客户端部分，DSH 0.2.2-rc.3 实测布局）。
 *
 * DSH 把每个会话在本机存两份，都含原文：
 *   - 事件日志 `$DSH_HOME/sessions/<工作目录名>/<会话号>/`（session.v4.jsonl.zstd、session.lock）；
 *   - 投影缓存 `$DSH_HOME/storages/session_projcache/sessions/<uuid>.json`。
 * `sessions/` 由同一 DSH_HOME 下的所有 profile 共用，成员个人 profile 的会话也在里面，
 * 所以只清理本插件采集过的会话：首次采集时记入台账，从首次采集起满七天整目录删除。
 *
 * 正在被任何进程写的会话不删（DSH 用内核锁保证单写者，可通过 `sessionPersistence.open(id, 'write')` 探测），
 * 下一轮再试。DSH 没有删除接口，删除即移除这两处文件；删除后该会话不能再用 `--session-id` 续接，
 * 隔日接续由平台摘要提供。
 */

export interface LedgerEntry {
  first_captured_at: string
}

export interface Ledger {
  version: 1
  sessions: Record<string, LedgerEntry>
}

export type OwnershipProbe = (sessionId: string) => Promise<'free' | 'owned' | 'missing'>

export interface PurgeOptions {
  dshHome: string
  ledgerPath: string
  now?: () => number
  /** 返回 owned 时跳过；缺省视为 free。 */
  probe?: OwnershipProbe
  /** 额外跳过的会话（本进程当前会话）。 */
  skip?: ReadonlySet<string>
}

export interface PurgeResult {
  purged: string[]
  skipped_owned: string[]
  remaining: number
}

const emptyLedger = (): Ledger => ({ version: 1, sessions: {} })

export function readLedger(path: string): Ledger {
  if (!existsSync(path)) return emptyLedger()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Ledger>
    if (parsed && typeof parsed.sessions === 'object' && parsed.sessions) return { version: 1, sessions: parsed.sessions }
  } catch {
    // 台账损坏：从空台账开始（只会少删、不会误删）。
  }
  return emptyLedger()
}

/** 原子写入（先写临时文件再改名），权限 0600。 */
export function writeLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

/** 首次见到某会话时记录采集时间；已记录的不改（续接不会延长留存期）。返回是否新增。 */
export function noteSession(path: string, sessionId: string, at: Date): boolean {
  const ledger = readLedger(path)
  if (ledger.sessions[sessionId]) return false
  ledger.sessions[sessionId] = { first_captured_at: at.toISOString() }
  writeLedger(path, ledger)
  return true
}

/** 会话号只能是 DSH 生成的形式，避免台账被篡改后拼出任意路径。 */
const SESSION_ID = /^session-[0-9a-f-]{36}$/

/** 该会话在本机的全部副本路径。 */
export function localCopies(dshHome: string, sessionId: string): string[] {
  if (!SESSION_ID.test(sessionId)) return []
  const paths: string[] = []
  const root = join(dshHome, 'sessions')
  if (existsSync(root)) {
    for (const slug of readdirSync(root)) {
      const dir = join(root, slug, sessionId)
      if (existsSync(dir)) paths.push(dir)
    }
  }
  const cache = join(dshHome, 'storages', 'session_projcache', 'sessions')
  for (const name of [`${sessionId}.json`, `${sessionId.slice('session-'.length)}.json`]) {
    const file = join(cache, name)
    if (existsSync(file)) paths.push(file)
  }
  return paths
}

export async function purgeLocalSessions(options: PurgeOptions): Promise<PurgeResult> {
  const now = options.now?.() ?? Date.now()
  const ledger = readLedger(options.ledgerPath)
  const purged: string[] = []
  const skippedOwned: string[] = []
  let changed = false
  for (const [sessionId, entry] of Object.entries(ledger.sessions)) {
    const captured = Date.parse(entry.first_captured_at)
    if (!Number.isFinite(captured)) {
      delete ledger.sessions[sessionId]
      changed = true
      continue
    }
    if (now - captured < RETENTION_MS) continue
    if (options.skip?.has(sessionId)) {
      skippedOwned.push(sessionId)
      continue
    }
    const state = options.probe ? await options.probe(sessionId).catch(() => 'owned' as const) : 'free'
    if (state === 'owned') {
      skippedOwned.push(sessionId)
      continue
    }
    for (const path of localCopies(options.dshHome, sessionId)) rmSync(path, { recursive: true, force: true })
    delete ledger.sessions[sessionId]
    purged.push(sessionId)
    changed = true
  }
  if (changed) writeLedger(options.ledgerPath, ledger)
  return { purged, skipped_owned: skippedOwned, remaining: Object.keys(ledger.sessions).length }
}

/** DSH sessionPersistence 的最小子集：用写入所有权探测会话是否正被使用。 */
export interface SessionPersistenceLike {
  open(id: string, access: 'read' | 'write'): Promise<{ close(): Promise<void> | void }>
}

export function persistenceProbe(persistence: SessionPersistenceLike): OwnershipProbe {
  return async (sessionId) => {
    try {
      const handle = await persistence.open(sessionId, 'write')
      await handle.close()
      return 'free'
    } catch (error) {
      const name = (error as { name?: string } | null)?.name ?? ''
      if (name === 'SessionPersistenceNotFoundError') return 'missing'
      // 被占用（SessionAlreadyOwnedError）或无法判断：都不删，下一轮再试。
      return 'owned'
    }
  }
}
