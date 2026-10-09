# pipro 验证与复审材料

2026-10-09 状态：原五项阻断、OAuth scope 响应及追加启动竞争均已通过独立复验，40 项测试与语法检查通过，无剩余源码审查阻断。GitHub 公开上传已获授权；生产部署、真实 pi/模型与 ChatGPT 接入仍未验收，没有登录或建立隧道。

## 验证证据

在项目根目录执行：

| 命令/检查 | 结果 |
|---|---|
| `npm run check` | exit 0；8 个源码模块语法检查通过 |
| `npm test` | exit 0；40 tests / 40 pass / 0 fail / 0 skipped；7395.110248 ms |
| 运行环境 | Manjaro Linux，Node v26.7.0 |
| npm 依赖安装 | 官方 registry.npmjs.org；固定版本；`--ignore-scripts`；17 个包 |
| 真实 pi | 未安装；没有安装/登录或调用模型 |

测试使用项目自身 fake pi、临时 workspace 和回环 HTTP。OAuth 私钥在测试进程内临时生成，磁盘只写公共 JWKS，测试目录被清理。没有外部模型调用或用户凭据访问。

受限 sandbox 内 Node 子进程曾提前 exit 0，`spawnSync` 给出 EPERM；获准在正常进程环境执行测试后，取得上表结果。没有绕过权限拒绝。

## 独立复审问题与回归证据

初轮 29 项通过没有覆盖以下问题。新增回归没有把异常退出当作清理成功，也没有把最终状态断言放宽为任意状态。

| 复审问题 | 修正与证据 |
|---|---|
| RPC 崩溃后 detached 工具仍写入，同 workspace 却可重用 | 异常路径进入 `cleanup_unconfirmed` 并保留持久化租约；新建返回 `WORKSPACE_QUARANTINED`。fixture 验证后代真实继续写入，同时验证重启、TTL 不解锁，以及其他 workspace 可运行。 |
| queued 回执释放容量，pi 中的队列可无限累积 | 数量和 UTF-8 字节预算计入服务预留、未消费 pi 队列和缺快照回执；只有完整 `queue_update` 消费/清除才释放。验证限额 1 后 20 次提交拒绝、消费恢复容量、字节与发送中预留共同限额。 |
| steer/followup 遇 settled 竞态滞留空闲队列，却返回 final | 使用官方原子 `prompt + streamingBehavior`；分别验证 steer/followup 启动第二 run，重置结果，并在未完成时 `final:false`。 |
| 旧 settled 清除后续 run deadline | 每次实际 `agent_start` 开启新 deadline；验证第二 run 持续运行触发 timeout，而非无限运行。 |
| 取消期间 prompt 超时被吞，clear_queue/abort 未发却报告 cancelled | 保留 RPC 首个失败，返回清理不确定并保持锁；验证仅发送 get_state/prompt，错误精确到 `RPC_TIMEOUT/prompt`。另验证 `TASK_TIMEOUT/run` 和后续 `RPC_TIMEOUT/abort` 分别保留。 |
| 有效 OAuth token 缺 scope 返回 401 | 返回 403、`insufficient_scope` challenge；空 scope 和其他 scope 都有 HTTP 回归，其他无效身份仍返回 401。 |
| starting 阶段外部 followup 抢在 create 初始 prompt 之前，限额 1 时误隔离 | `starting` 同步返回 `TASK_NOT_READY/submit`，不占队列；内部初始 prompt 在设置 idle 后正常提交。默认限额 8 和限额 1 的两条回归都验证立即发消息拒绝、初始 prompt 唯一且先执行、无错误/误隔离、启动后 followup 可重试、取消后 workspace 可复用。 |

生命周期问题的 11 项回归位于 `test/review.test.js`；OAuth 回归位于 `test/http.test.js`。其余测试覆盖 JSONL 字节分帧/UTF-8/CRLF、乱序响应、协议错误、退出/超时、事件与正文边界、workspace 配置/owner 隔离、完整取消、SDK HTTP 工具 schema/annotations/securitySchemes。

## 实现检查入口

- `src/config.js`：严格配置与命名 workspace realpath 校验；拒绝重叠目录、任意 argv、非回环 host；最小环境。
- `src/rpc.js`：LF 字节分帧、唯一 request ID、乱序关联、背压、边界、首个失败与超时、退出及进程组清理。
- `src/tasks.js`：异步任务、持久化 workspace 租约、队列数量/字节限额、run deadline、清理状态与错误、TTL。
- `src/output.js`：固定 metadata 投影；可选有界脱敏正文；不透传工具记录/错误/stderr。
- `src/auth.js`：公共 JWKS 的 OAuth JWT 资源校验，subject allowlist、scope、issuer/resource/expiry。
- `src/server.js` / `src/schemas.js`：官方 MCP SDK v2 HTTP，严格 schema、真实副作用 annotations、ChatGPT securitySchemes。

## 未验收事项

1. 真实 pi v1.1.0、真实模型结果/费用，以及实际 ChatGPT 插件连接均未测试。
2. OAuth 资源服务器本地测试通过；真实 IdP authorization-code/PKCE/CIMD/DCR 流程、TLS 网关/隧道仍需管理员配置与验收。
3. cwd 映射不是 OS 沙箱。pi 官方 bash 自身使用 detached 进程；RPC 退出和进程组 kill 不能证明所有工具已停止。生产环境需独立 OS 用户/容器/cgroup；异常租约仅在管理员确认旧进程/写入停止后手动清除。
4. `cleanupStatus:confirmed` 表示官方 clear_queue/abort 及 RPC 进程组关闭成功，不替代 OS 层后代进程验收。`cleanup_unconfirmed` 恒不报告 final，也不自动解锁。
5. 默认 metadata 不返回正文；redacted_text 无法保证识别任意未知/编码秘密。
6. 会话/事件只在内存；workspace 租约持久保存。没有分布式、多租户 OS 安全或在线 token 吊销服务。
7. 独立复审已确认源码可交付。公开 GitHub 内容只包含源码、测试、lockfile、示例和文档；排除 node_modules、运行配置、piHome、会话、测试日志、私有机器路径和秘密。

## 最小用户配置

pi 可执行路径、专用 piHome、workspace 名称→绝对目录；已批准的 provider/model 与现有认证方式；是否启用正文；正式连接时的已有 HTTPS/OAuth 或经批准的 Tunnel。OAuth 需要 issuer/resource、公共 JWKS 和允许的 subject。无需在聊天中提供密钥值。
