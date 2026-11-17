import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { applyHandoff, SOURCE_KIND } from './index.js'
import { RETENTION_MS, Uploader, toBatches, type Batch, type FetchLike } from './uploader.js'

const client = { plugin_version: '0.1.0', dsh_version: '0.2.2-rc.3' }
const at = new Date().toISOString()
const ev = (seq: number, type = 'user/message') => ({ seq, type, data: {}, at })

function fakeFetch(status: number | (() => number)) {
  const calls: Array<{ url: string; body: Batch }> = []
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body ?? '{}') })
    const code = typeof status === 'function' ? status() : status
    return { status: code, json: async () => ({}) }
  }
  return { fn, calls }
}

describe('事件批次', () => {
  it('序号缺口拆成多个连续批次，重复序号去掉', () => {
    const batches = toBatches('s', [ev(0), ev(1), ev(1), ev(3), ev(4)], client)
    expect(batches.map((b) => [b.start_seq, b.end_seq])).toEqual([[0, 1], [3, 4]])
    expect(batches[0]!.events).toHaveLength(2)
    expect(batches[0]!.content_sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('上报与暂存', () => {
  it('回合结束触发上报，成功后暂存文件删除', async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), 'handoff-'))
    const f = fakeFetch(201)
    const up = new Uploader({ platformBaseUrl: 'http://p', token: async () => 't', spoolDir, client, fetch: f.fn })
    up.record('s', ev(0))
    up.record('s', ev(1, 'turn/end'))
    await up.flush()
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe('http://p/ingest/sessions')
    expect(readdirSync(spoolDir)).toHaveLength(0)
  })

  it('网络失败与没有令牌时保留暂存文件（0600），下次补报', async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), 'handoff-'))
    let fail = true
    const f = fakeFetch(() => (fail ? 503 : 201))
    const up = new Uploader({ platformBaseUrl: 'http://p', token: async () => 't', spoolDir, client, fetch: f.fn })
    up.record('s', ev(0, 'turn/end'))
    await up.flush()
    const files = readdirSync(spoolDir)
    expect(files).toHaveLength(1)
    expect(statSync(join(spoolDir, files[0]!)).mode & 0o777).toBe(0o600)
    fail = false
    await new Uploader({ platformBaseUrl: 'http://p', token: async () => 't', spoolDir, client, fetch: f.fn }).drainSpool()
    expect(readdirSync(spoolDir)).toHaveLength(0)
  })

  it('采集超过七天的批次不再上报并删除', async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), 'handoff-'))
    const f = fakeFetch(503)
    const up = new Uploader({ platformBaseUrl: 'http://p', token: async () => 't', spoolDir, client, fetch: f.fn })
    up.record('s', ev(0, 'turn/end'))
    await up.flush()
    expect(readdirSync(spoolDir)).toHaveLength(1)
    const later = new Uploader({ platformBaseUrl: 'http://p', token: async () => 't', spoolDir, client, fetch: f.fn, now: () => Date.now() + RETENTION_MS + 1 })
    await later.drainSpool()
    expect(readdirSync(spoolDir)).toHaveLength(0)
    expect(f.calls).toHaveLength(1) // 只有第一次失败的那次
  })
})

describe('首轮注入', () => {
  function harness(fetchImpl: FetchLike) {
    const listeners: Record<string, (...args: any[]) => any> = {}
    const ctx = {
      credentials: { resolve: async () => ({ value: 'tok' }) },
      on: (name: string, fn: (...args: any[]) => any) => {
        listeners[name] = fn
      },
    }
    applyHandoff(ctx as never, { platformBaseUrl: 'http://p', spoolDir: mkdtempSync(join(tmpdir(), 'h-')), localRetention: false }, { fetch: fetchImpl })
    return listeners
  }
  const payload = () => ({
    agent: { session: { id: 'sess-1' } },
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续昨天的周报' }] }],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  })
  const next = async () => ({ kind: 'enter' as const, messages: [{ role: 'user', content: [] }] })

  it('命中事项时追加一条生产方自有来源的消息，同一会话只注入一次', async () => {
    const l = harness(async () => ({ status: 200, json: async () => ({ outcome: 'matched', context: { text: '【事项接续】周报' } }) }))
    const d = await l['agent/pre-step']!(payload(), next)
    expect(d.messages).toHaveLength(2)
    expect(d.messages[1].source.kind).toBe(SOURCE_KIND)
    expect(d.messages[1].source.kind).not.toBe('plugin')
    const again = await l['agent/pre-step']!(payload(), next)
    expect(again.messages).toHaveLength(1)
  })

  it('平台超时或失败时照常进入，不阻塞任务', async () => {
    const l = harness(async (_u, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timeout')))))
    const started = Date.now()
    const d = await l['agent/pre-step']!(payload(), next)
    expect(d.messages).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

it('暂存目录不存在时补报为空操作', async () => {
  const up = new Uploader({ platformBaseUrl: 'http://p', token: async () => 't', spoolDir: join(tmpdir(), 'nope-handoff-xyz'), client, fetch: fakeFetch(201).fn })
  await up.drainSpool()
  expect(existsSync(join(tmpdir(), 'nope-handoff-xyz'))).toBe(false)
})
