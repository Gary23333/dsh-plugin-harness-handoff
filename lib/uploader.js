import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    /** 补报暂存目录里本 profile 的批次；超过七天的（含其他 profile/旧版本留下的）直接删除。 */
    drainSpool() {
        this.chain = this.chain.then(async () => {
            if (!existsSync(this.options.spoolDir))
                return;
            const prefix = this.options.spoolPrefix ? `${this.options.spoolPrefix}--` : '';
            let foreign = 0;
            for (const name of readdirSync(this.options.spoolDir).filter((n) => n.endsWith('.json')).sort()) {
                const path = join(this.options.spoolDir, name);
                if (prefix && !name.startsWith(prefix)) {
                    // 旧版本（文件名不带前缀）或另一个 profile 的批次：本进程没有资格用它人的令牌补报。
                    // 不读内容、不上报；只按文件时间执行七天留存。
                    foreign += 1;
                    this.expireAbandoned(path);
                    continue;
                }
                try {
                    await this.send(JSON.parse(readFileSync(path, 'utf8')), path);
                }
                catch {
                    rmSync(path, { force: true });
                }
            }
            if (foreign > 0) {
                this.options.log?.(`暂存目录有 ${foreign} 个其他 profile 或旧版本的批次，本 profile 不补报`);
            }
        });
        return this.chain;
    }
    /** 不属于本 profile 的批次：超过七天按留存删除，未满七天留给对应进程或人工处理。 */
    expireAbandoned(path) {
        try {
            const now = this.options.now?.() ?? Date.now();
            if (now - statSync(path).mtimeMs >= RETENTION_MS)
                rmSync(path, { force: true });
        }
        catch {
            // 文件刚被另一个进程删除：忽略。
        }
    }
    expired(batch) {
        const now = this.options.now?.() ?? Date.now();
        return now - Date.parse(batch.captured_at) >= RETENTION_MS;
    }
    spool(batch) {
        if (this.expired(batch))
            return null;
        mkdirSync(this.options.spoolDir, { recursive: true, mode: 0o700 });
        const prefix = this.options.spoolPrefix ? `${this.options.spoolPrefix}--` : '';
        const file = join(this.options.spoolDir, `${prefix}${Date.parse(batch.captured_at)}-${batch.session_id}-${batch.end_seq}.json`);
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