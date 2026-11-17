# @harness/dsh-plugin-handoff

DSH 事项交接插件（二期 P2-03、P2-05、P2-08 客户端部分，DSH 0.2.2-rc.3 实测，见 `docs/acceptance/phase-2.md`）。
依赖认证插件 `@harness/dsh-plugin-auth`：两者共用同一个访问令牌引用 `HARNESS_PLATFORM_TOKEN`。

## 安装

- **命令行安装器（推荐）**：平台 `/install/` 下发的安装器默认同时安装认证插件与本插件
  （`--without-handoff` 只装认证插件）。
- **DSH 插件页 / CLI**：先装认证插件，再粘贴本插件仓库地址，或
  `dsh plugin --profile <profile> add github:<所有者>/dsh-plugin-harness-handoff`。

## 做什么

1. **会话事件上报**：监听 `session/event`，回合结束时按序号连续的批次上报 `POST /ingest/sessions`。
   每批先写本地暂存（`$DSH_HOME/harness-team/handoff-spool/`，0600）再上传，DSH 退出前没传完的下次启动补报；
   平台按批次去重。系统提示词等大块内容只上报类型与序号。
2. **首轮事项接续**：每个会话第一次进入模型请求前，在两秒内调用 `POST /matters/resolve`，
   命中事项就把接续摘要作为一条消息追加进本步输入（来源 `kind: 'harness-handoff'`）。超时或失败照常进行。
3. **七天留存**：
   - 暂存批次从采集起满七天即删除，不再上报；
   - 本插件采集过的会话记入 `$DSH_HOME/harness-team/handoff-ledger.json`，从首次采集起满七天，
     删除 DSH 本机的两份副本：`sessions/<工作目录名>/<会话号>/`（事件日志）与
     `storages/session_projcache/sessions/<会话号>.json`（投影缓存）。
   - 只删台账里的会话：同一 `DSH_HOME` 下个人 profile 的会话不受影响。
   - 正在被任何 DSH 进程使用的会话不删（用 DSH 会话存储的单写者锁探测），下一轮再试。清理在第一轮对话结束后
     （或启动一分钟后）开始，之后每小时一次。
   - 删除后该会话不能再用 `--session-id` 续接；隔日接续由平台摘要提供。

## 配置

```yaml
- id: harness-handoff
  config:
    platformBaseUrl: https://43-134-117-172.nip.io   # 或环境变量 HARNESS_PLATFORM_URL
    # apiKeyEnv: HARNESS_PLATFORM_TOKEN              # 与认证插件一致
    # inject: true                                   # 首轮事项接续
    # localRetention: true                           # 本地会话副本七天清理
    # spoolDir: <DSH_HOME>/harness-team/handoff-spool
```
