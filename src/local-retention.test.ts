import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { applyHandoff } from './index.js'
import { localCopies, noteSession, persistenceProbe, purgeLocalSessions, readLedger, writeLedger } from './local-retention.js'
import { RETENTION_MS } from './uploader.js'

const DAY = 24 * 3600_000
const sid = (n: number) => `session-0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`

/** 按 DSH 0.2.2-rc.3 的实际布局造一个会话的两处本地副本。 */
function fakeSession(home: string, id: string, slug = '--Users-me-work--') {
  const dir = join(home, 'sessions', slug, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'raw')
  writeFileSync(join(dir, 'session.lock'), '')
  const cache = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, `${id.slice('session-'.length)}.json`), '{"title":"原文"}')
  return dir
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'handoff-retention-'))
  return { home, ledger: join(home, 'harness-team', 'handoff-ledger.json') }
}

describe('DSH 本地会话副本七天清理', () => {
  it('台账只记首次采集时间，权限 0600', () => {
    const { ledger } = setup()
    expect(noteSession(ledger, sid(1), new Date(1000))).toBe(true)
    expect(noteSession(ledger, sid(1), new Date(9000))).toBe(false)
    expect(readLedger(ledger).sessions[sid(1)]!.first_captured_at).toBe(new Date(1000).toISOString())
    expect(statSync(ledger).mode & 0o777).toBe(0o600)
  })

  it('只删除台账里满七天的会话，日志目录与投影缓存都删；未满七天与非本插件会话保留', async () => {
    const { home, ledger } = setup()
    const now = Date.now()
    const old = fakeSession(home, sid(1))
    const fresh = fakeSession(home, sid(2), '--other-cwd--')
    const personal = fakeSession(home, sid(3))
    noteSession(ledger, sid(1), new Date(now - RETENTION_MS - 1))
    noteSession(ledger, sid(2), new Date(now - 6 * DAY))

    const result = await purgeLocalSessions({ dshHome: home, ledgerPath: ledger, now: () => now })
    expect(result.purged).toEqual([sid(1)])
    expect(existsSync(old)).toBe(false)
    expect(localCopies(home, sid(1))).toEqual([])
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(personal)).toBe(true)
    expect(localCopies(home, sid(3))).toHaveLength(2)
    expect(Object.keys(readLedger(ledger).sessions)).toEqual([sid(2)])
  })

  it('七天边界：差 1 毫秒不删，到点即删', async () => {
    const { home, ledger } = setup()
    const captured = Date.now() - 10 * DAY
    fakeSession(home, sid(1))
    noteSession(ledger, sid(1), new Date(captured))
    expect((await purgeLocalSessions({ dshHome: home, ledgerPath: ledger, now: () => captured + RETENTION_MS - 1 })).purged).toEqual([])
    expect((await purgeLocalSessions({ dshHome: home, ledgerPath: ledger, now: () => captured + RETENTION_MS })).purged).toEqual([sid(1)])
  })

  it('正被使用的会话跳过、留在台账里下次再试；当前会话也跳过', async () => {
    const { home, ledger } = setup()
    const now = Date.now()
    const a = fakeSession(home, sid(1))
    const b = fakeSession(home, sid(2))
    noteSession(ledger, sid(1), new Date(now - 8 * DAY))
    noteSession(ledger, sid(2), new Date(now - 8 * DAY))
    const owned = Object.assign(new Error('owned'), { name: 'SessionAlreadyOwnedError' })
    const probe = persistenceProbe({
      open: async (id) => {
        if (id === sid(1)) throw owned
        return { close: () => undefined }
      },
    })
    const first = await purgeLocalSessions({ dshHome: home, ledgerPath: ledger, now: () => now, probe, skip: new Set([sid(2)]) })
    expect(first.purged).toEqual([])
    expect(first.skipped_owned.sort()).toEqual([sid(1), sid(2)])
    expect(existsSync(a) && existsSync(b)).toBe(true)
    const second = await purgeLocalSessions({ dshHome: home, ledgerPath: ledger, now: () => now, probe: async () => 'free' })
    expect(second.purged.sort()).toEqual([sid(1), sid(2)])
  })

  it('台账里不合法的会话号不会拼出任意路径', async () => {
    const { home, ledger } = setup()
    const victim = join(home, 'keep')
    mkdirSync(victim)
    writeLedger(ledger, { version: 1, sessions: { '../keep': { first_captured_at: new Date(0).toISOString() } } })
    await purgeLocalSessions({ dshHome: home, ledgerPath: ledger })
    expect(existsSync(victim)).toBe(true)
  })

  it('插件采集事件时记台账，启动时清理满七天的会话', async () => {
    const { home } = setup()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const ledger = join(home, 'harness-team', 'handoff-ledger.json')
      const stale = fakeSession(home, sid(9))
      noteSession(ledger, sid(9), new Date(Date.now() - 9 * DAY))
      const handlers: Record<string, (...args: unknown[]) => unknown> = {}
      applyHandoff(
        {
          credentials: { resolve: async () => undefined },
          on: ((event: string, listener: (...args: unknown[]) => unknown) => {
            handlers[event] = listener
          }) as never,
        },
        { platformBaseUrl: 'http://127.0.0.1:1', inject: false },
        { fetch: async () => ({ status: 503, json: async () => ({}) }), purgeDelayMs: 0 },
      )
      await new Promise((r) => setTimeout(r, 20))
      expect(existsSync(stale)).toBe(false)
      handlers['session/event']!({ id: sid(5) }, { seq: 0, type: 'user/message', data: {} })
      expect(readLedger(ledger).sessions[sid(5)]).toBeDefined()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
