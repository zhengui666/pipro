---
name: setup
description: 安装 pipro 后按源码/插件包、Manjaro 服务部署、ChatGPT 连接三个阶段引导首次接入，诊断实际连接错误并只读检查 workspace；setup 不创建 pi 任务。
---

按以下三个阶段引导用户。不要把源码安装、目标机器服务部署、ChatGPT 连接和安装描述成一次自动完成的安装。

## 阶段 1：源码或插件包

- 源码与离线打包只准备程序或绑定文件，不会部署服务、创建 ChatGPT MCP 连接、启动 Tunnel、注册 OAuth client 或授权用户。
- 首次 ChatGPT web 直连可以从 **Plugins → 加号 → Add custom MCP server** 开始，不要求先有原始 app ID，也不要生成虚构的 app ID 或一键安装链接。
- 已有 ChatGPT app 的离线绑定包才使用实际 app 的原始 app ID。原始 app ID 用于 `.app.json`；OAuth `client_id` 属于授权服务器的 DCR/CIMD 客户端注册；Cloudflare Access AUD 是 pipro 检查 Access JWT 的 audience。这三个值不能互换。
- 已有 desktop、本地 marketplace 和 workspace 导入命令及其前提见[正式仓库插件安装说明](https://github.com/zhengui666/pipro/blob/main/docs/PLUGIN_INSTALL.md)。Manjaro 服务和 Access 设置见[正式仓库 README](https://github.com/zhengui666/pipro/blob/main/README.md)。

## 阶段 2：Manjaro 服务部署

- 引导用户在目标 Manjaro 主机上按 README 配置 Node.js、官方 pi、隔离的 `piHome`、批准的 workspace 和 pipro 服务。origin 保持回环监听；不要要求或收集用户的模型凭据、Access token、私钥、真实域名或邮箱。
- 若采用 Cloudflare Access Managed OAuth，应先配置获批的专属 Access 应用、仅允许已批准身份的策略和 Managed OAuth，再配置专属 Tunnel 到回环 origin。保留既有 `Authorization: Bearer ...` + `pi:control` OAuth 用法及原有认证契约；不要把这条旧模式与 Cloudflare Managed OAuth 的 Access JWT 断言混为一谈。
- Cloudflare Managed OAuth 的客户端 opaque access token 由 edge 解析为用户身份，并以 `Cf-Access-Jwt-Assertion` 向 origin 提供签名断言。pipro 只校验该断言；不要让用户把 token 粘贴给你或绕开 edge 直连公网 origin。
- 在邀请 ChatGPT 创建连接前，从公网验证未授权 MCP 请求是否返回 401 和 `WWW-Authenticate` challenge，并从实际 challenge 读取 discovery 指向。核对实际 OAuth/server/resource metadata 的 hostname、resource 和端点；不要只看本地测试或手写假响应。

## 阶段 3：ChatGPT 连接与安装

- 只有边缘入口和 discovery 通过后，才指导用户在 ChatGPT web 开始创建 MCP 连接。空白表单可能还没有本连接的 callback；绝不要求用户从空表单提供 callback，也不预填固定 URI、wildcard 或猜测的 callback。
- 推进到本次连接管理页后，逐字读取页面当前显示的 callback URI，再由用户将这个确切值加入专属 Cloudflare Managed OAuth DCR allowlist。仅当授权服务器完整满足 RFC 9207 issuer identification（metadata 声明支持；`issuer` 与 protected-resource `authorization_servers` 完全一致；所有成功及错误授权响应均返回精确匹配的 `iss`）才可能使用 stable callback；即使如此，仍以当前管理页的实际值为准。
- 如果管理页没有显示 callback，或页面要求先配置 callback、完成 DCR、本人授权或安装才会显示，立即说明初始化阻塞并停止猜测。不要声称 ChatGPT、Cloudflare 或后续步骤会自动解决此循环。
- 精确 allowlist 保存后，继续页面实际要求的 DCR/CIMD/预定义 OAuth client 注册流程，并按当前 UI 创建、安装 plugin。OpenAI 文档说明 OAuth 用户授权在首次工具调用时启动；所以首次只读 `list_workspaces` 可能先打开本人授权流程，授权完成后只让这次只读调用通过。若当前 UI 没有用户要求的选项，按实际 UI 报告，不编造按钮或 URL。
- OpenAI OAuth 要求实际 discovery、PKCE 和 `resource` 在授权及 token 流程中的处理；Cloudflare 文档说明 Managed OAuth 支持 RFC 8707 客户端，但该环境的 DCR、`resource` 绑定和真实 GPT 工具调用尚未验收。challenge 或 metadata 可读不等于连接已完成，不能保证这些问题会自动解决。

## 错误诊断

| 现象 | 解释与下一步 |
|---|---|
| 未授权公网 `/mcp` 返回带 `WWW-Authenticate` OAuth challenge 的 401 | Cloudflare Managed OAuth 的预期边缘响应。沿 challenge 中实际指向读取 discovery；这本身不证明 DCR、resource、用户授权或 ChatGPT 工具调用成功。 |
| 302 浏览器登录跳转，或 401 没有 OAuth challenge | 检查请求是否命中专属 Access 应用、Managed OAuth 是否启用，以及 edge 是否返回其 challenge；不要把请求改为绕过 Access。 |
| `/.well-known/` discovery 404、无效或指向其他服务 | 检查专属 hostname、Tunnel 路由、Access 应用绑定和当前公布的 metadata。以实际 challenge/discovery 的 URL 为准，不发明 endpoint。 |
| 404、502 或连接超时 | 检查 DNS/专属 Tunnel 是否健康、Tunnel 是否映射到正在运行的回环 origin、路径是否为服务的 `/mcp`；不要公开 origin 或更改无关 Tunnel。 |
| 已登录后 403 | Access 身份策略拒绝该身份。由管理员核对实际获批的身份/策略；不要扩大 allowlist 或放入 service-token/bypass。 |
| origin 日志显示缺少或无效 `Cf-Access-Jwt-Assertion` 的 401 | edge 没有向 origin 提供有效 Access assertion，或 origin 配置不匹配。检查 Managed OAuth、Access 应用 AUD 和 Tunnel 请求路径，保持公网流量通过 edge。 |
| `invalid_client`、DCR 注册失败或 redirect/callback mismatch | 核对本次 ChatGPT 连接选用的客户端注册方式、授权服务器 discovery 和精确 callback allowlist；不要把 app ID、OAuth `client_id` 与 AUD 混用，也不要扩大为 wildcard。 |
| UI 不显示 callback | 初始化阻塞。保存当前错误/页面状态供管理员排查，并明确报告不能继续配置；不要预设 stable URI 或称之后会自动出现。 |

## 首次只读验收

连接已安装且 pipro 工具可用时，首次且唯一的 setup 工具调用是只读 `list_workspaces`，展示返回名字并说明它是只读检查；若它启动 OAuth，等待本人完成授权后让该只读调用完成。若工具不可用，说明 ChatGPT 连接/授权尚未完成；不要用另一个 app、shell 或机器代替验证，也不要宣称成功。

`create_task`、`send_message` 和 `abort_task` 有副作用。安装或 setup 不自动创建任务、发送 prompt 或取消任务。用户明确提出编码任务后才使用随包的 [control-pi](../control-pi/SKILL.md) 工作流。workspace 映射不是 OS 沙箱；`cleanup_unconfirmed` 表示可能有旧工具进程，需管理员检查。
