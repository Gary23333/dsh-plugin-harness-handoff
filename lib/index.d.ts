import { type SessionPersistenceLike } from './local-retention.js';
import { Uploader, type FetchLike } from './uploader.js';
/**
 * DSH 事项交接插件（二期 P2-03 客户端、P2-05 首轮注入）。实测版本 DSH 0.2.2-rc.3。
 *
 * - `session/event`：采集已提交事件，按批次上报平台（见 uploader.ts）。
 * - `agent/pre-step`：先 `next()`（让 harness-auth 等到令牌就绪），再在两秒内向平台匹配事项，
 *   命中则把接续摘要作为一条消息追加进本步输入。超时或失败时本次任务直接以用户输入继续。
 * - 注入消息的来源必须是生产方自有的 kind：DSH 0.2.x（会话格式 v4）拒绝 `kind: 'plugin'`。
 * - 本地留存：采集过的会话记入台账，从首次采集起满七天删除 DSH 本地日志与投影缓存（见 local-retention.ts）。
 * - profile 隔离：同一 `DSH_HOME` 下不同 profile 共用 `sessions/` 与暂存目录；本插件只采集首次看到该会话的
 *   profile 产生的事件，暂存按 profile 前缀隔离，避免 A 以自己身份上传 B 的会话（见 session-owner.ts）。
 *
 * 不依赖任何 DSH 包导入，类型只描述实际用到的最小子集。
 */
export declare const PLUGIN_VERSION = "0.2.2";
export declare const SOURCE_KIND = "harness-handoff";
type CredentialRef = string & {
    readonly __brand?: 'CredentialRef';
};
interface UserMessage {
    id?: string;
    role?: string;
    content?: unknown;
    source?: unknown;
    [key: string]: unknown;
}
type Decision = {
    kind: 'enter';
    messages: UserMessage[];
    [key: string]: unknown;
} | {
    kind: 'reject';
};
interface PreStepPayload {
    agent?: unknown;
    messages: UserMessage[];
    turn: number;
    step: number;
    signal: AbortSignal;
}
interface SessionEventLike {
    type?: string;
    seq?: number;
    data?: unknown;
}
export interface HandoffContext {
    credentials: {
        resolve(ref: CredentialRef): Promise<{
            value: string;
        } | undefined>;
    };
    effect?: (execute: () => void | (() => void)) => unknown;
    on(event: 'session/event', listener: (session: {
        id?: string;
    } | null, event: SessionEventLike) => void): unknown;
    on(event: 'agent/pre-step', listener: (payload: PreStepPayload, next: () => Promise<Decision>) => Promise<Decision>): unknown;
    logger?: {
        info?: (message: string) => void;
        warn?: (message: string) => void;
    };
    /** Cordis：读取启动器提供的 profile 信息（不需要声明 inject，读不到时回退）。 */
    get?: (name: string) => unknown;
    /** Cordis：服务可用时运行回调（这里用来拿 sessionPersistence 探测会话占用）。 */
    inject?: (deps: string[], callback: (ctx: {
        sessionPersistence?: SessionPersistenceLike;
    }) => void) => unknown;
}
export interface HandoffConfig {
    /** 平台根地址；缺省读 HARNESS_PLATFORM_URL。 */
    platformBaseUrl?: string;
    /** 访问令牌的凭证引用，与 harness-auth 的 apiKeyEnv 一致。 */
    apiKeyEnv?: string;
    /** 当前 DSH profile 名；缺省从 profileContext 读取，读不到时回退 default。 */
    profile?: string;
    /** 暂存目录，默认 $DSH_HOME/harness-team/<profile>/handoff-spool。 */
    spoolDir?: string;
    /** 首轮匹配是否启用，默认 true。 */
    inject?: boolean;
    /** DSH 本地会话副本七天清理，默认 true。 */
    localRetention?: boolean;
    /** 首轮等待事项匹配的毫秒数，默认 5000（含网络往返；服务端自身 1.7 秒内返回）。 */
    firstTurnWaitMs?: number;
}
export interface HandoffDeps {
    fetch?: FetchLike;
    dshVersion?: string;
    now?: () => number;
    /** 覆盖 DSH_HOME（测试用）；缺省读环境变量或 ~/.dsh。 */
    dshHome?: string;
    /** 首次本地清理的最长等待（默认一分钟；第一轮对话结束会提前开始）。 */
    purgeDelayMs?: number;
}
export declare function applyHandoff(ctx: HandoffContext, config?: HandoffConfig, deps?: HandoffDeps): Uploader | undefined;
declare const _default: {
    name: string;
    inject: string[];
    apply(ctx: HandoffContext, config?: HandoffConfig): void;
};
export default _default;
export { Uploader, toBatches, eventPayload } from './uploader.js';
export { purgeLocalSessions, noteSession, readLedger, localCopies } from './local-retention.js';
export { claimSession, readSessionOwner, sessionOwnerDir, sessionOwnerPath, clearSessionOwner } from './session-owner.js';
