/**
 * 会话事件上报。
 *
 * - 按会话缓冲已提交事件，回合结束（turn/end）或缓冲满时上报；序号出现缺口（DSH 续接时会跳号）就拆成多个批次，
 *   每个批次序号连续，与平台契约一致。
 * - 上报失败的批次写入本地暂存目录（文件权限 0600），下次运行先补报；采集超过七天的批次停止上报并删除。
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
export interface UploaderOptions {
    platformBaseUrl: string;
    token: () => Promise<string | undefined>;
    spoolDir: string;
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
    /** 补报暂存目录里的批次；超过七天的直接删除。 */
    drainSpool(): Promise<void>;
    private expired;
    private spool;
    private send;
}
