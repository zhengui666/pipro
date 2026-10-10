# pipro 验证与复审材料

2026-10-10 状态：在已复审的 main `fca2796a` 上新增 Cloudflare Access origin 认证及 11 项回归，独立复审确认没有阻断源码公开提交的问题。实现阶段官方 pi v1.1.0 的无 prompt 生命周期通过；独审阶段跳过真实 pi，两份证据的边界见下表。本轮仅发布已审源码，没有创建 grant/client/永久凭据、调用模型、启动服务或修改隧道路由；部署、模型编码、ChatGPT 实际接入和 Cloudflare 边缘 OAuth 均未验收。

## 当前改动的验证证据（2026-10-10）

```sh
npm run check
PIPRO_REAL_PI=/absolute/path/to/installed/pi npm test
```

实现阶段结果：`npm run check` exit 0；显式启用真实 pi 的 `npm test` exit 0，68 tests / 68 pass / 0 fail / 0 skipped，14655.836669 ms；`git diff --check` exit 0。日志保存在被 Git 忽略的 `.local/cloudflare-check-final.log` 与 `.local/cloudflare-tests-final.log`，不随源码发布。

| 验证来源 | 结果与边界 |
|---|---|
| 实现阶段 | check 通过；68/68 通过，包括真实 pi 无 prompt 生命周期；没有模型调用 |
| 独立复审 | check 通过；67 通过、1 项真实 pi 跳过；额外 15 项认证探针通过，源码没有公开提交阻断问题 |
| 独审真实 pi 复跑 | 两次执行请求被拒后停止；本轮发布不重跑，也不将此前实现验证当作独审复跑成功 |
| 外部接入检查 | 入口外侧 curl 与云 Chrome 出现 HTTP 301 自重定向循环，根因未定位；不是 OAuth/MCP 或 ChatGPT 连接成功证据 |

- 原 57 项回归保留；新增 11 项覆盖 Access 配置、JWT/HTTP 认证和真实 pi 无 prompt 生命周期。
- Access 测试使用内存临时签名密钥，fetch 只允许固定团队 `/cdn-cgi/access/certs` fixture；覆盖签名、issuer、AUD、type、email、sub、时钟、service identity、opaque-token 绕过、重复/过大 header、固定 JWKS 地址、共享缓存、轮换、超时与禁止重定向。没有生产任意 JWKS 注入接口。
- HTTP 测试覆盖 8 个工具的空 OAuth scopes 及副作用 annotations、Host/Origin、401/403、token 更新后任务 owner 稳定、其他 sub 不能访问任务；旧 OAuth 的 `pi:control`、metadata 和错误回归继续运行。
- `test/real-pi.test.js` 仅在显式设置绝对 `PIPRO_REAL_PI` 路径时运行。使用新临时 HOME/workspace、空 passEnv，连续两次启动 → `get_state` → 清队列/abort → RPC 退出 → workspace 复用，没有 prompt、HTTP 模型请求或用户凭据读取。默认不设置时跳过该项。

原 `PROCESS_EXIT/action pi` 启动失败已对照成功直接 RPC 的 argv/env/stderr。受限执行器内 Node 子进程（包括普通 Node 控制探针）exit 0 且 stdout/stderr 为空；获准在正常进程环境运行后，相同 TaskManager 参数正常完成真实 pi 生命周期。因此未修改任务/RPC 启动实现，也未放宽隔离参数。原 scratch 的 `cleanup_unconfirmed` 标记和私有诊断证据保留，没有通过删标记解锁。

## 插件包装基线验证（2026-10-09 历史证据）

当时服务基线 main `917b4a17` 的原五项阻断、OAuth scope 响应及启动竞争通过独立复验，原 40 项测试保留。portable 插件包装的本地验证及独立复审通过。下表的 57 项及 pi 未安装状态为当时结果。

在项目根目录执行：

| 命令/检查 | 结果 |
|---|---|
| `npm run check` | exit 0；8 个原源码模块及新增包装脚本语法检查通过 |
| `npm test` | exit 0；57 tests / 57 pass / 0 fail / 0 skipped；8293.607388 ms；原 40 项与新增 17 项均通过 |
| skill-creator `quick_validate.py` | setup 与 control-pi 均 exit 0，Skill is valid |
| `npm run package:plugin -- --target chatgpt …` | exit 0；以测试 raw app ID生成 7 文件 fixture 包，包含 `.app.json`，不含 mcp.json |
| `npm run package:plugin -- --target desktop …` | exit 0；以测试 HTTPS URL生成 7 文件 fixture 包，包含 mcp.json，不含 `.app.json` |
| 独立复审回执 | 57/57 与 check 通过，额外 30 项独立负例及双模式实际 CLI 生成通过，无阻断源码公开更新项 |
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

本轮 runtime 修改仅涉及 `src/config.js`、`src/auth.js`、`src/server.js`；任务/RPC 与旧 OAuth/none 合约保持基线。新增 Access 配置示例和测试，不增加依赖。历史 portable 包装涉及 root `plugin.json`、两个 `skills/`、`scripts/build-plugin.mjs`；打包器纯离线，在固定白名单和输入验证完成后构造同级临时目录，最后原子 rename。ChatGPT 输出 `.app.json`，desktop 输出带 schema/type 的 `mcp.json`，两者互斥；用户绑定默认整包被 Git 忽略。安装方式与限制见 `docs/PLUGIN_INSTALL.md`。

新增 `test/plugin.test.js` 17 项覆盖：portable 清单/version、两模式结构与引用、排他、raw ID/URL/CLI 参数拒绝、显式 loopback 与 IPv6、固定白名单、稳定字节输出、非空目录保留/空目录原子替换、输出与源符号链接、坏模板/缺文件不产生输出、write/rename 注入失败清理、发布时竞争文件保护、实际 Git 忽略，以及真实 CLI 成功/失败输出。临时 ID和 URL只验证包装格式，不代表存在的连接或已授权账号。

- `src/config.js`：严格配置与命名 workspace realpath 校验；拒绝重叠目录、任意 argv、非回环 host；最小环境。
- `src/rpc.js`：LF 字节分帧、唯一 request ID、乱序关联、背压、边界、首个失败与超时、退出及进程组清理。
- `src/tasks.js`：异步任务、持久化 workspace 租约、队列数量/字节限额、run deadline、清理状态与错误、TTL。
- `src/output.js`：固定 metadata 投影；可选有界脱敏正文；不透传工具记录/错误/stderr。
- `src/auth.js`：旧 OAuth 公共 JWKS 的资源/subject/scope 校验；新 Access 模式只验证 `Cf-Access-Jwt-Assertion`，绑定团队 issuer、应用 AUD 和唯一邮箱，保留 issuer/sub owner 摘要，固定远程 JWKS 缓存/轮换。
- `src/server.js` / `src/schemas.js`：官方 MCP SDK v2 HTTP，严格 schema、真实副作用 annotations、ChatGPT securitySchemes。

## 未验收事项

1. 真实 pi v1.1.0 无 prompt 的启动/状态/取消与复用已验证；真实模型结果/费用和 ChatGPT 插件连接未测试。
2. OAuth 与 Access origin 本地测试通过；真实 Access AUD、Managed OAuth、从实际表单/metadata 核对的 callback、本人 grant/client 授权、公共 401/discovery/PKCE/客户端注册以及 TLS 网关/隧道仍待配置与验收，不能用占位 AUD 部署。
3. cwd 映射不是 OS 沙箱。pi 官方 bash 自身使用 detached 进程；RPC 退出和进程组 kill 不能证明所有工具已停止。生产环境需独立 OS 用户/容器/cgroup；异常租约仅在管理员确认旧进程/写入停止后手动清除。
4. `cleanupStatus:confirmed` 表示官方 clear_queue/abort 及 RPC 进程组关闭成功，不替代 OS 层后代进程验收。`cleanup_unconfirmed` 恒不报告 final，也不自动解锁。
5. 默认 metadata 不返回正文；redacted_text 无法保证识别任意未知/编码秘密。
6. 会话/事件只在内存；workspace 租约持久保存。没有分布式、多租户 OS 安全或在线 token 吊销服务。
7. 服务、插件包装和本轮 Access 源码均已独立复审；源码公开不代表部署或凭据授权。生成的用户绑定包/fixture、node_modules、运行配置、piHome、会话、测试日志、私有机器路径和秘密均不提交到源码仓库；实际团队域名、资源 URL 和已确认邮箱只属于私有部署配置。
8. 本地 marketplace 识别、deep link 安装、web 管理员 GitHub 导入与实际 app/MCP 连接均未执行。生成器成功不等于 ChatGPT 安装成功；根模板不是 skills-only 最终控制器，公开目录提交还需正式 MCP/身份/审核材料。

## 最小用户配置

pi 可执行路径、专用 piHome、workspace 名称→绝对目录；已批准的 provider/model 与现有认证方式；是否启用正文；正式连接时的已有 HTTPS/OAuth 或经批准的 Tunnel。旧 OAuth 需要 issuer/resource、公共 JWKS 和允许的 subject；Access 模式需要真实 team issuer、HTTPS `/mcp` resource、应用 AUD 和唯一已确认邮箱，随后另行验收 Managed OAuth。无需在聊天中提供密钥值。
