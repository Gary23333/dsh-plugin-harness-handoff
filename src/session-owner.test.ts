import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { claimSession, clearSessionOwner, readSessionOwner, sessionOwnerPath } from './session-owner.js'

const sid = 'session-11111111-aaaa-4bbb-8ccc-dddddddddddd'

describe('同机会话归属', () => {
  it('第一个 profile 独占认领，第二个 profile 只能读到归属', () => {
    const home = mkdtempSync(join(tmpdir(), 'handoff-owner-'))
    const first = claimSession({ dshHome: home, sessionId: sid, profile: 'harness-a', now: new Date(1000) })
    expect(first).toEqual({ owner: 'harness-a', claimed: true })
    const second = claimSession({ dshHome: home, sessionId: sid, profile: 'harness-b' })
    expect(second).toEqual({ owner: 'harness-a', claimed: false })
    expect(readSessionOwner(home, sid)).toMatchObject({ profile: 'harness-a', first_seen_at: new Date(1000).toISOString() })
    const path = sessionOwnerPath(home, sid)!
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('非法会话号不拼路径；标记损坏按未知归属处理', () => {
    const home = mkdtempSync(join(tmpdir(), 'handoff-owner-'))
    expect(claimSession({ dshHome: home, sessionId: '../etc/passwd', profile: 'harness-a' })).toBeNull()
    expect(sessionOwnerPath(home, '../etc/passwd')).toBeNull()
    const valid = claimSession({ dshHome: home, sessionId: sid, profile: 'harness-a' })!
    expect(valid.claimed).toBe(true)
    const path = sessionOwnerPath(home, sid)!
    // 模拟半写入/人为破坏。
    writeFileSync(path, '{not json')
    expect(claimSession({ dshHome: home, sessionId: sid, profile: 'harness-b' })).toEqual({ owner: 'unknown', claimed: false })
    clearSessionOwner(home, sid)
    expect(readSessionOwner(home, sid)).toBeUndefined()
  })
})
