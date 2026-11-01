# CLI 命令文档索引

命令设计遵循[统一规范](../CLI命令设计规范.md)，可执行能力总入口见 [CLI 能力说明](overview.md)。各文档明确区分已实现与设计中。

程序分层、启动调用链、数据目录和维护入口见[系统基础架构](../system/README.md)。本目录继续持有各命令的具体接口契约。

## 已实现命令

| 命令 | 职责 | 文档 |
| --- | --- | --- |
| launcher recover | 无需 Core/Node 恢复中断升级 | [启动入口](../../runtime/launcher.md) |
| hello | 检查启动与输出链路 | [hello](hello.md) |
| app | 用户指定应用后读取包内 CLI 文档并调用 | [应用 CLI](../app-development/cli.md) |
| communication | 本机与内网消息、材料、Agent 收件及回执 | [公共通信](communication.md) |
| web | 前台调试主服务，提供工作台、应用和公共接口 | [web](web.md) |
| route | Agent 会话路由记录、版本检查与查询 | [route](route.md) |
| task | Codex 聊天任务逐轮原文、路由归档、Hooks 与补采 | [task](task.md) |
| chat | 当前聊天轮次、能力参与计数、动态变量与有界自动上下文 | [chat](chat.md) |
| runtime | 运行时完整校验 | [runtime](runtime.md) |
| build | 校验构建输入并生成 manifest | [build](build.md) |
| test | 随包 Node 执行 JavaScript 测试 | [test](test.md) |
| eval | 独立Agent自然语言项目、能力与资料采用批测、证据与评审 | [eval](eval.md) |
| incubate | 首次孵化草稿、完成、跳过及恢复 | [incubate](incubation.md) |
| assistant | 工作台投影及独立补采接口 | [assistant](assistant.md) |
| config | 配置目录、版本读写、应用状态与导出 | [config](config.md) |
| service | 独立主服务、诊断及登录自启动 | [service](service.md) |
| open | 确保主服务就绪并打开工作台 | [open](open.md) |
| source | 独立Git能力源关联、检查及导出 | [source](source.md) |
| user-data | 系统设置、本地身份、能力源关联及对象配置／必要状态 | [user-data](user-data.md) |
| metadata | 任意 Markdown frontmatter 管理 | [metadata](metadata.md) |
| context | 返回固定运行入口及能力发现上下文 | [context](context.md) |
| incubate | 首次设置、预检提交、恢复与明确跳过 | [incubation](incubation.md) |
| project | 项目根卡与目录的基础管理 | [project](project.md) |
| repository | 本地独立 Git 工程创建、项目关联与检查 | [repository](repository.md) |
| instance | 从 Core 模板验证来源并初始化个人实例 | [instance](instance.md) |
| release | 单一 Core 发行构建与发布 | [release](release.md) |
| system | 工作区版本检查、升级、恢复和回滚 | [system](system.md) |
| contribute | HEAD 已提交系统修改的审查与 Core PR | [contribute](contribute.md) |
| commit-message | 提交信息格式检查与填写模板 | [commit-message](commit-message.md) |
| pr-description | PR 标题、正文格式检查与模板 | [pr-description](pr-description.md) |
| cooperation | 协同对象管理 | [cooperation](cooperation.md) |
| partner | 搭档对象管理 | [partner](partner.md) |
| competency | 基本功对象管理 | [competency](competency.md) |
| data-package | 数据包对象管理 | [data-package](data-package.md) |
| 无参数、--help、-h | 帮助选项 | [help](help.md) |

四类对象共用 list/read/write/remove/check，完整参数、输出、目录派生、用户接管、版本解析、发布与异常规则集中维护在[对象命令公共规则](objects.md)，各类型文档补充具体入口与边界。公共字段以[对象元数据规范](../对象元数据规范.md)为准，不重复维护字段契约。

CLI 适配、对象服务、目录/契约/解析/发布模块分开。对象层复用 metadata 底层，不启动其他 CLI 子进程共享业务逻辑；metadata 自身不承担对象生命周期规则。

## 能力源

[source](source.md) 管理独立 Git 能力源的声明、直接关联、多源检查与个人对象贡献导出；Git 更新、提交和 PR 按正常仓库流程执行。

## 后续能力

`context entry` 按实例孵化状态返回固定 Core 工作要求；`context capabilities` 复用对象服务，一次提供完整有效的协同和搭档摘要。项目基础命令与 Codex 聊天任务归档已实现；知识管理命令尚未形成确定接口。

## 调用与维护

Core 开发仓库与发行工作区在 macOS 调用 `.agents/ksf`，Windows 对应 `.agents/ksf.ps1`（已接入随包运行时和共享业务CLI）；其他 cwd 使用入口绝对路径。没有默认安装全局别名。普通路径基于入口定位的 KSF 根。固定入口先恢复已发起的中断事务；启动和普通命令不检查或安装新版本，维护命令只显式调用，详见 system。

共同启动可能准备 `.agents/runtime-data/runtime/`，因此命令自身只读或预览不代表整个启动过程零写入。新增或变更接口时同步对应文档、公共规范、索引和能力说明，并运行相应回归、构建及真实入口验证。通过检查不代表获准提交或发布 Git。

Assistant 的同源桌面读取与独立补采接口见 [assistant](assistant.md)。
