import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { noteSession, persistenceProbe, purgeLocalSessions } from './local-retention.js';
import { Uploader, eventPayload } from './uploader.js';
/**
 * DSH 事项交接插件（二期 P2-03 客户端、P2-05 首轮注入）。实测版本 DSH 0.2.2-rc.3。
 *
 * - `session/event`：采集已提交事件，按批次上报平台（见 uploader.ts）。
 * - `agent/pre-step`：先 `next()`（让 harness-auth 等到令牌就绪），再在两秒内向平台匹配事项，
 *   命中则把接续摘要作为一条消息追加进本步输入。超时或失败时本次任务直接以用户输入继续。
 * - 注入消息的来源必须是生产方自有的 kind：DSH 0.2.x（会话格式 v4）拒绝 `kind: 'plugin'`。
 * - 本地留存：采集过的会话记入台账，从首次采集起满七天删除 DSH 本地日志与投影缓存（见 local-retention.ts）。
 *
 * 不依赖任何 DSH 包导入，类型只描述实际用到的最小子集。
 */
export const PLUGIN_VERSION = '0.2.0';
export const SOURCE_KIND = 'harness-handoff';
const FIRST_TURN_WAIT_MS = 2000;
const PURGE_INTERVAL_MS = 3600_000;
const PURGE_DELAY_MS = 60_000;
function textOf(messages) {
    const parts = [];
    for (const message of messages) {
        const content = message.content;
        if (typeof content === 'string')
            parts.push(content);
        else if (Array.isArray(content)) {
            for (const item of content)
                if (item && typeof item === 'object' && typeof item.text === 'string')
                    parts.push(item.text);
        }
    }
    return parts.join('\n').slice(0, 8000);
}
export function applyHandoff(ctx, config = {}, deps = {}) {
    const say = (m) => ctx.logger?.info?.(`[harness-handoff] ${m}`);
    const platformBaseUrl = (config.platformBaseUrl ?? process.env.HARNESS_PLATFORM_URL)?.replace(/\/$/, '');
    if (!platformBaseUrl) {
        ctx.logger?.warn?.('[harness-handoff] 未配置 platformBaseUrl，交接插件不工作');
        return undefined;
    }
    const ref = (config.apiKeyEnv ?? 'HARNESS_PLATFORM_TOKEN');
    const token = async () => (await ctx.credentials.resolve(ref).catch(() => undefined))?.value;
    const doFetch = deps.fetch ?? (async (url, init) => fetch(url, init));
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const uploader = new Uploader({
        platformBaseUrl,
        token,
        spoolDir: config.spoolDir ?? join(dshHome, 'harness-team', 'handoff-spool'),
        client: { plugin_version: PLUGIN_VERSION, dsh_version: deps.dshVersion ?? process.env.DSH_VERSION ?? 'unknown' },
        fetch: doFetch,
        log: say,
    });
    const retention = config.localRetention !== false;
    const ledgerPath = join(dshHome, 'harness-team', 'handoff-ledger.json');
    const seen = new Set();
    let startPurge = () => undefined;
    let currentSession;
    ctx.on('session/event', (session, event) => {
        const id = session?.id;
        if (!id || typeof event.seq !== 'number' || !event.type)
            return;
        currentSession = id;
        if (retention && !seen.has(id)) {
            seen.add(id);
            try {
                noteSession(ledgerPath, id, new Date(deps.now?.() ?? Date.now()));
            }
            catch {
                // 台账写入失败不影响对话；该会话只是不会被本地清理
            }
        }
        if (event.type === 'turn/end')
            startPurge();
        // 键序 seq、type、at、data 与平台契约一致（散列按原始 JSON 计算）。
        uploader.record(id, { seq: event.seq, type: event.type, at: new Date().toISOString(), data: eventPayload(event.type, event.data) });
    });
    const injected = new Set();
    if (config.inject !== false) {
        ctx.on('agent/pre-step', async (payload, next) => {
            const decision = await next();
            if (decision.kind !== 'enter' || payload.signal.aborted)
                return decision;
            const sessionId = payload.agent?.session?.id ?? currentSession;
            // 每个会话在本进程只做一次首轮匹配（续接的新进程会再做一次）。
            if (!sessionId || injected.has(sessionId))
                return decision;
            injected.add(sessionId);
            const input = textOf(payload.messages);
            const accessToken = await token();
            if (!input || !accessToken)
                return decision;
            try {
                const response = await doFetch(`${platformBaseUrl}/matters/resolve`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
                    body: JSON.stringify({ session_id: sessionId, input_text: input }),
                    signal: AbortSignal.any([payload.signal, AbortSignal.timeout(FIRST_TURN_WAIT_MS)]),
                });
                if (response.status !== 200)
                    return decision;
                const body = (await response.json());
                const text = body.context?.text;
                if (body.outcome !== 'matched' || !text)
                    return decision;
                say('已接续事项上下文');
                const message = {
                    id: randomUUID(),
                    role: 'user',
                    content: [{ type: 'text', text }],
                    source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text }] },
                };
                return { ...decision, messages: [...decision.messages, message] };
            }
            catch {
                // 超时或平台不可用：以用户输入继续，迟到结果不再使用。
                return decision;
            }
        });
    }
    ctx.effect?.(() => {
        void uploader.drainSpool();
        return () => {
            void uploader.flush();
        };
    });
    if (!ctx.effect)
        void uploader.drainSpool();
    if (retention) {
        // 清理不在启动时立刻做：续接（--session-id）的会话在 DSH 打开前没有写锁，可能被误判空闲。
        // 等第一轮对话结束（当前会话已持锁并记入 seen）或启动一分钟后再开始，之后每小时一次。
        let probe;
        let probeReady = !ctx.inject;
        let started = false;
        let timer;
        const purge = () => purgeLocalSessions({ dshHome, ledgerPath, probe, skip: new Set(seen), now: deps.now })
            .then((r) => {
            if (r.purged.length)
                say(`已删除 ${r.purged.length} 个满七天的本地会话副本`);
        })
            .catch((error) => ctx.logger?.warn?.(`[harness-handoff] 本地留存清理失败：${error.message}`));
        startPurge = () => {
            if (started || !probeReady)
                return;
            started = true;
            void purge();
            timer = setInterval(() => void purge(), PURGE_INTERVAL_MS);
            timer.unref?.();
        };
        const delay = setTimeout(() => startPurge(), deps.purgeDelayMs ?? PURGE_DELAY_MS);
        delay.unref?.();
        if (ctx.inject) {
            // 只在 sessionPersistence 可用时清理：用它的单写者锁确认会话没有被任何进程使用。
            ctx.inject(['sessionPersistence'], (sub) => {
                if (!sub.sessionPersistence)
                    return;
                probe = persistenceProbe(sub.sessionPersistence);
                probeReady = true;
            });
        }
        ctx.effect?.(() => () => {
            clearTimeout(delay);
            if (timer)
                clearInterval(timer);
        });
    }
    return uploader;
}
export default {
    name: '@harness/dsh-plugin-handoff',
    inject: ['credentials'],
    apply(ctx, config) {
        applyHandoff(ctx, config ?? {});
    },
};
export { Uploader, toBatches, eventPayload } from './uploader.js';
export { purgeLocalSessions, noteSession, readLedger, localCopies } from './local-retention.js';
//# sourceMappingURL=index.js.map