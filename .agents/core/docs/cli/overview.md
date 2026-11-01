---
type: cli-reference
status: active
reviewed_for: "0.3.0-development"
updated: 2026-10-27
---

# KSF CLI 能力说明

文档导航见 [CLI 命令索引](index.md)；后续接口设计遵循 [CLI 命令设计规范](../CLI命令设计规范.md)。本文记录当前已实现行为。

启动器、CLI 服务分层、runtime-data、user-data 及构建发行的关系见[系统基础架构](../system/README.md)。

首次入口通过 `ksf context entry --json` 按实例状态返回孵化指导或正常 runtime；`ksf incubate read/write/finish/skip` 管理首次设置与恢复，见[孵化接口](incubation.md)。入口查询不初始化配置、不启动后台、不打开页面；旧实例缺少孵化状态时继续正常使用。新手说明见[快速上手](../quickstart.md)。

KSF CLI 当前提供启动准备、运行检查、manifest 构建、JavaScript 测试、项目基础管理、独立工程仓库管理、能力源直接关联与分享、Markdown 元数据、四类能力对象管理与能力上下文组织能力。本文件作为 CLI 能力总入口，记录可执行命令、输入输出、文件影响和实现范围。新增命令或改变行为时，在这里同步更新，再链接到对应的实现说明。

项目筛选、知识读取及已授权资产维护由 ksf-runtime 的三项运行基本功组织，使用 project 等现有 CLI 与宿主文件工具，见[最小运行闭环](../runtime/minimal-runtime.md)。项目 CLI 不代替 Agent 的归属判断，也不提供自动项目绑定、知识语义索引或跨文件事务服务；运行基本功纳入固定系统对象保护。

KSF 系统版本以 [manifest.yaml](../../manifest.yaml) 为准，随包 Node.js 当前为 `24.21.0`。当前随包目标为 **macOS ARM64 与 Windows x64**，共用业务CLI，原生入口、进程与文件适配分别验证；其他架构与Linux没有完整发行验收结论。支持与实测范围见[平台边界](../runtime/platforms.md)。

## 调用入口

以下命令在 `ksf-core` 仓库根目录执行：

```sh
.agents/ksf --help
.agents/ksf hello --json
```

从其他目录调用时，使用该入口的绝对路径。本文命令示例采用 macOS Shell 入口；Windows 入口、可用范围及转交契约见[启动入口](../../runtime/launcher.md)。当前没有安装全局 `ksf` 命令或别名，也不要求预装 Node.js、npm 或 Python。首次启动使用 macOS 自带工具校验和解压仓库中的 Node.js 包，不额外联网下载。

发行工作区统一调用 `.agents/ksf`。固定入口先恢复已发起的中断事务；启动和普通命令不检查远程版本或安装更新，升级只能显式发起。只读/预览命令仍可能准备本地随包运行时。KSF 生命周期由 ksf-maintainer 及四项维护基本功承接，协议和文件归属见[发行说明](../distribution.md)。

除无需 Core/Node 的 `launcher recover` 外，其他调用都会经过启动准备，包括帮助命令和测试命令。因此，首次调用或运行时需要修复时，可能先写入 `.agents/runtime-data/runtime/`。命令表中的文件影响指命令自身的行为，不包含这项共同的启动准备。

本地 SDK v1 开发实现新增 [app](../app-development/cli.md) 与 [communication](communication.md)，通过独立主服务工作；显式业务调用会先确保后台就绪。前者路由同一应用包内的 CLI；后者供 Agent 直接收发消息，未正式发行。

## 已实现命令总表

| 命令 | 能力 | 支持 JSON | 命令自身的文件影响 |
| --- | --- | --- | --- |
| 无参数、`--help`、`-h` | 显示帮助和当前命令列表 | 否 | 无 |
| `launcher recover` | 固定入口独立恢复中断事务，无需 Core 或 Node | 否 | 按事务恢复系统并归档；无事务时不写入 |
| `hello` | 输出 `Hello, KSF!`，检查调用链是否可用 | 是，`hello --json` | 无 |
| `web` | 前台启动任务路由工作台、只读接口与健康接口，随包 Node 提供预构建前端 | 是，`web --json` 输出一次就绪结果 | 已启用时补采对话档案；请求只读；停止后释放端口 |
| `route start/write/read/list` | 按原生宿主会话保存 Agent 明确报告的项目与能力安排，查询来源变化 | 是 | 仅 start/write 写入本地 routing/v1；开关关闭或 no-save 时跳过 |
| `task list/read/sync/status/hooks/declare/hook` | Codex 聊天任务归档、只读声明、Hooks 与补采 | 是 | 查询与 declare 只读；hooks 配置并建立未来基线；sync/hook 保存原件与游标，见 [task](task.md) |
| `chat hooks/read/context/use/write/remove/restart` | 当前聊天轮次、能力参与轮次、动态变量与有界自动状态注入 | 是 | hooks 建未来基线，原生 Hook 登记聊天计数并只读注入状态；read/context 只读，采用及修改仍显式执行，见 [chat](chat.md) |
| `runtime verify` | 完整验证随包压缩包及已安装 Node；损坏时可重新准备 | 是，`runtime verify --json` | 可能更新安装记录或修复运行时 |
| `build` | 校验构建输入和各平台包，生成 manifest | 是，`build --json` | 原子替换 `.agents/core/manifest.yaml` |
| `test` | 使用随包 Node 的内置测试运行器执行 JavaScript 测试 | 否 | 测试创建独立临时目录并在结束后清理 |
| `eval check/run/read` | 显式的独立Agent自然语言项目、能力与资料采用评测，运行与判分分开 | 是 | check仅临时探针；run调用Codex并保存隔离材料与报告；read只读历史 |
| `context capabilities` | 一次组织完整有效的协同、搭档发现描述 | 是 | 命令自身只读，不生成索引 |
| `project list/read/write/remove/check` | 项目根卡与目录的基础管理 | 是 | write 创建或更新根卡；remove 删除整个项目目录；修改支持预览 |
| `repository create/link/unlink/list/check` | 独立本地 Git 工程与项目关联 | 是 | create 初始化工程；link/unlink 只改根卡；修改支持预览 |
| `instance init` | 校验 Core 来源、补齐用户种子、本地分支 main | 是 | 支持预览；不提交、推送或改 origin |
| `release build/publish` | 构建单一 Core 更新包与索引，发布 Core Release | 是 | build 写指定输出；发布写远程；修改支持预览 |
| `system read/check/update/sync/rollback` | 安装版版本、Release 升级、恢复及回滚 | 是 | update/rollback 修改系统并保留备份；sync 记录检查；支持预览 |
| `contribute prepare/read/submit` | HEAD 已提交系统差异的审查和干净 Core PR | 是 | prepare 读取 HEAD 及固定远程原版并提示既往 PR；submit 核对基线与重复内容后发布；未提交内容忽略 |
| `commit-message check/template` | 检查完整提交信息格式或读取填写模板 | 是 | 命令自身只读，不修改 Git hook 或配置；语义和证据另行审阅 |
| `pr-description check/template` | 检查 PR 标题及四项正文，或读取模板 | 是 | 命令只读；贡献 prepare 强制校验独立 PR 正文，来源说明一并冻结；不验证语义和证据 |
| `user-data list/read/write/remove/check` | 系统命名空间及四类对象持久数据；支持 --object / --objects | 是 | 写入用户专属目录；支持预览和 etag 冲突检查 |
| `config list/read/check/write/reset/apply/export` | [统一配置中心](../configuration-center.md)：工作台与 CLI 共用领域规则 | 是 | 静态读取零初始化；写入需要版本，运行设置按需连接后台 |
| `metadata read/write/remove/check` | 任意 Markdown 的 YAML frontmatter 管理 | 是，各操作支持 --json | write/remove 可能更新明确指定文件，支持 --dry-run |
| `cooperation / partner / competency / data-package` | 各自提供 list/read/write/remove/check | 是 | 只写用户对象；首次修改系统对象派生完整目录；删除包含附件及基线；支持预览 |

`--json` 是上述指定命令的选项，不是全局选项。project、context、metadata 与四类对象的参数及统一结果协议见各自说明；现有其他命令保持原协议。当前不支持自定义 manifest 输出路径、测试过滤参数、自动递增版本或其他未列出的参数。多余参数、重复选项及未知命令会返回参数错误。

## 帮助和连通性检查

### 帮助

```sh
.agents/ksf
.agents/ksf --help
.agents/ksf -h
```

三种调用都输出帮助文本。普通启动依赖合法的 manifest；manifest 缺失或损坏时，帮助命令也可能在启动阶段失败，此时使用 `build` 重建。

### Hello World

```sh
.agents/ksf hello
.agents/ksf hello --json
```

普通输出为 `Hello, KSF!`。JSON 输出的字段如下；示例中的路径是占位值：

```json
{
  "ok": true,
  "command": "hello",
  "message": "Hello, KSF!",
  "runtime": {
    "nodeVersion": "v24.21.0",
    "nodePath": "/path/to/ksf-core/.agents/runtime-data/runtime/node/<installed-id>/bin/node",
    "ksfRoot": "/path/to/ksf-core/"
  }
}
```

`nodePath` 是本次真正执行 CLI 的 Node 路径，`ksfRoot` 是由入口解析出的工程根目录。这个命令验证启动和输出链路，不执行任务路由，也不代替完整运行时校验。它目前不直接返回 KSF 系统版本；系统版本读取 manifest 的顶层 `version`。

## 启动准备和运行时校验

### 自动启动准备

调用顺序为：

```text
ksf 程序入口 → bootstrap 准备 Node → Node 执行 JavaScript CLI → 指定命令
```

bootstrap 是不依赖 Node 的启动准备层，整个过程由固定程序执行。普通命令读取 manifest；`build` 读取独立的构建配置，避免依赖它将要生成的文件。

| 场景 | 自动处理 |
| --- | --- |
| 首次运行，没有已安装 Node | 校验压缩包，临时解压，验证 Node，写入安装完成记录并发布安装目录 |
| 安装记录匹配，Node 文件属性一致 | 快检后直接启动；不重新计算压缩包或 Node 的 SHA256，也不额外运行 `node --version` |
| Node 文件属性变化 | 完整验证 Node；验证通过时更新记录，失败时重新准备 |
| Node 或安装记录丢失、损坏 | 从随包压缩包重新准备 |
| manifest 中 Node 版本或压缩包校验值变化 | 选择新的安装身份，准备并使用对应版本，保留旧版 |
| 并发调用需要准备同一版本 | 使用安装锁，取得锁后再次检查，复用已完成的安装 |
| 准备被中断 | 半成品不视为有效安装；同一安装身份再次准备时恢复遗留锁并清理其临时目录 |
| 包校验或安装失败 | 返回错误，业务命令不执行，不自动改用旧版或全局 Node |

安装身份由 **Node 版本、平台、压缩包 SHA256** 共同确定。只修改 KSF 系统版本或 JavaScript 源码，可以继续使用已有 Node。

快检通过文件属性识别常见缺失和修改；它不等于每次验证全部文件内容。安装锁等待有时限，当前机制用于本机文件系统。实现和清单格式见 [bootstrap.md](../../runtime/bootstrap.md)。

### 完整校验

```sh
.agents/ksf runtime verify
.agents/ksf runtime verify --json
```

即使已有可用安装，这个命令仍计算压缩包和 Node 的 SHA256，并要求 Node 返回声明的精确版本。Node 损坏时可以重新准备；压缩包缺失或与声明不符时会报错。

普通成功输出为 `KSF runtime verified.`。JSON 返回 `ok`、`command: "runtime verify"` 和 `runtime`；其中 `runtime` 的三个字段与 `hello --json` 相同。

## 构建 manifest

```sh
.agents/ksf build
.agents/ksf build --json
```

构建输入在 [build.json](../../build.json)，生成结果在 [manifest.yaml](../../manifest.yaml)。配置中维护 KSF 版本、精确 Node 版本、平台包路径和可信的官方压缩包 SHA256；可执行文件的 SHA256、构建时间和源码信息由脚本计算。manifest 不由 Agent 填写，也不手工修改。

当前生成的信息包括：

- KSF 名称和版本，以及 Node 版本、分发方式和 CLI 路径。
- 各平台包的路径、压缩包 SHA256、Node SHA256 和来源 URL。
- UTC 构建时间、当前 Git 提交和工作区是否有修改。
- 构建配置摘要、系统源码摘要、工具链、生成器 Node 版本和目标平台。

没有 Git 提交时，`source_revision` 为 `null`；没有可用 Git 仓库信息时，相关状态保留为 `null`。源码摘要覆盖系统资产和根入口，用户项目、知识和运行数据不纳入该摘要。

`build` 能在 manifest 缺失或损坏时启动，并校验所有声明的平台包。所有检查通过后，才原子替换生成文件；失败保留原 manifest。普通调用不触发构建。

普通成功输出指出生成文件的位置。JSON 返回：

| 字段 | 含义 |
| --- | --- |
| `ok` | 成功时为 `true` |
| `command` | 固定为 `build` |
| `manifestPath` | 生成文件的绝对路径 |
| `manifest` | 完整生成对象，包含 `name`、`version`、`runtime`、`build` |

当前构建命令负责校验和生成 manifest，不编译 Node、打包完整发行版、下载升级、执行 Git 提交或发布。具体字段来源和升级步骤见 [build.md](../../runtime/build.md)。

## JavaScript 测试

```sh
.agents/ksf test --suite quick
```

入口先准备随包 Node，再使用同一个可执行文件运行内置 `node:test`。默认执行快速档；全量显式 `--suite full`。支持组件、变更、文件、分片、JSON 和只读计划，详见 [test 命令](test.md)及[统一测试规范](../testing.md)。失败和输入变化均不能作为通过证明。

测试数量以源码和本次命令实际输出为准。当前覆盖文件：

| 测试文件 | 覆盖范围 |
| --- | --- |
| [bootstrap.test.js](../../runtime/tests/bootstrap.test.js) | 启动、快检、修复、并发与中断恢复 |
| [build.test.js](../../runtime/tests/build.test.js) | 构建输入、校验值、源码摘要与失败保留 |
| [cli.test.js](../../runtime/tests/cli.test.js) | 原有帮助与测试入口行为 |
| [metadata.test.js](../../runtime/tests/metadata.test.js) | 元数据类型、保真、无变化、预览、锁和文件发布 |
| [metadata-cli.test.js](../../runtime/tests/metadata-cli.test.js) | 参数、结果协议、帮助、错误与跨工作目录调用 |
| [objects.test.js](../../runtime/tests/objects.test.js) | 四类生命周期、完整派生、基线、接管/版本、引用、并发及删除恢复 |
| [objects-cli.test.js](../../runtime/tests/objects-cli.test.js) | 四类命令、帮助、读取模式、异常、旧类型拒绝与跨工作目录输入 |
| [context.test.js](../../runtime/tests/context.test.js) | 两类有效集合、描述保真、覆盖回退、固定入口、不完整结果与只读行为 |
| [context-cli.test.js](../../runtime/tests/context-cli.test.js) | context 帮助、参数、文本和 JSON、退出码与跨工作目录调用 |
| [minimal-runtime.test.js](../../runtime/tests/minimal-runtime.test.js) | 真实运行定义、固定保护、精确依赖与隔离根调用 |
| [projects.test.js](../../runtime/tests/projects.test.js) | 项目发现、根卡读写、字节保留、预览、路径、锁、并发和删除恢复 |
| [projects-cli.test.js](../../runtime/tests/projects-cli.test.js) | 项目帮助、参数、结果、部分失败、退出码与跨工作目录输入 |

启动状态变化使用小型可执行夹具模拟不同 Node 版本，并调用真实启动器；构建测试另包含官方随包 Node 的完整调用。测试通过的范围是当前 macOS ARM64 实现，不代表其他平台或后续业务能力已验收。

## 项目基础管理

```sh
.agents/ksf project list --json
.agents/ksf project read "KSF运行机制测试" --part all --json
.agents/ksf project write "新项目" --data '{"body":"# 新项目\n\n项目目标。\n"}' --dry-run --json
.agents/ksf project check --json
```

项目目标是 `项目/` 下的单层目录名，根卡为普通 Markdown。list 返回浅层摘要，read 按 metadata/body/all 读取；write 以 metadata/body 信封创建或更新根卡，新建必须提供 body。元数据按顶层合并，提供 body 时整体替换正文，其他资料不动。remove 会删除整个指定项目目录，支持预览。可选 routing 保存四类能力偏好，独立知识路由已退役；write 校验结构，read 保留原始值，check 检查路径、编码、frontmatter 和逐项预设可用性，保留部分结果，不验证业务语义或扫描正文所有链接。完整参数、异常、锁和文件影响见 [project 命令说明](project.md)。

## Markdown 元数据管理

```sh
.agents/ksf metadata read notes.md --fields title tags --json
.agents/ksf metadata write notes.md --data '{"title":"设计笔记"}' --dry-run --json
.agents/ksf metadata remove notes.md --fields obsolete draft --json
.agents/ksf metadata check notes.md --json
```

文件参数及 --from 的相对路径基于 KSF 根目录，绝对路径直接使用。支持普通 YAML 字段映射，保留 Markdown 正文；不是对象契约校验或知识整理命令。完整规则、文件影响、限制、JSON 字段和错误码见 [metadata 命令说明](metadata.md)。

project、context、metadata 与四类对象的业务成功与失败 JSON 都进入 stdout，采用 ok、command、operation、data、errors 结构。下节的原有单 error／stderr 协议继续适用于旧命令；这些新增命令的日志和启动层错误仍在 stderr。启动准备尚未完成时不保证业务 JSON 已产生。

## 独立工程仓库

`repository create <工程名>` 在用户根 repositories 下建立同名独立 Git 工程，默认 main，无初始提交及远程；`link/unlink <工程路径> --project <项目目录名>` 维护根卡可选 repositories 路径列表；`list/check` 默认检查容器，--project 检查已保存关联及外部工程。修改支持 --dry-run，所有操作支持 --json。项目与工程允许多对多，已有工程原位关联。仓库操作需要本机 Git，普通启动无需 Git。归档、解除关联及删除项目记录均保留工程。完整契约见 [repository](repository.md)。

## 四类能力对象

```sh
.agents/ksf cooperation list --json
.agents/ksf partner read partner.ksf.object-designer --part all --json
.agents/ksf competency check competency.ksf.partner-design --json
```

四类对象共用 list/read/write/remove/check。默认 source=effective，用户 draft/active 接管同 ID 系统定义，archived 退出接管；精确 id@version 按个人、匹配能力源、系统解析；多源歧义不猜选，源内依赖按来源绑定。固定入口链始终使用指定系统定义。

read 可选 metadata/body/all，默认 all；不展开附属资源。write 只修改用户区，系统对象首次修改时派生完整承载目录和 .upstream/ 基线；user_revision 记录实际用户变更，派生版保留来源 version。remove 物理删除整个用户目录。发布前检查引用与并发，预览不发布变化。

公共输入输出、错误、目录与文件影响见[对象命令公共规则](objects.md)，各类型入口见[命令索引](index.md)。对象管理不运行 Agent 或执行对象正文，程序契约检查不评价正文专业质量。基本功统一承载专业方法与具体执行操作，按需直接使用程序和资料。`context capabilities` 已组合有效协同与搭档摘要，供 Agent 新路由时一次取得。

## 能力上下文

```sh
.agents/ksf context capabilities
.agents/ksf context capabilities --json
```

一次组织全部有效 Cooperation、Partner 的名称、原始 description、ID、定义路径和固定入口标记，按两类分组。覆盖、归档及身份解析由对象服务处理；可用--source明确限定能力源，不改写摘要或展开正文。固定入口保留，ability-route 在下游匹配时排除。

各组保留完整性及错误。部分失败返回退出码 1，仍需读取 stdout；缺口不能被当作“无匹配”。程序组织数据，明确指定、有效安排、适用项目预设优先，全局协同/搭档及通用 Agent 承接仍由 ability-route 判断；项目预设不改变全局发现集合。完整协议见 [context](context.md)。

## 输出和错误处理

旧命令的成功业务结果写入 `stdout`。启动准备日志和旧命令错误写入 `stderr`，不会混入成功的 JSON 输出。自动调用时，先判断进程退出码，再解析结果。

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功 |
| `1` | 常见的启动、构建、校验或测试失败；测试命令也会传递测试运行器的退出码 |
| `2` | CLI 命令或参数不支持 |

启动过程被信号中断时，还可能返回信号对应的退出状态。不是所有失败都来自 JavaScript CLI：即使提供 `--json`，bootstrap 阶段仍可能返回纯文本错误和系统工具信息，调用方不能假设 `stderr` 始终是 JSON。

原有命令在 JavaScript 层的 JSON 错误使用以下结构；project、context、metadata 与四类对象使用各自说明中的统一结果结构：

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENTS",
    "message": "Unsupported command or option. Run 'ksf --help'."
  }
}
```

主要错误类别：

| 错误标识 | 含义和处理方向 |
| --- | --- |
| `INVALID_ARGUMENTS` | 对照帮助修正命令或选项 |
| `UNSUPPORTED_PLATFORM` | 当前平台没有对应启动支持 |
| `MANIFEST_INVALID` | 运行声明不合法或缺少平台包声明；用有效构建输入执行 `build` 重建 |
| `BUILD_CONFIG_INVALID` | 修正构建输入的结构、版本、包路径或可信校验值 |
| `ARCHIVE_MISSING`、`ARCHIVE_INVALID` | 恢复匹配版本的完整压缩包及正确的校验声明 |
| `NODE_INVALID` | 解压得到的 Node 校验值或版本不符合要求 |
| `INSTALL_FAILED` | 临时解压或发布安装目录失败，检查磁盘和文件权限 |
| `LOCK_UNAVAILABLE`、`LOCK_TIMEOUT` | 本机锁工具缺失或等待安装锁超时 |
| `CLI_MISSING` | 声明的 JavaScript 入口文件缺失 |
| `BUILD_INPUT_CHANGED` | 构建期间输入发生变化，稳定工作区后重新构建 |
| `BUILD_SOURCE_INVALID`、`BUILD_OUTPUT_INVALID` | 系统源码或输出文件不符合构建约束 |
| `BOOTSTRAP_REQUIRED` | 完整校验应通过 `ksf` 入口调用 |

底层文件系统等错误还可能返回系统错误标识，以上表格不是所有异常的穷举。

## 文件归属和调用边界

| 位置 | 用途 | 维护方式 |
| --- | --- | --- |
| [程序入口](../../../ksf) | 定位根目录，调用 bootstrap 和随包 Node | 程序源码 |
| [CLI 源码](../../runtime/src/cli.js) | 命令分发、结果输出和退出码 | 程序源码 |
| [构建配置](../../build.json) | 维护版本和可信包声明 | 构建输入 |
| [manifest](../../manifest.yaml) | 当前发行的运行声明和构建元数据 | `ksf build` 生成 |
| `.agents/core/runtime/packages/` | 保存随仓库分发的官方压缩包 | 发行资产，可随 Git 提交 |
| `.agents/runtime-data/runtime/` | 已安装 Node、安装记录、锁和临时文件 | CLI 自动维护，不入 Git |
| `.agents/runtime-data/objects/write.lock` | 跨类型对象写锁 | 服务维护，不入 Git；遗留锁需检查后处理 |
| `.agents/runtime-data/projects/write.lock` | 项目写入与删除锁 | 服务维护，不入 Git；遗留锁需检查后处理 |
| `.agents/runtime-data/repositories/write.lock` | 工程创建锁 | 服务维护，不入 Git；遗留锁需检查后处理 |
| `repositories/` | 独立工程容器，父 KSF Git 忽略，子工程各自 Git 管理 | 用户工程；不进入发行、升级或回滚范围 |
| `能力/<类型目录>/<完整ID>/.upstream/` | 用户派生对象的完整来源快照及摘要 | 用户资产，可备份迁移；普通更新不覆盖 |

用户或 Agent 统一调用 `ksf` 程序入口。运行时准备、校验、构建和测试由程序执行；Agent 不负责手动解压 Node、选择安装目录或填写生成字段。普通项目、仓库、对象和元数据命令不执行 Git 提交或推送；repository create 仅初始化选定工程的本地 Git。发行版根据 Release 更新，不运行 `git pull`；显式 release 发布及 contribute 提交会按各自契约写远程，不能由普通业务写入隐式触发。

## 后续业务能力状态

以下能力尚未进入可执行命令列表，不应作为当前 CLI 能力调用：

| 能力 | 当前状态 |
| --- | --- |
| 其他上下文组装操作 | 当前仅实现 context capabilities；正文与关联资料仍按需读取 |
| 四类对象专业正文契约与质量判断 | 公共对象契约及本地精确引用已实现；专业适用仍由 Agent 判断，质量需真实任务验证 |
| 路由记录与逐轮声明 | route及task declare已实现；语义交接仍由Agent履责 |

理解用户目标、判断协同适用性和澄清歧义属于 Agent 的判断职责。对象 CLI 已提供确定性列举与校验支持，不把程序检查成功等同于业务路由适用。

## 后续维护方法

新增命令或改变行为时，同步更新命令总表、参数和输出、文件影响、错误说明以及测试链接。将能力从“待实现”移入“已实现”之前，检查真实命令行为和相关测试；更新本文的审阅版本与日期。

实现细节保留在源码、[bootstrap.md](../../runtime/bootstrap.md) 和 [build.md](../../runtime/build.md)，本文件维护调用者需要的完整能力入口。修改系统资产后通过 `ksf build` 刷新构建摘要，再按变更范围执行校验和测试。

## 系统级用户数据

`.agents/user-data/` 保存 KSF 程序和能力对象的用户设置与必要状态，和本机 `.agents/runtime-data/` 分离。它随用户实例保留，Core 发行不复制个人值，升级与回滚不覆盖。正常工作产生的项目、任务记录、草稿、成果和知识仍在正常用户空间。settings 的更新检查间隔和请求超时供显式 system 操作使用；identity 保存用户自行填写的名称、邮箱和对象命名空间，仅做本地格式校验。对象可通过 --object 按稳定 ID 保存通用 JSON 配置，--objects 列举已有对象记录；来源、版本、目录变化不切换数据，采用时按公共运行约定读取。普通启动不检查更新。接口与完整边界见 [user-data](user-data.md)。

## 能力源管理

`ksf source init/link/unlink/list/read/check/export` 已实现。关联仓库当前工作树，不创建安装副本、版本锁或能力快照；多源身份、依赖和 Git 协作见[source](source.md)及[协议](../sources.md)。`context capabilities --source <源ID>` 可限定共享范围；对象 read/check/list 的 --source 支持源 ID。

项目支持 current/archived/all 的范围发现与检查、指定范围的读取维护，以及 archive、restore、recover；工程关联支持项目 scope。默认知识与档案的实例机制见 [设计指南](../content-design.md)，根说明随新模板生成并由用户自行维护。完整操作及恢复边界以 [project](project.md) 与 [repository](repository.md)为准。

Assistant 的同源桌面读取与独立补采接口见 [assistant](assistant.md)。

## 应用数据离线检查

`app data inspect <appId> --json` 按已安装包的dataStores检查受管JSON格式；不启动主服务或应用、不创建缺失文件，返回每个文件的状态、schemaVersion、目标版本、etag与诊断。迁移必须由应用prepareData完成。见[应用数据](../app-development/backend-data.md)。

## 主服务、配置与首次孵化

[service](service.md)管理独立后台，[open](open.md)打开工作台，[config](config.md)管理统一配置；[incubate](incubation.md)处理新模板首次孵化，[context entry](context.md)读取固定入口。业务应用CLI按需确保主服务，状态、日志和离线检查不启动后台。详见[完整手册](../README.md)。
