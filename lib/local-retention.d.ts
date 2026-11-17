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
    first_captured_at: string;
}
export interface Ledger {
    version: 1;
    sessions: Record<string, LedgerEntry>;
}
export type OwnershipProbe = (sessionId: string) => Promise<'free' | 'owned' | 'missing'>;
export interface PurgeOptions {
    dshHome: string;
    ledgerPath: string;
    now?: () => number;
    /** 返回 owned 时跳过；缺省视为 free。 */
    probe?: OwnershipProbe;
    /** 额外跳过的会话（本进程当前会话）。 */
    skip?: ReadonlySet<string>;
}
export interface PurgeResult {
    purged: string[];
    skipped_owned: string[];
    remaining: number;
}
export declare function readLedger(path: string): Ledger;
/** 原子写入（先写临时文件再改名），权限 0600。 */
export declare function writeLedger(path: string, ledger: Ledger): void;
/** 首次见到某会话时记录采集时间；已记录的不改（续接不会延长留存期）。返回是否新增。 */
export declare function noteSession(path: string, sessionId: string, at: Date): boolean;
/** 该会话在本机的全部副本路径。 */
export declare function localCopies(dshHome: string, sessionId: string): string[];
export declare function purgeLocalSessions(options: PurgeOptions): Promise<PurgeResult>;
/** DSH sessionPersistence 的最小子集：用写入所有权探测会话是否正被使用。 */
export interface SessionPersistenceLike {
    open(id: string, access: 'read' | 'write'): Promise<{
        close(): Promise<void> | void;
    }>;
}
export declare function persistenceProbe(persistence: SessionPersistenceLike): OwnershipProbe;
