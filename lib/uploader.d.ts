/**
 * 会话事件上报。
 *
 * - 按会话缓冲已提交事件，回合结束（turn/end）或缓冲满时上报；序号出现缺口（DSH 续接时会跳号）就拆成多个批次，
 *   每个批次序号连续，与平台契约一致。
 * - 上报失败的批次写入本地暂存目录（文件权限 0600），下次运行先补报；采集超过七天的批次停止上报并删除。
 * - 同一 `DSH_HOME` 下多个 profile 可能共用一个暂存目录：文件名带 profile 前缀，补报只处理本 profile 的批次，
 *   避免 A 把 B 设备/成员产生的批次以自己的令牌上传（2026-11-17 排练实测）。
 * - 平台按 `device + session + end_seq` 去重，重复补报安全。
 * - 只上报对摘要有用的内容：系统提示词、请求头等大块内容只保留类型与序号。
 */
export interface ProbeEvent {
    seq: number;
    type: string;
    at: string;
    data: Record<string, unknown>;
}
export interface Batch {
    session_id: string;
    start_seq: number;
    end_seq: number;
    captured_at: string;
    content_sha256: string;
    events: ProbeEvent[];
    client: {
        plugin_version: string;
        dsh_version: string;
    };
}
export type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<{
    status: number;
    json(): Promise<unknown>;
}>;
export declare const RETENTION_MS: number;
export declare function eventPayload(type: string, data: unknown): Record<string, unknown>;
export declare function toBatches(sessionId: string, events: ProbeEvent[], client: Batch['client']): Batch[];
/**
 * 清理旧版（0.2.1 及以前）共享暂存目录里满七天的批次。
 * 0.2.2 起默认使用按 profile 分开的目录，旧目录不再被补报；里面的内容按七天留存删除，
 * 未满七天的保留，避免升级瞬间误删仍可能被旧进程补报的批次。
 */
export declare function purgeExpiredSpool(dir: string, now?: number): number;
export interface UploaderOptions {
    platformBaseUrl: string;
    token: () => Promise<string | undefined>;
    spoolDir: string;
    /** 暂存文件名前缀（通常是 DSH profile）；多个 profile 共用一个目录时只补报自己的批次。 */
    spoolPrefix?: string;
    client: Batch['client'];
    fetch: FetchLike;
    log?: (message: string) => void;
    now?: () => number;
}
export declare class Uploader {
    private readonly options;
    private readonly buffers;
    private chain;
    constructor(options: UploaderOptions);
    record(sessionId: string, event: ProbeEvent): void;
    /**
     * 先同步写入暂存目录再异步上传：DSH headless 在任务结束后立即退出，来不及完成的上传下次运行补报。
     * 同一进程内串行上传，保证序号顺序。
     */
    flush(sessionId?: string): Promise<void>;
    /** 补报暂存目录里本 profile 的批次；超过七天的（含其他 profile/旧版本留下的）直接删除。 */
    drainSpool(): Promise<void>;
    /** 不属于本 profile 的批次：超过七天按留存删除，未满七天留给对应进程或人工处理。 */
    private expireAbandoned;
    private expired;
    private spool;
    private send;
}
