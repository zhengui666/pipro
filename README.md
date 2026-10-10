# pipro

让 ChatGPT 通过 MCP Streamable HTTP 管理目标 Linux 机器上的 pi coding agent。每个任务是独立的 pi RPC 子进程，立即返回明确的 `taskId`；发送消息、取消均异步返回，随后轮询状态、事件和结果。

本项目包含可运行的 MCP 服务源码、portable 插件模板与两个使用技能。离线打包器可把它们绑定到已有 ChatGPT app 或 desktop MCP 地址；导入对应 marketplace 后从插件页安装。它不会自动登录、创建凭据、开公网端口、建立隧道或部署服务。

## 安装按三个阶段完成

1. **源码或插件包准备**：源码用于检查、运行或离线生成绑定包。首次 ChatGPT 接入可以直接从 web 的 Add custom MCP server 流程开始，不要求预先有原始 app ID；已有 ChatGPT app 时，也可沿用下文已有 app ID 的离线打包流程。两种准备方式都不会部署服务或创建连接。
2. **Manjaro 服务部署**：在目标机器准备 Node.js、pi、隔离配置和已批准的 workspace，运行 pipro 服务。它只监听回环地址；远程访问需单独配置获批的 HTTPS 网关或专属 Tunnel 与访问策略。
3. **ChatGPT 连接与安装**：先验证远端入口的认证 challenge 和 discovery，再创建 MCP 连接。Cloudflare Access Managed OAuth 的回调只能从本次连接的管理页读取；不能要求空白配置表单预先有 callback。按官方 OAuth 流程，用户授权可能由首次工具调用启动；setup 首次只调用只读 `list_workspaces`，不自动创建 pi 任务。

## 支持范围与验证状态

- 协议基线：[pi v1.1.0 RPC](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc.md)。原 badlogic/pi-mono 已迁移到 earendil-works/pi，当前官方包是 `@earendil-works/pi-coding-agent`。旧 pi 版本可能缺少这些参数或事件，不保证兼容。
- MCP：官方 [TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)，固定 server/client 2.3.1、node adapter 2.1.1；使用无会话、JSON 响应的 Streamable HTTP。MCP 连接断开不会丢失服务内存中的 pi 任务。
- 运行环境：Linux、Node.js 22+。本轮实际验证环境为 Manjaro、Node 26.7.0。没有构建步骤。
- fake pi 协议、生命周期、官方 MCP 客户端 HTTP、OAuth JWT 测试已执行。官方 pi v1.1.0 已在独立目录安装，并通过无 prompt 的真实 RPC 启动、get_state、取消和 workspace 复用验证；没有登录 pi、传入模型凭据或调用模型。模型编码结果、ChatGPT 实际连接、Cloudflare 边缘授权、生产隔离和部署仍未验收。

## Manjaro 服务部署（源码运行）

在目标机器准备并本地检查服务；这一步只部署 MCP origin，不代替后续 ChatGPT 连接、授权或插件安装。

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

## 源码与插件包准备

首次 ChatGPT web 直连不需要离线生成包；若要将已有 ChatGPT app 或 desktop MCP endpoint 绑定进便携包，再选择一种模式运行纯离线生成器：

```sh
# ChatGPT：PIPRO_APP_ID 为你自己注册连接的原始 ID，不能填 plugin_ 页面 ID。
npm run package:plugin -- --target chatgpt --app-id "$PIPRO_APP_ID" --out .pipro-plugins-chatgpt

# Desktop：PIPRO_MCP_URL 为已有且获批准的 HTTPS /mcp 地址。
npm run package:plugin -- --target desktop --mcp-url "$PIPRO_MCP_URL" --out .pipro-plugins-desktop
```

输出包括 `pipro-local` marketplace、pipro 清单、setup/control-pi 技能、INSTALL.md，以及互斥的 `.app.json` 或 `mcp.json`。输出整包默认被 Git 忽略，不把用户绑定提交到源码仓库。已有非空目录和危险符号链接拒绝；生成器不执行网络、安装、授权或隧道操作。

支持本地 marketplace 的客户端可用现有 Codex CLI 手动导入**生成目录根**，再重启 desktop，从 Plugins Directory 的 `pipro-local` 来源安装。客户端已识别该 marketplace 后，可使用 `codex://plugins/install/pipro?marketplace=pipro-local` 打开安装流程；这个链接不能替代首次导入，也不是 ChatGPT web 的通用安装按钮。

ChatGPT web 工作区导入需要管理员、已授权 GitHub 访问及另行批准的绑定包分发；公开源码根不是可直接安装的最终控制器。完整命令、前提、原始 ID规则与正式提交限制见[插件安装说明](https://github.com/zhengui666/pipro/blob/main/docs/PLUGIN_INSTALL.md)。不要提交根模板为 skills-only 插件，官方当前不支持发布后补加 MCP。

## ChatGPT 连接与安装

依据[官方接入文档](https://developers.openai.com/api/docs/guides/custom-mcp-server)，在 ChatGPT web 的 **Plugins → 加号 → Add custom MCP server** 添加连接。账户/工作区权限可能限制此功能，以当前页面为准。首次直连不要求先提供离线包用的原始 app ID；需要用 `.app.json` 绑定已有 app 时，再使用前一阶段的离线打包命令。

1. 先完成目标机器上的服务部署与本地检查；ChatGPT 云端无法直接访问机器的 `127.0.0.1`。
2. 选择管理员已批准的 TLS 网关或页面支持的 Tunnel。若使用 Cloudflare Access Managed OAuth，按下文顺序先建立并验证专属入口，再在 ChatGPT 创建连接并取得实际 callback。
3. 按当前管理页显示的连接和认证方式推进 OAuth。ChatGPT 支持配置的 OAuth 客户端注册方式；不要假设有可输入自定义固定 API key 的认证选项。
4. 按当前页面创建并安装插件。在新对话中通过 `@pipro` 指定它；OAuth 用户授权可能在首次工具调用时启动。
5. 首次验收只调用 `list_workspaces` 并核对返回的 workspace 名字；若调用启动授权，由用户本人完成授权后让这次只读检查完成。创建、发消息和取消任务属于后续有副作用的操作，必须由用户明确要求；安装或 setup 不自动创建 pi 任务。

[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 可让受支持 OpenAI 产品访问私网 MCP，无需公开入站端口。若选择它，用户需自行审查官方客户端、授权和连接参数；本项目不下载/启动隧道、不保存其访问凭据。不能把本地 mock 测试当作隧道或 ChatGPT 实际接入成功。Tunnel/回环地址也不等于公开插件商店提交条件。

首次连接的只读验收指令：

> 使用 pipro，只调用 `list_workspaces` 并列出返回的 workspace 名字。不要创建任务、发送消息或取消任务。

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

### Cloudflare Access Managed OAuth

选择 [Cloudflare Access 配置示例](examples/config.cloudflare-access.example.json)中的 `auth.mode:cloudflare-access`。示例里的占位值会被拒绝，不能直接启动；正式值保存在被 Git 忽略的运行配置中。

| 字段 | 必须填写的实际值 |
|---|---|
| `issuer` | 团队的 `https://<team>.cloudflareaccess.com` origin，不带末尾 `/`、路径或端口 |
| `resource` | 该 MCP 的规范 HTTPS `/mcp` URL，无 userinfo/query/fragment |
| `audience` | 专属 Access 应用的 AUD，64 位小写十六进制；不是 resource URL 或客户端 ID |
| `allowedEmail` | 已明确批准的唯一用户邮箱，按 JWT 中的值精确匹配 |

此模式不接受 `jwksUrl`、`jwksFile`、`scope`、`allowedSubjects` 或额外字段。ChatGPT 客户端持有的是 Managed OAuth opaque token；Cloudflare 验证后向 origin 注入 `Cf-Access-Jwt-Assertion`。pipro 只校验该断言，`Authorization`、cookie 和明文邮箱 header 均不能代替它。[官方 token 流程](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

断言必须是单个、最多 16 KiB 的 compact JWT；重复 header 和逗号拼接拒绝。仅接受 RS256、必需 `kid`，拒绝 token 指定 `jku/x5u/jwk`。校验准确 issuer、应用 AUD、exp/iat、可选 nbf、非空 sub、email 与 `type:app`；时钟容差 5 秒，不套用旧 OAuth 的一小时 token age。组织 token、错误签名/时钟、service identity 均拒绝。任务 owner 仍从 issuer/sub 派生，刷新或 session nonce 改变不影响 owner。

每个服务只创建一个 jose remote JWKS resolver，公钥地址固定为 issuer 的 `/cdn-cgi/access/certs`。获取超时 5 秒、unknown-kid cooldown 30 秒、缓存 10 分钟，按 jose 的公钥轮换规则处理；不跟随重定向，获取失败时拒绝认证。origin 的缺失/无效断言返回 401，有效但被身份策略拒绝返回 403，不返回旧 `pi:control` challenge 或 discovery metadata。八个工具声明 `oauth2` 且 `scopes:[]`；旧 `oauth` 模式保持原契约。Host/Origin 检查继续启用。

正式接入顺序：

1. 先为专属 hostname 建立已获授权的 Access 应用和仅允许已批准身份的策略，启用该应用的 Managed OAuth。取该应用真实 AUD；不复制其他应用的 AUD、不添加 service-token/bypass 策略，也不预填 callback。
2. 在 Manjaro 上将 pipro origin 保持在回环地址，并配置只通向该回环端口的专属 Tunnel。不要改动其他应用、隧道路由或端口，也不要把 `auth:none` origin 暴露到公网。
3. 从公网验证未授权 MCP 请求得到 Cloudflare edge 的 401 与 `WWW-Authenticate` challenge；按 challenge 指向的实际地址读取并核对 OAuth/server discovery 与 resource metadata。确认它们来自预期专属入口后，才开始 ChatGPT 的 **Add custom MCP server** 创建流程。Cloudflare 文档说明 Managed OAuth 会为非浏览器客户端返回指向 discovery 的 401；普通浏览器登录 302、找不到 discovery、404/502 或超时都表示入口配置尚未通过。
4. 推进到本次连接的管理页，逐字读取其显示的 callback URI。若本次连接使用 Cloudflare Managed OAuth 的 DCR 模式，只在 DCR allowlist 中加入这个准确值，不使用 wildcard；其他客户端模式按实际配置检查，不假定会走 DCR。若管理页尚未显示 callback，或者流程要求先配置 callback/注册 OAuth client 才显示它，初始化在此阻塞；停止操作并记录界面限制，不猜 URI，也不声称后续会自动解决。
5. 仅当 authorization server 完整满足 RFC 9207 issuer identification 时，ChatGPT 才可能使用 stable callback：metadata 声明支持 issuer 参数、metadata `issuer` 与 protected-resource `authorization_servers` 完全相同，并且每个成功及错误授权响应都返回完全匹配的 `iss`。即使满足条件，也以本次管理页显示的确切 URI 为准；不在文档或表单预填 URI。
6. 按实际客户端模式继续：OAuth `client_id` 是客户端标识；DCR 时由授权服务器生成并复用，CIMD 时使用客户端 metadata 文档 URL 且没有客户端注册步骤，预定义客户端则使用已有注册值。若选择 DCR，先保存精确 allowlist；然后按当前 UI 创建并安装插件。OpenAI 文档说明 OAuth 用户授权在用户首次调用工具时启动；因此首次只读 `list_workspaces` 可能先触发本人授权，授权完成后仅让该只读调用通过。

错误定位：公网未授权请求的 401 + OAuth challenge 是预期边缘响应，不等于 DCR 或工具调用已通过；302 往往表示 Managed OAuth 未生效或请求没命中专属 Access 应用。403 表示访问策略拒绝当前身份，应核对获批身份策略；origin 报缺失/无效 `Cf-Access-Jwt-Assertion` 的 401 表示边缘没有给 origin 提供有效断言，不能绕过 edge。`invalid_client`、redirect mismatch 或 OAuth 注册失败时，核对当前连接的 callback、allowlist 和本次 DCR 客户端状态，勿扩大为 wildcard。

OpenAI OAuth 文档要求授权服务器正确发布 discovery、支持连接所选的 DCR/CIMD/预定义客户端方式、处理 PKCE，并在授权与 token 请求中传递 `resource` 且将其绑定到签发 token。Cloudflare 文档说明 Managed OAuth 支持 RFC 8707 客户端并由 edge 注入 Access JWT；本项目尚未验证 Cloudflare 对 ChatGPT 的 DCR、`resource` 绑定或真实 GPT 工具调用，因此即使 401/discovery 正常，也不能据此宣称 OAuth 流程完成。若 DCR/resource 校验不通或界面不给 callback，应明确报告初始化阻塞，不保证后续会自动解决。

本地签名 fixture 只证明 origin 的校验和隔离行为；真实 Cloudflare 边缘、TLS、OAuth grant 与 ChatGPT 连接还须现场验收。[Access application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)、[ChatGPT 认证要求](https://developers.openai.com/plugins/build/auth)

## 测试

```sh
npm run check
npm test
```

默认测试启动仓库内的 `test/fake-pi.js`、临时工作目录和回环 HTTP；真实 pi 测试默认跳过。OAuth/Access 签名私钥仅在内存，JWKS 使用临时公共 fixture；Access 测试拦截 fetch，不请求真实 Cloudflare。没有模型调用或用户凭据访问。

已有官方 pi v1.1.0 时，可显式执行真实生命周期回归：

```sh
PIPRO_REAL_PI=/absolute/path/to/pi npm test
```

`test/real-pi.test.js` 使用新临时 piHome/workspace 与过滤环境，只做无 prompt 的 get_state、clear_queue/abort、进程退出和 workspace 复用，不启动 MCP HTTP 或调用模型。该检查成功不代表模型任务或生产 OS 隔离已验收。

覆盖 JSONL byte LF/CRLF、碎片 UTF-8 与 U+2028/U+2029、乱序响应、`success:false`、畸形/过长/断流/无 ID 响应、启动/退出/超时、快完成竞态、handled/queued、完整取消与失败、进程组清理、workspace 互斥、owner 隔离、事件窗口、输出限制，以及 SDK HTTP 工具 schema/annotations 和 OAuth。

独立复审回归位于 `test/review.test.js`：真实 detached fixture 在 RPC 崩溃后继续写入时，workspace 仍隔离且重启/TTL 不解锁；pi 队列的数量/UTF-8 字节及发送中预留共同限额；缺少快照时保守保留容量；steer/followup 在 settled 竞态中启动新 run；新 run 保留 deadline；取消期间 prompt 超时不伪报 cancelled；原运行错误与后续清理错误分别保留；默认队列限额 8 和限额 1 下，立即发消息均以 TASK_NOT_READY 拒绝，初始 prompt 正常先执行且不误隔离。OAuth 另测试有效 token 缺 scope 返回 403。

`test/plugin.test.js` 新增验证两种包装结构、清单与文件引用、raw ID/URL/参数拒绝、显式 loopback、固定白名单、确定性字节输出、Git 忽略、已有目录/符号链接保护和失败时不留半成品。包装测试不运行真正的插件安装或认证。

本轮受限执行器里，普通 Node 子进程的 console.log、pi --version 和 RPC 都曾提前 exit 0 且无输出；Python 管道调用及经平台批准的正常进程环境调用成功。没有为此删除 detached 隔离、放宽失败状态或解除原隔离标记。复验遇到执行限制时，应报告具体动作，遵循平台审批，不绕过拒绝。

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
