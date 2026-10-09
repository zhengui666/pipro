# pipro

让 ChatGPT 通过 MCP Streamable HTTP 管理目标 Linux 机器上的 pi coding agent。每个任务是独立的 pi RPC 子进程，立即返回明确的 `taskId`；发送消息、取消均异步返回，随后轮询状态、事件和结果。

本项目包含可运行的 MCP 服务源码、portable 插件模板与两个使用技能。离线打包器可把它们绑定到已有 ChatGPT app 或 desktop MCP 地址；导入对应 marketplace 后从插件页安装。它不会自动登录、创建凭据、开公网端口、建立隧道或部署服务。

## 支持范围与验证状态

- 协议基线：[pi v1.1.0 RPC](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc.md)。原 badlogic/pi-mono 已迁移到 earendil-works/pi，当前官方包是 `@earendil-works/pi-coding-agent`。旧 pi 版本可能缺少这些参数或事件，不保证兼容。
- MCP：官方 [TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)，固定 server/client 2.3.1、node adapter 2.1.1；使用无会话、JSON 响应的 Streamable HTTP。MCP 连接断开不会丢失服务内存中的 pi 任务。
- 运行环境：Linux、Node.js 22+。本轮实际验证环境为 Manjaro、Node 26.7.0。没有构建步骤。
- fake pi 协议、生命周期、官方 MCP 客户端 HTTP、OAuth JWT 测试已执行。**真实 pi 未实测**：开发机未发现 pi；没有安装/登录 pi 或进行外部付费模型调用。ChatGPT 账户实际连接、真实 IdP 授权流程、生产隔离和部署均未验收。

## 最小启动步骤

若服务/连接已准备好，可先阅读下一节的插件打包与安装。服务尚未配置时，按这里准备目标机器；插件安装不会代替机器配置或批准 coding agent 执行任务。

在目标机器上准备 Node.js、官方 pi v1.1.0 可执行文件，以及管理员批准的工作目录。pi 安装按[官方说明](https://github.com/earendil-works/pi/tree/v1.1.0/packages/coding-agent)完成。先确认 `pi --version` / `pi --help`，不要把不兼容版本当作通过。

```sh
cd pipro
npm ci --ignore-scripts --no-audit --no-fund
cp config.example.json config.json
# 编辑 config.json 的 piExecutable、piHome 与 workspaces；路径必须已存在。
npm start -- /absolute/path/to/pipro/config.json
```

`piExecutable` 必须是目标机上 pi 的绝对可执行路径，服务用 `spawn` 和固定参数执行它，`shell:false`。`piHome` 是管理员专门批准的 pi 配置目录，服务将它设为 `HOME` 和 `PI_CODING_AGENT_DIR`。不要把普通用户的整个 home、SSH/cloud 配置或未知 pi 扩展目录直接交给此服务。现有模型配置和认证由用户自行批准并准备；本项目不创建/复制/显示模型密钥。

可选 `provider`、`model` 仅能在服务端配置，ChatGPT 无法更改。如果需向 pi 传入已有模型环境变量，在 `passEnv` 明确列出变量名，例如 `ANTHROPIC_API_KEY`；配置中不填变量值。默认不继承任何模型密钥、OAuth 请求 token 或全套环境。`PATH` 只用于目标机已有运行时，管理员应确保其可信。`NODE_OPTIONS`、`LD_PRELOAD` 等注入变量不可透传。

默认地址是 `http://127.0.0.1:8787/mcp`，仅本机调试可用。服务始终禁止 `0.0.0.0`、公网 IP 或任意 hostname 绑定，即使开启 OAuth。生产远程入口应由管理员独立管理的 TLS 网关代理到回环服务，或使用支持的私网接入方式。不要把 `auth:none` 的端点代理到公开网络。

## 插件打包与便捷安装

在已有 MCP app/endpoint 的前提下，选择一种模式，运行纯离线生成器：

```sh
# ChatGPT：PIPRO_APP_ID 为你自己注册连接的原始 ID，不能填 plugin_ 页面 ID。
npm run package:plugin -- --target chatgpt --app-id "$PIPRO_APP_ID" --out .pipro-plugins-chatgpt

# Desktop：PIPRO_MCP_URL 为已有且获批准的 HTTPS /mcp 地址。
npm run package:plugin -- --target desktop --mcp-url "$PIPRO_MCP_URL" --out .pipro-plugins-desktop
```

输出包括 `pipro-local` marketplace、pipro 清单、setup/control-pi 技能、INSTALL.md，以及互斥的 `.app.json` 或 `mcp.json`。输出整包默认被 Git 忽略，不把用户绑定提交到源码仓库。已有非空目录和危险符号链接拒绝；生成器不执行网络、安装、授权或隧道操作。

支持本地 marketplace 的客户端可用现有 Codex CLI 手动导入**生成目录根**，再重启 desktop，从 Plugins Directory 的 `pipro-local` 来源安装。客户端已识别该 marketplace 后，可使用 `codex://plugins/install/pipro?marketplace=pipro-local` 打开安装流程；这个链接不能替代首次导入，也不是 ChatGPT web 的通用安装按钮。

ChatGPT web 工作区导入需要管理员、已授权 GitHub 访问及另行批准的绑定包分发；公开源码根不是可直接安装的最终控制器。完整命令、前提、原始 ID规则与正式提交限制见 [插件安装说明](docs/PLUGIN_INSTALL.md)。不要提交根模板为 skills-only 插件，官方当前不支持发布后补加 MCP。

## ChatGPT 接入

依据 2026-10-09 核对的[官方接入文档](https://developers.openai.com/api/docs/guides/custom-mcp-server)，在 ChatGPT web 的 **Plugins → 加号 → Add custom MCP server** 添加连接。账户/工作区权限可能限制此功能，以当前页面为准。

1. 先在目标机器启动 pipro，并完成本地测试。
2. 选择管理员已批准的可达方式：已部署并认证的 HTTPS 地址（如 `https://pipro.example.com/mcp`），或页面支持的 Tunnel。ChatGPT 云端无法直接访问你机器的 `127.0.0.1`。
3. HTTPS 方案选择 OAuth，使用已有 IdP 的连接信息。ChatGPT 的 OAuth 客户端注册按该 IdP 支持的静态客户端、CIMD 或 DCR 方式配置；不要假设有可输入自定义固定 API key 的认证选项。
4. 阅读风险提示，选择 **Create as a plugin**，然后安装该插件。在新对话中通过 `@pipro` 明确指定它。
5. 刷新工具列表，确认创建/发消息/取消被标为有副作用。先在空测试 workspace 上创建无 prompt 的任务，核对 `idle`，再取消并确认 `cancelled`、`cleanupStatus:confirmed` 和 `processExited:true`。

[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 可让受支持 OpenAI 产品访问私网 MCP，无需公开入站端口。若选择它，用户需自行审查官方客户端、授权和连接参数；本项目不下载/启动隧道、不保存其访问凭据。不能把本地 mock 测试当作隧道或 ChatGPT 实际接入成功。Tunnel/回环地址也不等于公开插件商店提交条件。

可直接给 ChatGPT 的指令：

> 使用 pipro，先列出 workspace，再在 demo 创建任务，prompt 为“检查当前项目的测试并报告问题”。保存 taskId；用 get_status 和 get_events 读取进度，直到 settled/failed/timed_out/cancelled。若出现 cleanup_unconfirmed，报告 error/cleanupError 并停止在该 workspace 创建任务，交由管理员检查。不要把 command receipt 当作模型完成。任何新编码要求都通过这个 taskId 提交。

## 工具与异步约定

| 工具 | 输入 | 行为/副作用 |
|---|---|---|
| `list_workspaces` | `{}` | 返回允许的名字；不返回路径 |
| `create_task` | `workspace`, 可选 `prompt` | 启动 pi 子进程；可执行命令、写文件、消耗模型额度 |
| `send_message` | `taskId`, `mode`, `message` | `prompt` / `steer` / `followup`；可能继续编码与执行 |
| `list_tasks` | `{}` | 有界、当前调用者的任务摘要 |
| `get_status` | `taskId` | 读取缓存状态，不调用 pi |
| `get_events` | `taskId`, `after=0`, `limit=20` | 最多 50 条摘要事件、递增 cursor、丢失窗口提示 |
| `get_result` | `taskId` | 最新 assistant 结果；无运行、待发命令或队列消息且状态已终结时 `final:true`；清理不确定时为 false |
| `abort_task` | `taskId` | 清队列、abort、终止进程组；不能撤销已发生的改动或外部操作 |

所有工具都显式声明 input/output schema、认证 metadata 和 annotations。后三类读取工具与列表只读；创建、发消息和取消明确 `readOnlyHint:false`，不能用只读观察来描述整个插件。

`create_task` 立即返回 `starting`；pi `get_state` 成功后进入 `idle`，有初始 prompt 时后台提交。`starting` 期间外部 `send_message` 同步返回 `TASK_NOT_READY`，不占队列；先等待启动完成再重试，保证 create 的初始 prompt 先提交。`send_message` 接受时返回 `commandId` 和 `acceptedByService:true, acceptedByPi:false`，再看对应 `command_accepted` / `command_failed` 事件。同步验证失败返回 MCP `isError:true`。

普通 `prompt` 用于 idle/settled；pi 在 streaming 时会拒绝不带 `streamingBehavior` 的 prompt。`steer` / `followup` 使用官方 `prompt + streamingBehavior:steer/followUp`：由 pi 原子判断，运行中入队、已经空闲则启动新 run，因此不会因状态检查竞态把消息留在空闲队列。`disposition:started` 表示运行已接受，`queued` 表示输入入队，`handled` 表示没有为该输入启动 run，保留上一 run 的结果。低层 `agent_end` 后可能 retry/followup，只有 `agent_settled` 才进入 `settled`。每次真实 `agent_start` 重置结果并启动新的 deadline；最终模型错误在清理成功后进入 `failed`。

取消先阻止新消息，等待当前请求结果，再逐条检查 `clear_queue` 和 `abort` 响应，最后关闭 RPC 进程及其进程组。成功取消为 `cancelled`、`cleanupStatus:confirmed`，解除 workspace 锁。若 RPC 异常退出、协议/请求超时、取消失败或进程组清理失败，则进入 `cleanup_unconfirmed`、`cleanupStatus:unconfirmed`，即使 `processExited:true` 也保留 workspace 锁。`error` 保留最初失败的 `code/action`；后续不同清理错误另列在 `cleanupError`。该状态的 `get_result.final` 恒为 false，不能报告任务安全结束。

`get_events.after` 传上次 `nextCursor`。`gap:true` 表示较老事件已移出环形缓冲，从 `oldestCursor` 续读。未来 cursor 会拒绝。没有无限长 SSE 订阅，也不返回完整原始会话。任务、结果与事件只在内存中，服务重启后不恢复旧 session；workspace 租约保存在 `piHome/pipro-leases/<workspace>.json`。启动发现遗留租约时直接隔离该 workspace，重启服务和 TTL 都不会清除它；没有 MCP 解锁工具。

默认同时最多 2 个 pi 进程、100 条任务记录，每个真实 workspace 同时只允许一个任务。workspace 的别名/父子路径重叠会拒绝，以免同一代码目录并发写。`maxQueuedCommands` 默认 8，计入服务尚未发送/确认的消息及 pi 尚未消费的队列；`maxQueuedMessageBytes` 默认 131072，按 UTF-8 字节计入同一批消息。只有 pi 的完整 `queue_update` 消费/清除快照才释放已入队容量，`queued` RPC 回执本身不释放容量。发送中的容量暂时保守计算，可能暂时拒绝新输入。

运行 deadline 默认 60 分钟，idle/settled 的会话 15 分钟后关闭；清理已确认且 RPC 已退出的终态记录 60 分钟后删除。`cleanup_unconfirmed` 记录和持久化租约保留，需人工处理。用户可以在 limits 内调节有界值。

## 输出与实际隔离边界

默认 `outputMode:metadata`：只返回固定投影的事件类型、已批准工具名、队列数量、停止原因；不返回 prompt、工具参数、工具结果、思考内容、会话文件路径、原始异常或 stderr。结果的 `available:true,textWithheld:true` 表示已取得 assistant 消息，但正文没有发送到 ChatGPT。

若确实需要回答正文，管理员显式选择 `redacted_text`。服务仅保留最终 assistant 的文本块，移除已传入的环境秘密、常见 token/密钥/Authorization/口令模式，再截到默认 12000 字符，`truncated` 标记截断。**脱敏规则不能识别任意未知格式、编码/拆分的秘密。敏感环境请保留 metadata 模式，并在 OS 层限制 agent 能读取的秘密。** 本项目不会读取秘密文件来构建脱敏表，也不透传完整环境。

命名 workspace 映射约束的是控制接口的 cwd，**不是文件系统沙箱**。pi 的 read/write/bash 仍拥有其 OS 用户的权限，能按 prompt 访问映射目录以外的路径，也可能访问网络。不同任务的进程/内存会话隔离不等于 OS 用户或容器隔离。所有被批准 OAuth subject 都可启动映射中的 workspace，但只能通过本服务读取/取消自己创建的任务；同一 OS 权限下的 agent 仍可能看到其他目录，不能据此宣称多租户安全。

固定启动参数禁用 extensions、MCP、skills、templates、themes、上下文文件发现和 project trust，并启用 `--no-session --offline`。`--offline` 只关闭 pi 的自动后台网络操作，**不禁止模型请求或 agent 的 shell 网络访问**。prompt 以 `/` 开头会拒绝，避免 slash 命令修改运行配置。没有暴露 bash RPC、任意 executable/argv/cwd/session 路径或全局命令执行工具；自然语言 prompt 仍可指示 coding agent 执行命令。

正式机器请用专用 OS 用户/容器，只挂载批准的目录，限制写权限、网络出口、资源和秘密可见范围。服务配置/可执行文件不得由 agent 修改；模型权限和费用需要用户另行批准。`examples/pipro.service` 是供管理员审查的 Linux systemd 示例，未自动安装，里面的 hardening 不能替代完整的容器/OS 沙箱。

pi 的官方 bash 工具在 Linux 上会启动 detached 进程，未必属于 RPC 的进程组；RPC 退出和进程组 kill 都不能证明它已停止。`cleanupStatus:confirmed` 只表示官方清队列/abort 协议和 RPC 进程组关闭成功，不能替代 OS 层的全部后代进程验收。异常路径保留租约，禁止新任务复用目录。强隔离部署应使用独立容器/cgroup 生命周期。

处理 `WORKSPACE_QUARANTINED` 时，管理员应停止 pipro，检查对应租约，确认旧 pi 及工具进程已终止、隔离容器/cgroup 已停止、目录不再被写入，之后才人工删除该 workspace 的单个租约并重启。不要通过改名 workspace、改 piHome、批量删除租约或反复重启来跳过检查；服务配置与租约目录需由管理员保护。上述检查和解锁没有自动执行，也不会扩大系统权限。

## OAuth 远程设计与配置

本服务实现的是 OAuth **资源服务器**；授权服务器由现有 IdP 提供。参考 `examples/config.oauth.example.json`：

- `issuer` 必须严格匹配 IdP 的 issuer；`resource` 是对外 HTTPS `/mcp` URL，也是 token 的 audience。
- `jwksFile` 仅接受 IdP 公共非对称 JWK 集。不会读取私钥、拉取用户指定网络 URL或生成凭据。密钥轮换后由管理员更新公钥文件并重启。
- 验证 RS256/ES256/EdDSA 签名、issuer、audience、exp、iat、sub；token 最大年龄 1 小时，必须包含 `pi:control` scope 且 subject 在 `allowedSubjects`。
- 每个 HTTP 请求都验证身份。用 issuer/sub 的摘要隔离任务所有权，更新 token 后仍可访问自己的 taskId。未认证或 token/audience/subject 无效返回 401；有效 token 缺少 `pi:control` scope 返回 403，并带 `insufficient_scope` challenge 与 OAuth resource metadata。
- 暴露 `/.well-known/oauth-protected-resource/mcp` 及根路径 alias。TLS 网关必须同时代理这些 metadata 路径，保留 `Authorization`、Host 和 MCP headers，限制 body/速率并保护日志。
- IdP 应提供 OAuth 2.1 authorization-code + PKCE S256、resource indicator/audience 绑定和适当客户端注册。ChatGPT 回调/客户端信息依据[官方认证文档](https://developers.openai.com/plugins/build/auth)及当前注册页面核对。pipro 不自行实现 IdP、DCR、刷新或登录。
- 正式接入需要管理员审查 token 吊销与轮换策略。当前是本地公钥 JWT 校验，没有在线 introspection；已签发 token 在过期前不会因 IdP 的即时吊销自动失效。

没有创建 IdP 客户端、长期密钥或防火墙规则。缺少上述认证/可达性配置时，只能做回环开发验证，不能声称正式远程接入完成。

## 测试

```sh
npm run check
npm test
```

测试只启动仓库内的 `test/fake-pi.js`、临时工作目录和回环 HTTP。OAuth 测试密钥仅在内存，磁盘只写临时公钥，测试结束清理。不会运行真实 pi、访问模型或读取用户凭据。

覆盖 JSONL byte LF/CRLF、碎片 UTF-8 与 U+2028/U+2029、乱序响应、`success:false`、畸形/过长/断流/无 ID 响应、启动/退出/超时、快完成竞态、handled/queued、完整取消与失败、进程组清理、workspace 互斥、owner 隔离、事件窗口、输出限制，以及 SDK HTTP 工具 schema/annotations 和 OAuth。

独立复审回归位于 `test/review.test.js`：真实 detached fixture 在 RPC 崩溃后继续写入时，workspace 仍隔离且重启/TTL 不解锁；pi 队列的数量/UTF-8 字节及发送中预留共同限额；缺少快照时保守保留容量；steer/followup 在 settled 竞态中启动新 run；新 run 保留 deadline；取消期间 prompt 超时不伪报 cancelled；原运行错误与后续清理错误分别保留；默认队列限额 8 和限额 1 下，立即发消息均以 TASK_NOT_READY 拒绝，初始 prompt 正常先执行且不误隔离。OAuth 另测试有效 token 缺 scope 返回 403。

`test/plugin.test.js` 新增验证两种包装结构、清单与文件引用、raw ID/URL/参数拒绝、显式 loopback、固定白名单、确定性字节输出、Git 忽略、已有目录/符号链接保护和失败时不留半成品。包装测试不运行真正的插件安装或认证。

本轮执行器的受限 sandbox 内 Node 子进程曾出现 EPERM/提前退出；正常进程环境下本地测试通过。若在受限执行器复验遇到同样现象，应报告具体 spawn/权限失败，遵循平台审批，不绕过拒绝。

## 用户接入前只需决定

1. 目标机器的 pi v1.1.0 可执行路径、专门批准的 pi 配置目录，以及 workspace 名字→目录映射。
2. 已批准的 provider/model 与使用已有认证的方式；是否允许 coding agent 写入/执行和模型费用。
3. 使用 metadata，还是承担正文脱敏局限后开启 redacted_text。
4. 本地验证后，采用已有 HTTPS/OAuth 网关还是经批准的 Secure MCP Tunnel；OAuth 方案还需 issuer、resource、公共 JWKS、scope 和允许的 subject。无需在聊天中发送密钥值。

项目可在这些生产信息确定前完成源码审查与 fake 测试。GitHub 上传只应包含源码、测试、lockfile、示例和文档；`config.json`、piHome、session、token、临时日志与 node_modules 不应提交。

## 官方资料

- [固定版本 RPC 命令](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-commands.md)、[JSON 事件](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/json.md)、[SDK](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/sdk.md)、[CLI 参数](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/cli.md)
- [MCP SDK v2 Node transport](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/node/streamableHttp.html)
- [ChatGPT 自定义 MCP 插件](https://developers.openai.com/api/docs/guides/custom-mcp-server)、[认证](https://developers.openai.com/plugins/build/auth)、[工具 metadata](https://developers.openai.com/plugins/reference)、[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
