# pipro 插件安装

pipro 的服务和插件包已有源码实现及 fake pi 测试，真实 pi v1.1.0 的无 prompt 生命周期也已验证。插件包把两个技能与一个已批准的 MCP 连接配在一起；生成器只写本地目录，不安装插件、不注册 app、不登录、不启动服务或隧道、不部署。**模型任务、ChatGPT 安装/调用、真实 OAuth/Cloudflare Access 边缘和 TLS 网关均未验收。**

源码根部 `plugin.json` 是待绑定模板，不应直接作为 skills-only 最终控制插件安装或提交。先选择下面一种模式，生成带真实连接绑定的包。官方目前不支持给已发布的 skills-only 插件补加 MCP；不要先发布空控制器。

## 选择并生成包

在 pipro 源码目录运行，Node.js 22+，无新增依赖/网络请求/构建下载。`--out` 必填，可为相对或绝对目录；已有非空目录拒绝，空目录可原子替换。输出祖先或来源文件有符号链接会拒绝。完成前只写同级临时目录，失败清理自身临时目录，不删除用户文件。嵌套输出的父目录可创建；运行时应使用可信父目录，不能把同一 OS 用户恶意并发改路径视为已解决的隔离问题。

ChatGPT 模式需要**已经注册、已获用户批准**的 MCP app 原始 ID。它写 `.app.json`，不写 `mcp.json`：

```sh
# 将 PIPRO_APP_ID 设置成你自己的原始 app ID；这里不提供或创建 ID。
npm run package:plugin -- --target chatgpt --app-id "$PIPRO_APP_ID" --out .pipro-plugins-chatgpt
```

接受 `asdk_app_`、`connector_`、`templated_apps_` 开头的原始 ID；拒绝 `plugin_` 开头的页面 ID、URL、空值和未知参数。界面 URL 中的 `plugin_asdk_app_...` 是插件页面标识，不要原样填入 `.app.json`。从注册连接的实际 app 信息取得原始 ID并核对对应连接；无法确定时先由管理员确认，不猜 ID或关联其它 app。包声明 `required:true`，安装仍需要用户拥有并连接该 app；它不会自行获得访问权。

Desktop 模式将**已有且已批准**的 HTTPS MCP 地址写入 portable `mcp.json`，不写 `.app.json`：

```sh
# PIPRO_MCP_URL 为你自己的已有 HTTPS 地址，路径必须是 /mcp。
npm run package:plugin -- --target desktop --mcp-url "$PIPRO_MCP_URL" --out .pipro-plugins-desktop
```

URL 禁止用户名/密码、query、fragment 和非 `/mcp` 路径。包不含 Authorization headers 或 token；OAuth 仍由现有 IdP 和安装客户端完成。后台 pipro 服务保持回环监听；已批准网关如何连接它按服务 README 配置，打包器不改变监听权限。

仅同一机器的 desktop 开发可显式放宽 HTTP：

```sh
npm run package:plugin -- --target desktop --mcp-url http://127.0.0.1:8787/mcp --allow-loopback-http --out .pipro-plugins-local-dev
```

HTTP 仅接受 `localhost`、`127.0.0.1`、`[::1]`，可带端口；该开关不启用服务、不公开端口、不配置 Tunnel。云端 ChatGPT 不能使用你机器的回环 URL。禁止把 `auth:none` 回环服务代理到公网。

两模式参数互斥，未知/重复/缺值参数均拒绝。原始 ID和 URL只验证格式，离线生成不能证明 app 存在、网络可达或账号授权。

生成目录结构：

```text
<out>/
  .gitignore                          # 整个绑定包默认忽略
  .agents/plugins/marketplace.json     # pipro-local，local source ./plugins/pipro
  INSTALL.md
  plugins/pipro/
    plugin.json
    skills/setup/SKILL.md
    skills/control-pi/SKILL.md
    .app.json                         # 仅 ChatGPT 模式
    mcp.json                          # 仅 Desktop 模式
```

清单 version 与 package.json 一致；两种连接文件始终只有一个。白名单只包含插件模板、两个技能、安装说明及生成的绑定/marketplace，不复制服务源码、用户配置、piHome、会话、凭据、node_modules 或任意项目文件。普通 `git add` 会忽略输出目录；不要把用户绑定包提交到 pipro 源仓库。即使 app ID或 endpoint 通常不是凭据，它们也可能标识内部服务。

## 从本地 marketplace 安装

需要支持 local marketplace 的 ChatGPT desktop/Work 或 Codex 客户端，并满足账号/工作区策略。生成器不会修改客户端设置。先审查生成的 JSON和 INSTALL.md，确认目标连接正确。

已有 Codex CLI 的用户可以手动添加这个**生成目录根**，不是 `.agents/plugins/` 子目录：

```sh
codex plugin marketplace add /absolute/path/to/generated-output
codex plugin marketplace list
```

然后按当前客户端文档重启 ChatGPT desktop，在 Plugins Directory 选择 `pipro-local`，打开 `pipro` 并安装/连接。也可将生成目录作为受信任项目的 repo marketplace 打开，由客户端发现它；不要直接覆盖个人已有的 `~/.agents/plugins/marketplace.json`。

客户端已识别 `pipro-local` 后，官方支持的 desktop 安装流程链接为：

```text
codex://plugins/install/pipro?marketplace=pipro-local
```

此链接只打开**已知 marketplace** 中的安装流程，不执行安装、不发送任务，也不是任意浏览器/ChatGPT web 都可用的一键按钮。找不到 marketplace 时会转到插件页；不要将它作为尚未导入的公开安装链接。完成上述前提后，可从该流程安装 pipro 并运行 setup。

## ChatGPT web 的工作区导入

web 的 GitHub marketplace 导入需工作区管理员，以及可读取包所在 GitHub 仓库的已授权账号。当前公开 pipro 源仓库没有你的连接绑定，也没有一个可直接导入的最终 marketplace。

只有管理员另行批准将**已绑定包**分发到专用、受控的 GitHub 仓库后，才按如下流程导入；本项目不推送该包，也不扩大 GitHub 权限：

1. 在 Admin → Plugins → Add → Import marketplace 填专用包仓库 URL，不填文件/branch URL。
2. 若生成包在仓库根，Path 留空；若在某个目录，填那个包根目录，不能填 `.agents/plugins/marketplace.json` 文件名。
3. Branch/tag/commit 选择已审版本；完成官方 GitHub 授权后查看 Import results。
4. 打开导入的 pipro，管理员审查安装策略和所需 app；成员仍需该 app 的使用权限和连接。

导入不会授予服务访问。安装/认证政策按工作区管理员设置，GitHub catalog 的 policy 字段不会替代工作区设置。

## 首次使用与验收

安装后的 setup 首先只读 `list_workspaces`，展示可用名字并说明副作用。安装和 setup 不自动创建测试任务、授权编码、发送 prompt 或取消别人任务。用户明确要求任务后，control-pi 才调用现有八个工具；保留 taskId、处理 `TASK_NOT_READY`，区分服务回执和 `agent_settled`。

`cleanup_unconfirmed` 需管理员检查旧进程/写入；不能因 `processExited:true` 创建新任务复用目录。`textWithheld:true` 表示正文未返回，不能编造结果。workspace 映射不是 OS sandbox。

安装包生成/结构测试与真实接入是不同验收项。用户可在批准的测试环境先验收只读 workspace，再按自己的明确任务授权验收创建、轮询与取消。源码测试结果不证明实际 ChatGPT 能发现/安装该包或真实 pi/模型已工作。

公开插件目录提交需要另行准备已验证的 HTTPS MCP、开发者身份/审核材料和官方审查。当前 `.app.json` 本地引用包不支持提交到公开目录；有 MCP 的正式提交初始包必须包含 `mcp.json`，不能提交根模板或回环开发包冒充正式可用插件。

## 官方依据

- [插件打包、portable 清单、onboarding、marketplace 与 MCP](https://developers.openai.com/plugins/build/plugins)
- [工作区 GitHub marketplace 导入](https://learn.chatgpt.com/docs/enterprise/plugin-management)
- [已知 marketplace 的 desktop deep links](https://learn.chatgpt.com/docs/reference/commands)
- [公开提交限制与审核流程](https://developers.openai.com/plugins/deploy/submission)
- [Agent Plugins manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)、[MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json)
