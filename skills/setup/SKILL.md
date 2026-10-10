---
name: setup
description: 安装 pipro 后按需引导源码/插件包、Manjaro 服务部署和 ChatGPT 连接三个阶段；已连接时只读检查 workspace，不创建 pi 任务。
---

## 已连接时先做只读检查

若当前 ChatGPT 连接已提供 pipro 工具，直接且仅调用一次 `list_workspaces`，展示返回的 workspace 名字，然后按文末约束结束 setup；不要再走未连接安装流程。若该调用启动 OAuth，由用户本人授权后让这次只读调用完成。

若 pipro 工具不可用，说明当前连接尚未完成，再按以下三个阶段引导用户。不要用另一个 app、shell 或机器代替 pipro 检查，也不要宣称连接成功。

## 阶段 1：源码或插件包

- 源码与离线打包只准备程序或绑定文件，不会部署服务、创建 ChatGPT MCP 连接、启动 Tunnel、注册 OAuth client 或授权用户。
- 首次 ChatGPT web 直连可以从 **Plugins → 加号 → Add custom MCP server** 开始，不要求先有原始 app ID，也不要生成虚构的 app ID 或一键安装链接。
- 已有 ChatGPT app 的离线绑定包才使用实际 app 的原始 app ID。原始 app ID 用于 `.app.json`；OAuth `client_id` 是 OAuth 客户端标识：DCR 时由授权服务器生成并复用，CIMD 时使用客户端 metadata 文档 URL 且没有客户端注册步骤，预定义客户端使用已有注册值；Cloudflare Access AUD 是 pipro 校验 Access JWT 的 audience。这三个标识不能互换。
- 已有 desktop、本地 marketplace 和 workspace 导入命令及其前提见[正式仓库插件安装说明](https://github.com/zhengui666/pipro/blob/main/docs/PLUGIN_INSTALL.md)。Manjaro 服务和 Access 设置见[正式仓库 README](https://github.com/zhengui666/pipro/blob/main/README.md)。

## 阶段 2：Manjaro 服务部署

- 引导用户在目标 Manjaro 主机上按 README 配置 Node.js、官方 pi、隔离的 `piHome`、批准的 workspace 和 pipro 服务；origin 保持回环监听。
- 不要要求用户在聊天中提供模型凭据、Access token 或私钥。可确认配置所需的域名和获批邮箱；取得相应授权后，可将它们用于指定的服务配置。公开文档不得包含用户真实域名、邮箱或秘密。
- 若采用 Cloudflare Access Managed OAuth，应先配置获批的专属 Access 应用、仅允许已批准身份的策略和 Managed OAuth，再配置专属 Tunnel 到回环 origin。保留既有 `Authorization: Bearer ...` + `pi:control` OAuth 用法及原有认证契约；不要把这条旧模式与 Cloudflare Managed OAuth 的 Access JWT 断言混为一谈。
- Cloudflare Managed OAuth 的客户端 opaque access token 由 edge 解析为用户身份，并以 `Cf-Access-Jwt-Assertion` 向 origin 提供签名断言。pipro 只校验该断言；不要让用户把 token 粘贴给你或绕开 edge 直连公网 origin。
- 在邀请 ChatGPT 创建连接前，从公网验证未授权 MCP 请求是否返回 401 和 `WWW-Authenticate` challenge，并从实际 challenge 读取 discovery 指向。核对实际 OAuth/server/resource metadata 的 hostname、resource 和端点；不要只看本地测试或手写假响应。

## 阶段 3：ChatGPT 连接与安装

- 只有边缘入口和 discovery 通过后，才指导用户在 ChatGPT web 开始创建 MCP 连接。空白表单可能还没有本连接的 callback；绝不要求用户从空白表单提供 callback，也不预填固定 URI、wildcard 或猜测的 callback。
- 推进到本次连接管理页，逐字读取页面当前显示的 callback URI。若本次使用 Cloudflare Managed OAuth DCR，先取得对这项精确 allowlist 配置的当次批准，再添加该值，不使用 wildcard；仅当配置工具不支持或用户明确要求自行操作时，才交由用户添加。其他客户端模式按实际配置处理，不假定会走 DCR。
- 仅当授权服务器完整满足 RFC 9207 issuer identification（metadata 声明支持；`issuer` 与 protected-resource `authorization_servers` 完全一致；所有成功及错误授权响应均返回精确匹配的 `iss`）才可能使用 stable callback；即使如此，也以当前管理页的实际 URI 为准。若页面没有显示 callback，或要求先配置/注册/安装才能显示，报告初始化阻塞并停止猜测；不声称后续会自动解决。
- 按当前 UI 完成对应的 OAuth 客户端方式：DCR 由授权服务器注册并生成 `client_id`；CIMD 以客户端 metadata 文档 URL 作为 `client_id`，没有客户端注册步骤；预定义客户端使用已有注册值。按 UI 创建并安装 plugin。OpenAI 文档说明用户授权在首次工具调用时启动，因此首次只读 `list_workspaces` 可能先打开本人授权流程；授权后只让该只读调用完成。
- OpenAI OAuth 要求实际 discovery、PKCE 和 `resource` 在授权与 token 流程中的处理；Cloudflare 文档说明 Managed OAuth 支持 RFC 8707 客户端，但该环境的 DCR、`resource` 绑定和真实 GPT 工具调用尚未验收。challenge 或 metadata 可读不等于连接完成，不能保证这些问题会自动解决。

## 错误诊断

| 现象 | 解释与下一步 |
|---|---|
| 未授权公网 `/mcp` 返回带 `WWW-Authenticate` OAuth challenge 的 401 | Cloudflare Managed OAuth 的预期边缘响应。沿 challenge 中实际指向读取 discovery；这本身不证明 DCR、resource、用户授权或 ChatGPT 工具调用成功。 |
| 302 浏览器登录跳转，或 401 没有 OAuth challenge | 检查请求是否命中专属 Access 应用、Managed OAuth 是否启用，以及 edge 是否返回其 challenge；不要把请求改为绕过 Access。 |
| `/.well-known/` discovery 404、无效或指向其他服务 | 检查专属 hostname、Tunnel 路由、Access 应用绑定和当前公布的 metadata。以实际 challenge/discovery 的 URL 为准，不发明 endpoint。 |
| 404、502 或连接超时 | 检查 DNS/专属 Tunnel 是否健康、Tunnel 是否映射到正在运行的回环 origin、路径是否为服务的 `/mcp`；不要公开 origin 或更改无关 Tunnel。 |
| 已登录后 403 | Access 身份策略拒绝该身份。由管理员核对实际获批的身份/策略；不要扩大 allowlist 或放入 service-token/bypass。 |
| origin 日志显示缺少或无效 `Cf-Access-Jwt-Assertion` 的 401 | edge 没有向 origin 提供有效 Access assertion，或 origin 配置不匹配。检查 Managed OAuth、Access 应用 AUD 和 Tunnel 请求路径，保持公网流量通过 edge。 |
| `invalid_client`、DCR 注册失败或 redirect/callback mismatch | 核对本次连接选择的客户端方式、授权服务器 discovery 和精确 callback allowlist；不要把 app ID、OAuth `client_id` 与 AUD 混用，也不要扩大为 wildcard。 |
| UI 不显示 callback | 初始化阻塞。保存当前错误/页面状态供管理员排查，并明确报告不能继续配置；不要预设 stable URI 或称之后会自动出现。 |

## setup 结束约束

- `list_workspaces` 成功后，只展示它返回的名字；可记录用户选择的 workspace。若返回多个名字且用户未指定，再询问选择；只接受 `list_workspaces` 返回的名称，不接受任意目录。
- `create_task`、`send_message` 和 `abort_task` 有副作用。pi 能写文件、执行命令并使用已配置的模型额度；workspace 映射只限制控制接口的工作目录，不是 OS 沙箱。安装、绑定或登录应用都不等于编码任务授权。
- 只读 setup 到此结束：不自动创建测试任务、发送 prompt、修改认证、开启正文、启动服务或 Tunnel、增加权限。用户另行要求编码任务时使用随包的 [control-pi](../control-pi/SKILL.md) 工作流；已有明确任务授权继续有效，不重复要求批准同一动作。
- 默认 `textWithheld:true` 只表示服务取得结果，不提供正文，也不能证明修改正确。`cleanup_unconfirmed` 表示旧工具可能仍在运行，需管理员检查；`processExited:true` 不能证明所有工具都已停止。
