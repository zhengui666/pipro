---
name: setup
description: 安装 pipro 后确认现有 MCP 连接和可选 workspace，解释任务操作的副作用；安装本身不会创建编码任务。
---

首先通过 pipro 的 `list_workspaces` 做只读连接检查，展示返回的名字。若此连接的工具尚不可用，说明需要完成插件绑定/服务连接；不要用另一个 app、shell 或机器访问方式代替 pipro，也不要宣称已连接成功。

只读检查成功后说明：`create_task`、`send_message` 和 `abort_task` 有副作用。pi 可以写文件、执行命令、使用已配置模型额度；workspace 映射仅限制接口的工作目录，不是 OS 沙箱。安装、绑定或登录应用都不等于批准编码任务。

可以记录用户选择的 workspace 名字供后续任务使用。多个名字且用户未指定时再询问；不要接受任意目录、可执行程序、shell 配置或凭据值。

安装 setup 到此结束，不自动创建测试任务、发送 prompt、修改认证、开启正文、启动服务/隧道或增加权限。用户另行要求编码任务时，使用随包的 [control-pi](../control-pi/SKILL.md) 工作流；已有明确任务授权继续有效，不重复要求批准同一动作。

说明结果模式：默认 `textWithheld:true` 只证明服务取得结果，不提供正文，也不能证明修改正确。`cleanup_unconfirmed` 表示旧工具可能仍在运行，需管理员检查；RPC 的 `processExited:true` 不能证明所有工具停止。
