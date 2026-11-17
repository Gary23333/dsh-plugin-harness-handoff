import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RETENTION_MS } from './uploader.js';
const emptyLedger = () => ({ version: 1, sessions: {} });
export function readLedger(path) {
    if (!existsSync(path))
        return emptyLedger();
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed && typeof parsed.sessions === 'object' && parsed.sessions)
            return { version: 1, sessions: parsed.sessions };
    }
    catch {
        // 台账损坏：从空台账开始（只会少删、不会误删）。
    }
    return emptyLedger();
}
/** 原子写入（先写临时文件再改名），权限 0600。 */
export function writeLedger(path, ledger) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
}
/** 首次见到某会话时记录采集时间；已记录的不改（续接不会延长留存期）。返回是否新增。 */
export function noteSession(path, sessionId, at) {
    const ledger = readLedger(path);
    if (ledger.sessions[sessionId])
        return false;
    ledger.sessions[sessionId] = { first_captured_at: at.toISOString() };
    writeLedger(path, ledger);
    return true;
}
/** 会话号只能是 DSH 生成的形式，避免台账被篡改后拼出任意路径。 */
const SESSION_ID = /^session-[0-9a-f-]{36}$/;
/** 该会话在本机的全部副本路径。 */
export function localCopies(dshHome, sessionId) {
    if (!SESSION_ID.test(sessionId))
        return [];
    const paths = [];
    const root = join(dshHome, 'sessions');
    if (existsSync(root)) {
        for (const slug of readdirSync(root)) {
            const dir = join(root, slug, sessionId);
            if (existsSync(dir))
                paths.push(dir);
        }
    }
    const cache = join(dshHome, 'storages', 'session_projcache', 'sessions');
    for (const name of [`${sessionId}.json`, `${sessionId.slice('session-'.length)}.json`]) {
        const file = join(cache, name);
        if (existsSync(file))
            paths.push(file);
    }
    return paths;
}
export async function purgeLocalSessions(options) {
    const now = options.now?.() ?? Date.now();
    const ledger = readLedger(options.ledgerPath);
    const purged = [];
    const skippedOwned = [];
    let changed = false;
    for (const [sessionId, entry] of Object.entries(ledger.sessions)) {
        const captured = Date.parse(entry.first_captured_at);
        if (!Number.isFinite(captured)) {
            delete ledger.sessions[sessionId];
            changed = true;
            continue;
        }
        if (now - captured < RETENTION_MS)
            continue;
        if (options.skip?.has(sessionId)) {
            skippedOwned.push(sessionId);
            continue;
        }
        const state = options.probe ? await options.probe(sessionId).catch(() => 'owned') : 'free';
        if (state === 'owned') {
            skippedOwned.push(sessionId);
            continue;
        }
        for (const path of localCopies(options.dshHome, sessionId))
            rmSync(path, { recursive: true, force: true });
        delete ledger.sessions[sessionId];
        purged.push(sessionId);
        changed = true;
    }
    if (changed)
        writeLedger(options.ledgerPath, ledger);
    return { purged, skipped_owned: skippedOwned, remaining: Object.keys(ledger.sessions).length };
}
export function persistenceProbe(persistence) {
    return async (sessionId) => {
        try {
            const handle = await persistence.open(sessionId, 'write');
            await handle.close();
            return 'free';
        }
        catch (error) {
            const name = error?.name ?? '';
            if (name === 'SessionPersistenceNotFoundError')
                return 'missing';
            // 被占用（SessionAlreadyOwnedError）或无法判断：都不删，下一轮再试。
            return 'owned';
        }
    };
}
//# sourceMappingURL=local-retention.js.map