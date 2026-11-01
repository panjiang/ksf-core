# 我的 KSF 实例

首次使用时，让 Agent 读取根 AGENTS.md。从 Core 模板克隆的仓库先执行 `instance init --json` 验证来源并初始化，再重新取 context entry 进入孵化。你可以一次回复“叫我小林，你叫灵台，其余默认”，设置称呼、实例名、本机名称与登录启动，然后开始处理自己的事情。

工作台左上角 **KSF → 系统设置 → 快速上手** 提供常驻引导；完整说明见[快速上手](.agents/core/docs/quickstart.md)。关闭页面后后台继续工作，后续登录只启动后台。

这是从唯一的 `ksf-core` 来源初始化的个人 KSF 实例。复制或解压模板后，将目录命名为 `ksf` 或自己选择的名称，即可作为个人 KSF 用户实例使用。从模板创建私有仓库时，也可以使用 `ksf` 或自定义仓库名。

`ksf-core` 同时承接公共系统、模板与发行；个人实例使用自己的 `main` 保存正式内容，官方系统主线是 `core-main`。使用已有支持的平台模板包，无需预装 Node.js、Python、npm 或 Git。目录或仓库改名不影响系统运行、升级或贡献。

知识目录自带渐进导航、`rules/` 组织约定和可选认知模板。实际知识单元按自己的框架建立，认知主题可使用 `认知-名称/cognition.md`；模板没有真实主题。规则可编辑，后续 Core 升级保留定制。

收到模板文件夹后，按自己的名称保存为用户实例，用 Agent 打开该目录，让它读取根目录的 AGENTS.md 即可。终端入口是 `./.agents/ksf`，可运行 `./.agents/ksf --help` 检查。

- 项目、知识、能力、档案和收件箱保存你的正式个人内容。原始材料随目标保存，默认放在目标目录的 `资料/` 下；已有附属资料目录保持原位。一份原件有一个主归属，其他目标通过链接引用，正文保留来源、日期和原件入口。
- [知识根说明](知识/knowledge.md)与[档案根说明](档案/archive.md)定义本实例的组织、维护方式及分层导航，可依据 [Core 设计机制](.agents/core/docs/content-design.md)自行调整；新模板不含私人资料。
- 根 [USER.md](USER.md)、[BOT.md](BOT.md)分别保存用户稳定设定和 Agent 协作方式；runtime 处理任务前完整读取。两份只按明确授权修改，“只讨论、只读、不保存”时同样不写。模板不含私人设定，升级不覆盖或补写用户文件；详见[根协作约定](.agents/core/docs/runtime/user-collaboration.md)。
- `repositories/` 按需承载实际工程代码、文档和成果；父 KSF Git 忽略整个容器，各工程独立管理 Git。项目根卡保存事实与工作区入口，已有外部工程可原位关联。
- `.agents/core/` 是随包 Core；启动不会检查或安装新版。需要时明确要求 Agent 检查、预览或升级，也可手动运行 system 命令。
- `.agents/ksf` 是 macOS 固定入口；`.agents/ksf.ps1` 是 Windows PowerShell 入口。Windows x64 已接入 PowerShell bootstrap、随包 Node 与共享业务 CLI；实际功能验收按平台记录核对。
- `.agents/user-data/` 保存 KSF 程序自身的用户设置与必要状态，可随你的实例备份迁移；正常工作内容仍在正常用户空间。
- `.agents/runtime-data/` 保存本机缓存、升级备份、日志及贡献草稿。

你可以直接使用文件夹；希望远程备份时，也可以从官方模板创建自己的私有仓库。公开仓库的 fork 也会公开，存放个人资料时请选择自己的私有仓库。

已有项目根卡、需要开始产出工程文件时，可以创建并关联独立工程（需要本机 Git）：

```sh
./.agents/ksf repository create "工程名" --dry-run --json
./.agents/ksf repository create "工程名" --json
./.agents/ksf repository link "repositories/工程名" --project "项目名" --json
./.agents/ksf repository check --project "项目名" --json
```

仅建项目目标和讨论时无需创建工程。项目与工程可以多对多；归档项目或解除关联保留工程原位。工程内容与 Git 历史需由各工程自行备份。命令与边界见 [repository 说明](.agents/core/docs/cli/repository.md)。

系统操作：

```sh
./.agents/ksf system read --json
./.agents/ksf system check --json
./.agents/ksf system update --dry-run --json
./.agents/ksf system update --json
./.agents/ksf system rollback --json
```

升级保留个人目录、`.gitignore` 和用户修改；无法自动合并的系统修改会报告冲突，保留原系统。无网络时仍可使用已有版本。

想贡献系统修改时，告诉 Agent 具体要贡献什么。它先通过 `contribute prepare` 整理选定差异，展示将公开的内容，再通过 `contribute submit` 向 Core 发起 PR。贡献不携带你的个人 Git 历史；首次提交需要 GitHub 授权。

维护者可从[系统基础架构](.agents/core/docs/system/README.md)了解启动、CLI、数据目录和生命周期；完整发行说明在 `.agents/core/docs/distribution.md`。

入口与跨平台支持范围见 `.agents/core/runtime/launcher.md`。Windows 可运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .agents/ksf.ps1 launcher recover`；该调用只为本次进程指定策略，不修改全局设置。

系统级用户数据使用 `ksf user-data` 管理，说明见 `.agents/core/docs/cli/user-data.md`。新模板仅带通用的孵化 pending 初始状态，其他未配置项使用系统默认值；Core 升级不覆盖用户值。固定入口与首次设置见[孵化接口](.agents/core/docs/cli/incubation.md)。

完整阅读入口：[KSF 系统文档](.agents/core/docs/README.md)。工作台内可打开“系统文档”阅读与搜索；首次使用见[上手指南](.agents/core/docs/handbook/getting-started.md)。
