# Core 发行与个人实例

`yinbaiyuan/ksf-core` 是系统源码、GitHub 模板和正式发行的唯一入口。原 `ksf-workspace` 退出创建与发行链路，不再构建、同步或发布第二个仓库。

## 仓库、分支与版本

| 位置 | 用途 | 变化方式 |
| --- | --- | --- |
| 官方 Core `core-main` | 只保存公共内核、程序、文档、测试及通用实例种子 | 功能或修复分支经过 PR、检查和评审合入 |
| 个人私有实例 `main` | 系统副本、个人项目、知识、能力、配置和档案 | 用户按自己的需要提交与备份 |
| 个人实例 `core-main` | 创建时的初始模板快照 | 保留初始节点，升级不移动该分支 |
| `v<版本>` 与发行索引 | 冻结某次可安装的系统版本 | 指向精确 Core SHA；已发布资产不能换内容 |

GitHub 模板产生独立初始提交，不继承 Core 历史。`main` 与 `core-main` 的不同名称不能提供隔离，也不能建立共同祖先。实际边界由系统路径白名单、精确基线、初始化校验、升级事务和贡献预览共同实现。个人 origin 始终指向个人仓库。

`core-main` 表示稳定开发主线，不是单一版本；功能开发在独立分支完成。正式版本由版本号、完整 SHA、标签、平台及资产摘要共同确定。不得把可移动分支名当作安装基线。

## 从 Core 创建实例

### 私有仓库

1. 在官方 [KSF Core](https://github.com/yinbaiyuan/ksf-core) 选择 **Use this template → Create a new repository**，仅复制默认分支，选择 **Private**。仓库可叫 `ksf` 或自定义名称。
2. 克隆自己的仓库，用 Agent 打开根目录，读取 `AGENTS.md`。GitHub 复制的分支起初可能仍叫 `core-main`。
3. 执行固定入口的 `instance init --json`。macOS 使用 `.agents/ksf`；Windows 使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .agents/ksf.ps1`。
4. 初始化验证来源后，从当前 HEAD 新建并切换到个人 `main`，保留原本地和远端 `core-main`；创建缺少的个人文件并记录 Core 来源。main 的跟踪及默认推送目标固定为自己的 `origin/main`，只修改本仓库相关 Git 设置，不自动提交、推送、更换远端 URL 或修改远端默认分支。需要远程备份时，按用户授权正常推送 main；首次推送建立远端 main，远端 core-main 和默认分支可以保持原样。
5. 再执行 `context entry --json`，进入首次孵化。保留原始任务，完成或跳过孵化后继续。

初始化通过本地初始提交的完整树 SHA，在官方 `core-main` 历史中查找完全相同的树，再固定实际 Core 提交。最多查找 2000 个提交；更旧来源可显式提供经过核对的 `--revision <完整 SHA>`，仍须验证初始树相同。它不猜测 latest，不将个人 HEAD 当作 Core SHA。所有当前系统文件的内容、权限和新增路径也须与原始 Core 一致；先初始化再修改内核。

再次克隆个人仓库时，默认分支可能仍是旧快照。实例初始化优先恢复已有本地 main，或从 origin/main 建立本地 main：仅接受带有效安装凭据的当前快照后继，不重新孵化或覆盖个人文件。恢复只读本地 Git 对象，不联网升级；未提交的已跟踪修改、不同历史、无有效凭据及文件覆盖冲突均保留报错。旧入口尚无恢复功能时，可使用 `git clone --branch main <个人仓库地址>`。当前安装基线始终由发行凭据固定，无需更新个人 core-main。

现有 USER、BOT、知识、档案、设置及个人文件均保留。只有仍与已验证 Core 根文档完全相同的 README、忽略规则与属性文件，才替换为实例种子；用户已定制的内容不覆盖。初始化使用可恢复事务，失败保留证据；并发编辑冲突不能静默覆盖。`--dry-run` 不写入，存在中断事务时提示实际恢复。

### 文件夹

从正式 Release 下载匹配平台的 `ksf-core-<版本>-<平台>.tar.gz`，按 `ksf-core-index.json` 校验尺寸与 SHA256，再用受限归档读取实现解压到空目录，保留隐藏文件和入口权限。更新包内部的 schema 3 清单逐项验证路径、类型、内容和权限。解压后执行 `instance init --json`，联网核对精确 Core 来源并创建用户目录；不要求 Git。不得用普通解压覆盖已有实例。

维护者本地 `release build` 另生成可检查的 `ksf/` 实例目录，已含安装凭据与通用种子，可直接复制到空目录。这个目录不是独立产品，不上传第二个压缩包或同步第二个仓库。`--allow-dirty` 只用于明确的本地开发试验，不能变成正式来源。

macOS ARM64 与 Windows x64 使用各自随包 Node，无需为普通使用安装全局 Node、npm 或 Python。仓库创建与贡献需要 Git；当前平台的实际验收以对应证据为准。

## 内容归属与来源凭据

系统管理范围为根 `AGENTS.md`、固定启动器 `.agents/ksf`、`.agents/ksf.ps1` 和 `.agents/core/`，排除发行凭据、构建临时文件与开发依赖。个人目录和根 `.github/`、README、`.gitignore` 不属于普通升级目标。

Core 源码不保存真实 USER、BOT、个人目录或占位文件。通用实例种子只从 `.agents/core/distribution/template/` 显式清单生成，不扫描维护者个人数据；知识规则、认知空骨架、档案说明和 pending 孵化状态随种子创建。`repositories/` 是按需创建的独立工程容器，个人根 Git 忽略整个容器，各工程自行管理和备份历史。

| 凭据 | 含义 |
| --- | --- |
| 安装 receipt schema 4 | 正式发行版本、平台、准确 Core 仓库、原分支与 SHA |
| 模板 receipt schema 5，origin=core-template | 经过完整树验证的源码模板基线；与正式发行区别保存 |
| 更新包 manifest schema 3 | 完整文件清单及 SHA256、权限；不携带原版正文副本 |
| 旧 schema 2/3/4 | schema 2 只限已提交贡献基线读取；schema 3/4 保留实例升级读取，安装与恢复仍要求当前启动器协议 |

源码模板没有预制的自指 Core SHA；由初始化验证后生成凭据。原 `.ksf-template.json` 不再生成，旧实例中的该文件仅保留历史事实，当前版本始终以 release.json 为准。凭据由程序生成，不让 Agent 猜值或手写。

`context entry` 只读取本地状态。新模板或未初始化更新包进入固定的 instance-setup 定义；初始化后再进入孵化或正常 runtime。启动不检查新版、不联网升级、不自动切换分支。

## 升级、回退与旧实例

```sh
.agents/ksf system read --json
.agents/ksf system check --json
.agents/ksf system update --dry-run --json
.agents/ksf system update --json
.agents/ksf system rollback --json
```

升级按凭据中的不可变 Core 提交取得原版文件，逐项比较原版、本地和新版本；只处理系统路径。文本可合并时保留本地变更，二进制或不可合并变化返回冲突并保留现有系统。项目、知识、USER、BOT、用户数据、README、忽略规则、Git 配置与个人历史不会因升级被替换。

旧凭据中的 `core.branch=main` 仍是真实来源，不改写旧 SHA。新升级目标来自 Core Release；后续贡献目标来自新配置的 `core-main`，不再由旧来源分支决定。

通常只能升级到更高版本，同版本不同 SHA 视为换源并拒绝。源码模板有一个明确例外：schema 5 的同版本正式发行必须经过 GitHub compare 验证为原模板 SHA 的后继（准确 base 和 merge-base 均相同），才可转为正式发行凭据；当同版本 Release 是模板来源的已验证祖先时，check 返回 sourceAhead:true、available:false，继续使用当前源码并等待新发行；显式安装较旧包仍拒绝。不放宽旧正式实例的同版本保护。

候选包核对清单、随包运行时、系统定义、变化 JavaScript、用户数据兼容及已关联能力源依赖后，才通过同一文件系统事务切换。备份支持回退；并发变化停止切换。崩溃恢复使用固定启动器的 `launcher recover`。断网仍可使用已安装版本；检查、初始化来源验证和需要原版的升级/贡献保留实际错误，不伪造成功。

## 系统贡献

个人实例先按授权形成本地系统提交。`contribute prepare` 只读 HEAD 中的系统文件与该提交保存的来源凭据，冻结选定公开差异、精确基线、完整提交正文、独立 PR 正文以及目标仓库和 `core-main` 分支。暂存或未提交变更不进入计划。

新计划 schema 5 将 `core`（原版出处）与 `target`（PR 目标）分开。submit 先验证原版 Core 与冻结前像，再以原 Core SHA 为唯一父节点构造纯系统提交和 `contrib-<ID>` 分支，向 `core-main` 创建草稿 PR。个人 main、作者配置、提交说明、文件和历史不发送给 Core。不整体 merge、rebase 或 push 个人分支到官方仓库。

官方根文件的规范源位于 `.agents/core/distribution/repository/`，涵盖 README、忽略规则、属性及三份官方工作流。prepare 对所选规范源显式生成官方根路径投影，两份差异都出现在审阅计划；它从原始 Core 树读取根文件前像，不读取个人根 README 或 CI。映射是固定白名单，不能借此公开任意个人路径。系统升级只更新规范源，不覆盖个人根文件。

旧 schema 1/2/3/4 贡献计划仍可读取并只读核对已有 PR；未发布计划需重新 prepare，不能携带旧 `main` 目标发起新贡献。相同内容与未知发布尝试继续按原 ID 对账。参数、重试和公开审阅见 [contribute CLI](cli/contribute.md)。

## 构建与正式发布

```sh
.agents/ksf release build --output <新目录> --json
.agents/ksf release publish <发行目录> --dry-run --json
.agents/ksf release publish <发行目录> --json
```

build 要求纯系统、准确且干净的 Core 提交；正式发布来自 `core-main`。默认覆盖 build.json 声明的正式发行平台（开发专用目标除外），每平台只生成一个 Core 压缩包；Mac 发布器无需执行 Windows 二进制即可构建 Windows 包。单平台 --platform 用于检查，正式发布拒绝缺少声明平台的索引；索引 schema 2 的 products 为 core=ksf-core、instance=ksf，各 platform 只允许 core 描述符。旧 schema 1 索引仅供升级兼容读取，不能作为新发布输入。

产物含 `ksf-core-<版本>-<平台>.tar.gz`、`ksf-core-index.json` 和本地检查目录 `ksf/`。构建校验系统白名单、提交内容、权限及重现性，不收集用户目录；发布重新校验全部资产。多平台发行索引必须包含所有准备的平台，最终交接冻结 Core SHA 和索引 SHA256。

### 从用户实例发起远程发行

只有明确要求正式发布时执行：

```sh
gh workflow run release.yml --repo yinbaiyuan/ksf-core --ref core-main
```

发起前核对实际远端 Actions、版本、源码、账户权限和同版本标签。发起后记录时间、请求与运行标识；未知结果先查询原请求，不重复触发或把最新运行冒认为本次运行。

官方源码的根工作流由 Core 内规范源投影维护。check 对 `core-main` 的 push/PR 检查；可信全量证明只接受官方仓库、准确最终 SHA、`core-main` 成功运行与完整 Mac/Windows 覆盖。无匹配证明时补原生全量。模板创建出的个人仓库因官方仓库条件而不执行官方作业。

release 工作流只有验证、准备与一个 Core 发布作业。准备校验官方 Core 已标为 Template repository、默认分支为 `core-main`，确认最终提交属于该主线，构建一次并上传冻结资产。发布作业使用 Core 自身 GITHUB_TOKEN，只给该作业 contents:write，按 artifact ID 下载并核对摘要后发布。没有 Workspace 作业、定时镜像、跨仓库 GitHub App 或模板秘密。

发布先创建或核对不可变 tag、草稿 Release，校验已存在资产后只补缺失项；全部核实后公开。上传响应丢失可用同一包重试并对账，不重复上传、不替换已公开资产；已公开不完整包要发布新版本。内部恢复工具仅下载精确标签已公开的 Core 资产，验证 tag、索引、摘要及来源，不从 latest 重打包或修改旧 Release。

## 按目标平台携带运行时

源码工程保留完整的 build.json 可信声明和多平台构建材料。由 `distribution/runtime-layout.json` 的固定 v1 策略启用目标平台打包：每个 Core 归档及本地检查实例只包含目标平台的一个 Node 归档，按 build.json 中该平台的准确 `archive_path` 选择，允许源码保留同平台旧版本归档。生成的 manifest.yaml 也只声明该平台。build.json 保持来源提交原文，不能为精简产物改写可信来源声明。

发行构建核对完整来源工作树，各平台的输入摘要必须一致；产物清单与归档摘要按实际平台内容计算。发布索引仍须覆盖所有正式目标，不能用单平台包冒充完整发行。归档检查拒绝缺失目标归档、额外平台归档或运行时清单与目标不一致。

已安装发行实例重建清单时，依据现有发行凭据选择对应目标，不要求其他平台的归档。源码工程和 schema 5 模板实例继续校验全部声明的构建材料。schema 4 小型凭据的原始基线从固定 Core 提交树验证策略文件的准确内容和模式，再读取并核对同一提交的 build.json Git 对象，按其准确声明选择归档；不使用实例内可能被修改的声明。凭据格式保持不变，策略出现前的旧提交仍按完整树比较。源声明、普通系统文件与原生归档的完整性保护保持有效。

从旧多平台包升级时，沿原事务比较并移除未改动的多余归档；本地修改触发冲突，回滚恢复旧包和旧归档。目标平台包跨系统复制后不具备新宿主的 Node，必须先取得新宿主对应的系统包并保留个人资料，不能直接运行旧平台入口完成切换。旧多平台包仍按原跨平台检查流程处理。

## 迁移与验收

旧用户无需换仓库、改个人 main、重做历史或删除个人根工作流。官方迁移需另行核对并实施 Core 分支改名、默认分支和模板标记、保护规则/必需检查、未合并 PR 目标以及旧 Workspace 的退役说明。仓库内实现与真实 GitHub 配置、正式发行、实例安装分别记录，不能相互冒充。

针对创建、原版验证、个人资料保护、事务恢复、旧 main 基线、新 PR 目标、官方根投影、单产品发布/重试及双平台原生流程留证。模拟 API 只证明程序协议；本地测试不能冒称真实远程发布。测试规则见[开发与测试规范](testing.md)。

旧客户端继续读取 `ksf-core-release.json`。该兼容索引由同一新索引派生，只保留旧 schema 1 的身份字段并指向同一批 Core 资产，不带 Workspace 包；发布核对两份索引严格一致。新 Core 的默认来源改为 `ksf-core-index.json`，无需旧用户手工跳过来源检查。旧模板在 Windows 上可能带有 Mac 平台凭据；升级后的新 Core 选择本机平台，并允许同版本、相同完整 SHA 的平台标记校正，不允许借此换源或降级。
