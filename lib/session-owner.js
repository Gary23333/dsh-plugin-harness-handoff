import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * 同一 `DSH_HOME` 下不同 profile 共用 `sessions/`：成员在 A profile 打开 B profile 的会话时，
 * `session/event` 会在 A 的进程里触发。插件必须只上报"自己创建的会话"，否则会把 B 的对话
 * 以 A 的身份上传（2026-11-17 排练实测）。
 *
 * 做法：会话第一次被某个 profile 看到时，在机器级目录里用 `wx` 独占创建一个归属标记；
 * 先到者就是创建者，后来的 profile 只读标记、不采集、不上报。标记不依赖 DSH 会话格式，
 * 也不修改 DSH 的数据。
 *
 * 目录：`$DSH_HOME/harness-team/session-owners/<会话号>.json`（0600）。
 * 标记损坏或不可读时按"未知归属"处理，宁可不传，也不冒用他人身份。
 */
const SESSION_ID = /^session-[0-9a-f-]{36}$/;
export function sessionOwnerDir(dshHome) {
    return join(dshHome, 'harness-team', 'session-owners');
}
export function sessionOwnerPath(dshHome, sessionId) {
    if (!SESSION_ID.test(sessionId))
        return null;
    return join(sessionOwnerDir(dshHome), `${sessionId}.json`);
}
/** 读取已有归属标记；不存在或损坏返回 undefined。 */
export function readSessionOwner(dshHome, sessionId) {
    const path = sessionOwnerPath(dshHome, sessionId);
    if (!path)
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed.version === 1 && typeof parsed.profile === 'string' && parsed.profile.length > 0 && typeof parsed.first_seen_at === 'string') {
            return { version: 1, profile: parsed.profile, first_seen_at: parsed.first_seen_at };
        }
    }
    catch {
        // 不存在或损坏：交给调用方决定。
    }
    return undefined;
}
/**
 * 认领会话归属。第一次调用创建标记并返回 claimed=true；之后返回已有 owner。
 * 会话号不合法时返回 null（调用方按"无法判断"处理）。
 * 文件系统错误向上抛，由调用方记录并降级。
 */
export function claimSession(options) {
    const path = sessionOwnerPath(options.dshHome, options.sessionId);
    if (!path)
        return null;
    const dir = sessionOwnerDir(options.dshHome);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = {
        version: 1,
        profile: options.profile,
        first_seen_at: (options.now ?? new Date()).toISOString(),
    };
    try {
        writeFileSync(path, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
        return { owner: options.profile, claimed: true };
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const existing = readSessionOwner(options.dshHome, options.sessionId);
    if (existing)
        return { owner: existing.profile, claimed: false };
    // 文件存在但内容不可读：返回 unknown，调用方跳过上报。
    return { owner: 'unknown', claimed: false };
}
/** 测试与排障用：删除一个会话的归属标记。 */
export function clearSessionOwner(dshHome, sessionId) {
    const path = sessionOwnerPath(dshHome, sessionId);
    if (path)
        rmSync(path, { force: true });
}
//# sourceMappingURL=session-owner.js.map