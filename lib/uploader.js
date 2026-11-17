import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const RETENTION_MS = 7 * 24 * 3600_000;
const MAX_BUFFER = 200;
/** 只保留类型与序号的事件：内容大且与交接无关。 */
const STRIP_DATA = new Set(['system/message', 'request/header', 'request/context', 'developer/message', 'session/title-llm-request']);
export function eventPayload(type, data) {
    if (STRIP_DATA.has(type) || !data || typeof data !== 'object')
        return {};
    return JSON.parse(JSON.stringify(data));
}
export function toBatches(sessionId, events, client) {
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    const groups = [];
    for (const event of sorted) {
        const last = groups.at(-1);
        if (last && last.at(-1).seq + 1 === event.seq)
            last.push(event);
        else if (!last || last.at(-1).seq !== event.seq)
            groups.push([event]);
    }
    return groups.map((group) => ({
        session_id: sessionId,
        start_seq: group[0].seq,
        end_seq: group.at(-1).seq,
        captured_at: group[0].at,
        content_sha256: createHash('sha256').update(JSON.stringify(group)).digest('hex'),
        events: group,
        client,
    }));
}
export class Uploader {
    options;
    buffers = new Map();
    chain = Promise.resolve();
    constructor(options) {
        this.options = options;
    }
    record(sessionId, event) {
        const buffer = this.buffers.get(sessionId) ?? [];
        buffer.push(event);
        this.buffers.set(sessionId, buffer);
        if (event.type === 'turn/end' || buffer.length >= MAX_BUFFER)
            void this.flush(sessionId);
    }
    /**
     * 先同步写入暂存目录再异步上传：DSH headless 在任务结束后立即退出，来不及完成的上传下次运行补报。
     * 同一进程内串行上传，保证序号顺序。
     */
    flush(sessionId) {
        const ids = sessionId ? [sessionId] : [...this.buffers.keys()];
        const pending = [];
        for (const id of ids) {
            const events = this.buffers.get(id) ?? [];
            this.buffers.set(id, []);
            for (const batch of toBatches(id, events, this.options.client))
                pending.push({ batch, path: this.spool(batch) });
        }
        this.chain = this.chain.then(async () => {
            for (const item of pending)
                await this.send(item.batch, item.path);
        });
        return this.chain;
    }
    /** 补报暂存目录里的批次；超过七天的直接删除。 */
    drainSpool() {
        this.chain = this.chain.then(async () => {
            if (!existsSync(this.options.spoolDir))
                return;
            for (const name of readdirSync(this.options.spoolDir).filter((n) => n.endsWith('.json')).sort()) {
                const path = join(this.options.spoolDir, name);
                try {
                    await this.send(JSON.parse(readFileSync(path, 'utf8')), path);
                }
                catch {
                    rmSync(path, { force: true });
                }
            }
        });
        return this.chain;
    }
    expired(batch) {
        const now = this.options.now?.() ?? Date.now();
        return now - Date.parse(batch.captured_at) >= RETENTION_MS;
    }
    spool(batch) {
        if (this.expired(batch))
            return null;
        mkdirSync(this.options.spoolDir, { recursive: true, mode: 0o700 });
        const file = join(this.options.spoolDir, `${Date.parse(batch.captured_at)}-${batch.session_id}-${batch.end_seq}.json`);
        writeFileSync(file, JSON.stringify(batch), { mode: 0o600 });
        chmodSync(file, 0o600);
        return file;
    }
    async send(batch, path) {
        const done = () => {
            if (path)
                rmSync(path, { force: true });
        };
        if (this.expired(batch))
            return done();
        const token = await this.options.token();
        if (!token)
            return; // 留在暂存目录，下次补报
        try {
            const response = await this.options.fetch(`${this.options.platformBaseUrl}/ingest/sessions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify(batch),
                signal: AbortSignal.timeout(15_000),
            });
            // 201 新接收、200 重复、409 冲突（以平台为准）、410 已到期、400 不合法：都不再重试。
            if ([200, 201, 400, 409, 410].includes(response.status)) {
                if (response.status >= 400)
                    this.options.log?.(`事件批次 ${batch.start_seq}-${batch.end_seq} 被平台拒绝（${response.status}）`);
                done();
            }
        }
        catch {
            // 网络失败：留在暂存目录
        }
    }
}
//# sourceMappingURL=uploader.js.map