# contribute 命令

从用户实例最新本地提交 HEAD 选择系统差异，与该提交保存的正式 Core 基线比较，冻结审阅后按授权创建独立的 Core 草稿 PR。维护方法见 [system-contribute](../../abilities/competencies/system-contribute/competency.md)，整体协议见[发行说明](../distribution.md)。

| 调用 | 作用 |
| --- | --- |
| `contribute prepare (--paths <系统文件...> \| --all) --title <标题> (--body <提交正文> \| --body-file <文件>) (--pr-body <PR正文> \| --pr-body-file <文件>) [--dry-run]` | 从 HEAD 冻结选定差异、本地来源、完整提交信息、独立 PR 正文、基线和摘要 |
| `contribute read <ID>` | 读取计划并核对摘要；兼容旧计划 |
| `contribute submit <ID> --reviewed <摘要> [--dry-run]` | 核对来源与远程原版 Core，创建纯系统分支和草稿 PR；旧计划仅核对已有 PR |

操作支持 json、单独 help。paths 是 KSF 根下的字面路径，不是 glob；只能选择 AGENTS.md、固定启动器和 `.agents/core/` 系统源码。兼容旧 `.agents/bin/ksf` 的已提交迁移差异。生成的 manifest、release 元数据、临时文件、个人目录和 Git 文件不能贡献。all 与 paths 互斥。

## 已提交来源与基线

prepare 需要 Git、已有 HEAD，且 KSF 根必须是 Git 工作树根。使用 Git 对象中的完整文件、权限及 `HEAD:.agents/core/release.json`，不读暂存区或工作目录；未暂存、已暂存未提交、未跟踪内容全部忽略，也不要求工作区干净。不自动 add、commit、初始化仓库或 push 个人仓库。

比较 HEAD 的完整系统状态，包含多次本地提交的累积差异；即使最后一个提交只有个人资料，也能识别之前的系统变化。基线读取兼容正式 schema 2、3 清单及 schema 4 正式发行凭据、schema 5 源码模板凭据，要求仓库、版本、准确 Core 提交和文件校验有效；缺失、损坏或开发包基线均拒绝，不从当前运行目录或最新 main 猜测替代。新凭据仅保存发行身份；prepare 联网读取准确 Core 提交的系统树，使用 Git blob 标识判断变化，按需读取并校验原版内容，不保存独立原版快照。旧清单仍可读取，升级事务与恢复保护继续适用。

无差异返回 CONTRIBUTION_EMPTY，data 包含 sourceCommit、core、version、baseline、comparedFiles 和空 changes，不保存计划。普通 KSF 使用、检查及升级仍不要求 Git。

## 冻结与审阅

新版计划 schema_version 为 5，记录 sourceCommit、baseline（schema_version、manifest_sha256）、core（精确出处）、target（官方仓库与 core-main）、version、changes、完整 commitMessage、prDescription、完整 prBody 和 digest；每项变化保存原始权限 before_mode、前后校验与冻结内容。计划位于 `.agents/runtime-data/contributions/<ID>/plan.json`，公开 diff 位于 review.diff。共同标题和两份正文必须明确提供。--body 与 --body-file 二选一，按[提交信息规则](../git-commit-message.md)填写 Git 正文；--pr-body 与 --pr-body-file 二选一，按[PR 说明规则](../pr-description.md)填写独立 PR 正文。文件都不包含标题，路径基于 KSF 根或使用绝对路径。标题和正文也会公开；CLI 输出公开 diff 与元数据，不输出二进制 base64。prepare 的 dry-run 不保存计划，但仍会联网读取小型凭据所指的原版及核对既有贡献。公开 Core 的基线读取无需账户，原文按准确提交从 raw 地址读取并核对 Git blob，避免逐文件消耗匿名 REST 配额；已有授权可复用；read 只读本地计划。

首次发布前 HEAD 须与 sourceCommit 相同；新增或切换本地提交后重新 prepare 和审阅。仅继续编辑工作目录或暂存区不影响冻结内容。submit 本地预览不认证、不联网，返回 remoteVerified:false，不能证明远程权限、原版内容或合并条件已核实。

## 完整提交信息与 PR 说明

prepare 在 Git／网络读取前检查标题及两份正文格式，分别返回 COMMIT_MESSAGE_INVALID 或 PR_DESCRIPTION_INVALID；缺少标题或任一正文来源、同种正文的两种来源混用返回参数错误。正文上限为 60000 个 UTF-16 码元（沿用 JavaScript 字符串长度），正文文件必须是普通 UTF-8 文件、最多 256 KiB。完整 commitMessage 由标题、空行和正文组成，CRLF 规范为 LF，结尾保留换行，纳入冻结 digest。read 和 submit dry-run 均返回该字段，真实 submit 使用同一份完整文本创建 Core 提交。PR 使用同一标题及独立主体 prDescription。prepare 规范 CRLF 和结尾换行，按正式 Core 版本与原版提交附加来源说明，得到完整 prBody；主体、完整正文及来源均在 digest 内。prepare/read/submit dry-run 展示完整文本，创建 PR 时直接使用 prBody，不在 submit 临时追加内容。PR 最终正文（含来源）同样不超过 60000 个 UTF-16 码元，文件最多 256 KiB。正文模板和校验见 [pr-description CLI](pr-description.md)。内容语义和验证依据仍由 Agent 核对。

旧计划不在原 digest 下自动补齐正文；未发布旧计划需重新 prepare。已记录发布的旧计划只读核对已有 PR。新计划的重试还会核对远程提交 message 与审阅文本一致。

## 公开提交与恢复

真实 submit 使用 KSF_GITHUB_TOKEN、GH_TOKEN、GITHUB_TOKEN 或已有 gh 登录，不回显秘密。任何远程写入前，先读取冻结 core.revision 的真实提交、完整树与选定原版 blob，核对内容和权限；不符、请求失败、树截断或状态未知时停止，保留计划。

Git Data API 只从原版 Core 提交建立纯系统贡献，不发送个人历史、个人提交说明、作者配置或本地 sourceCommit。核对 fork parent，在 contrib-<ID> 分支向冻结 target 的 core-main 分支创建草稿 PR，不自动变基到最新 core-main 或合并。草稿的提醒遵循 [Git 协作规则](../git.md#用户贡献)。

同一 ID 重试重新读取远程分支、提交和 PR，不直接采用缓存 URL。已记录远程提交的重试可在本地 HEAD 前进后核对旧计划，不附带新内容。返回 tree、reused、state、merged、draft；已关闭或合并报告真实状态，不创建替代 PR。远程 PR 标题和正文可以在评审中编辑，普通重试不改写它们，也不声称它们仍与初始文本一致；提交 message、来源和内容保护继续生效。远程变化、未合并分支丢失、PR 缺失或查询失败时保留现场。

旧 schema 1／2／3／4 计划可 read，但不能发起新发布。有已有发布记录时 submit 仅通过 GET 核对既有 PR 和完整贡献树，不补造 sourceCommit、提交正文或 PR 说明、不创建任何远程对象、不改写旧本地发布记录。旧计划核对按保存的来源仓库执行，不要求当前读取账号与原贡献账号相同；若来源是 fork，仍核对 parent。schema 3 仍核对原冻结 commitMessage；其 dry-run 返回 reconcileOnly:true、wouldPublish:false；无发布记录或查不到既有 PR 时返回 CONTRIBUTION_LEGACY_PLAN。

JSON 使用 `{ok, command:"contribute", operation, data, errors}`；成功 0、操作失败 1、参数错误 2。新增错误为 CONTRIBUTION_GIT_REQUIRED、CONTRIBUTION_GIT_ROOT_MISMATCH、CONTRIBUTION_HEAD_REQUIRED、CONTRIBUTION_BASELINE_MISSING、CONTRIBUTION_BASELINE_INVALID、CONTRIBUTION_FILE_TYPE、CONTRIBUTION_SOURCE_MISSING、CONTRIBUTION_BASELINE_UNVERIFIED、CONTRIBUTION_BASELINE_MISMATCH、CONTRIBUTION_LEGACY_PLAN。原有空差异、审阅、摘要、过期、fork 和远程状态保护继续适用。

实现为 committed-source.js、contribute.js、github.js。程序测试使用隔离 Git 仓库及模拟 API；不把模拟成功说成真实 PR 已提交。

## 同一节点与重复内容提示

prepare 返回 warnings，按本机贡献记录识别同一 sourceCommit 或相同系统内容（固定 Core 基线、选定路径、前后内容和权限），不以标题、时间或计划 ID 判断。个人资料提交导致 HEAD 前进，但系统贡献内容相同，仍可识别。只在节点相同、选定内容不同时提示已有贡献，不将其判成完全重复。

有既往发布尝试时只读复核原 PR、分支和完整贡献树；已核实时返回 CONTRIBUTION_PREVIOUS_PR、原 ID、URL、state、merged、draft 和 sameContent。无法核实时返回 CONTRIBUTION_PREVIOUS_PR_UNKNOWN，remoteVerified:false，不把缓存状态称为远程事实。提示是预览附加结果，不进入冻结内容摘要。

submit 对不同 ID 的相同内容再次检查：核实已有 PR 后返回 duplicate:true、原 ID 和 requestedId，open、closed、merged 均不重复创建。已有尝试未形成可核实的 PR 时返回 CONTRIBUTION_PREVIOUS_ATTEMPT，要求重试原 ID；远程状态不明或已变化时保留现场。attempted.json 在第一个远程写入前记录意图，覆盖创建 ref 或 PR 的响应丢失。旧计划没有 sourceCommit 时仅按完全相同的系统内容提示，不能补造节点关联。基于本机保留的记录判断，不声称能识别其他设备或手工创建且没有本机记录的 PR。

规范源 `.agents/core/distribution/repository/` 的固定导出映射可生成官方根 README、.gitignore、.gitattributes 和三份工作流的差异。每项投影显式出现在公开计划中，原版来自精确 Core 树，内容来自已提交的规范源；不读取个人根文件。映射以外的任意根路径仍被拒绝。
