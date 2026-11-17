export interface SessionOwner {
    version: 1;
    /** 首次看到该会话的 DSH profile 名。 */
    profile: string;
    first_seen_at: string;
}
export interface ClaimResult {
    /** 标记里的 profile；标记损坏时为 'unknown'。 */
    owner: string;
    /** 本次调用是否创建了标记。 */
    claimed: boolean;
}
export declare function sessionOwnerDir(dshHome: string): string;
export declare function sessionOwnerPath(dshHome: string, sessionId: string): string | null;
/** 读取已有归属标记；不存在或损坏返回 undefined。 */
export declare function readSessionOwner(dshHome: string, sessionId: string): SessionOwner | undefined;
/**
 * 认领会话归属。第一次调用创建标记并返回 claimed=true；之后返回已有 owner。
 * 会话号不合法时返回 null（调用方按"无法判断"处理）。
 * 文件系统错误向上抛，由调用方记录并降级。
 */
export declare function claimSession(options: {
    dshHome: string;
    sessionId: string;
    profile: string;
    now?: Date;
}): ClaimResult | null;
/** 测试与排障用：删除一个会话的归属标记。 */
export declare function clearSessionOwner(dshHome: string, sessionId: string): void;
