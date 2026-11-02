# 当前聊天轮次与动态变量

`ksf chat` 已实现当前 Codex 聊天的原生轮次计数、能力参与计数及动态变量存取。变量由能力在运行过程中决定，无需注册字段、声明 schema 或预先列出变量名；同一键可改变 JSON 值类型。程序不解释业务含义、不推进流程、不把变量字符串作为指令执行。

## 接入和命令

从当前 KSF 根调用，其他目录使用该根 `.agents/ksf` 的绝对路径：

```sh
.agents/ksf chat hooks --json
.agents/ksf chat sync --json
.agents/ksf chat read --json
.agents/ksf chat context --json
.agents/ksf chat read --object partner.example.research --fields current_step --json
.agents/ksf chat use --object partner.example.research --turn '<当前原生turnId>' --json
.agents/ksf chat write --object partner.example.research --data '{"本轮临时发现":true}' --if-match '<当前etag>' --json
.agents/ksf chat remove --object partner.example.research --fields '本轮临时发现' --if-match '<当前etag>' --json
.agents/ksf chat restart --object partner.example.research --turn '<当前原生turnId>' --if-match '<当前etag>' --json
```

上例 ID、变量名、轮次和 etag 仅为占位；任意合法动态 JSON 键均可使用。首次目标确实缺失时 etag 为 `missing`。`hooks` 幂等合并现有 `.codex/hooks.json`，复用 `task hook` 分发，保留其他处理器和任务采集配置；不自动启用对话正文归档。宿主仍需信任实际 Hook 定义，程序不改信任记录。移动根目录后重新接入。

| 操作 | 参数与行为 |
| --- | --- |
| hooks | `[--json]`，启用轮次跟踪并保存首次 activatedAt，重复执行不重置基线，不导入历史或补算正在处理的轮次 |
| sync | `[--json]`，显式核验当前宿主的本机原生来源并登记运行中的轮次，只提取轮次边界、不归档对话正文，不启用跟踪、不登记能力采用；无 Hook 触发的新会话也可沿此接入 |
| read | `[--object <id>] [--fields <名称...>] [--json]`，缺省读公共变量；仅查询不登记轮次或采用 |
| context | `[--json]`，只读预览与 Hook 相同的有界状态快照，不登记能力采用 |
| use | `--object <id> --turn <nativeTurnId> [--dry-run] [--json]`，显式登记实际采用，同一能力同次运行同一原生轮次幂等 |
| write | `[--object <id>] (--data <JSON> \| --from -\|file) --if-match <etag\|missing> [--dry-run] [--json]`，合并顶层键，嵌套值整体替换 |
| remove | `[--object <id>] (--fields <名称...> \| --all) --if-match <etag\|missing> [--dry-run] [--json]`，只清除变量，保留计数和运行身份 |
| restart | `--object <id> --turn <nativeTurnId> --if-match <etag\|missing> [--dry-run] [--json]`，只重启指定能力，变量清空，新 runId，当前轮计为新运行第 1 轮 |

所有操作有 `--help`、`-h`；选项不重复，不接受位置目标、未知选项或 `--force`。`--fields` 单次多值、按首次出现顺序去重，完整键名中的点号不解释为路径；以连字符开头的单键可用 `--fields=-name`。`--all` 和 `--fields` 互斥。`--from` 相对文件路径基于 KSF 根，`-` 明确表示标准输入；输入为最多 1 MiB 的 UTF-8 JSON 映射，保持字符串、有限安全数值、布尔、null、数组和对象类型。`null` 是值，删除使用 remove。

## 身份、轮次与范围

CLI 使用 `CODEX_THREAD_ID`，通过既有根本地密钥派生与 taskId 相同的匿名 chatId；缺失身份不按 cwd、项目名或最近聊天猜测。内部服务接受明确的 `{host:"codex",sessionId}`，首版未自动接入其他宿主。密钥不能与已有聊天数据分离清理；缺失时拒绝生成新密钥来掩盖原状态。

UserPromptSubmit 校验 transcript 元数据的会话、工作区及内部线程来源，登记当前原生 turnId。接入后的第一个原生轮次为 1；重复 Hook、同轮工具问答、PreCompact、Stop、Interrupt 不新增计数，已开始后中断的轮次保留。旧轮次重放不把当前轮回退。计数起点为本实例首次 chat hooks 的 activatedAt，不能把这个计数宣称为接入前的完整聊天历史。每次核对接入后原生轮次边界，可恢复漏掉的 Hook；只保存标识，不保存消息正文。压缩或来源缩短不删除已有登记。损坏记录、未知边界无法确认时报告计数缺口，不猜数。未收到可靠 Hook 时 read 返回 null 轮次；use/restart 拒绝未登记或非当前 turnId。

应用工具创建的新会话或自动续跑可能没有 UserPromptSubmit。此时 read/context 仍只读已有账本，不能把旧轮次当作当前轮次；允许状态写入时显式 sync，通过当前 CODEX_THREAD_ID 核对唯一原生来源、工作区、创建基线和在运行的 task_started。完成、中断、未知边界、部分刷盘、内部 worker、来源歧义或身份不符均拒绝，不接受自填 turnId 或任意来源路径。返回 registration=native-transcript，区别于 Hook 注入；它只登记真实边界，后续 use 和 task declare 仍独立执行。跟踪关闭时不自动开启，只读/禁写任务不调用 sync。

公共空间省略 `--object`，能力空间按完整三段 ID 隔离，涵盖四种能力类型；不带版本，不按来源或版本拆空间，不自动合并公共、对象长期设置或其他能力的变量。use 是 Agent 明确采用的声明，不证明能力已完成、真正理解或业务效果。普通对象 read、候选比较和变量写入不计能力参与。首次写能力变量但尚未 use 时，参与次数为 0。

实际采用时遵循 [Runtime 的动态变量约定](../../abilities/partners/ksf-runtime/partner.md#当前聊天轮次与动态变量)：能力要求维护的运行状态须由 Agent 在自身空间实际保存，“内部／静默”表示不向用户展示。先使用自动快照，采用后以 use 的最新 values/etag 校正，依据定义与已确认事实恢复；在要求的更新时机及回复、等待或结束前保存必要差异，成功回执或读回对账才证明保存。use 和 task declare 不保存业务变量。字段和值由能力运行时决定，CLI 不从能力正文自动生成业务字段或状态；没有需求或没有差异时不写入，只读限制仍适用。

同一聊天重开、切走再回来仍接续；新聊天与分叉聊天使用独立 chatId。restart 只影响指定能力，聊天总次数不重置，其他变量不变；旧轮次 use、旧 etag 修改不能污染新运行。结果未知先读回核对，不能盲目重试 restart。

各聊天的 countingSince 取跟踪启用时间与可靠原生会话创建时间中的较晚者，避免分叉原件中复制的父聊天轮次进入新聊天计数。分叉缺少可靠创建时间，或已登记聊天的创建基线改变时，报告来源缺口并保留原状态。

## 自动上下文快照

UserPromptSubmit 登记聊天轮次后，自动追加 `KSF_CHAT_STATE_V1` JSON 数据块。`chat context` 预览同一快照；它只读现有状态，不创建默认文件、变量、写锁或能力参与记录，也不增加能力轮数。版本为 `protocol:ksf-chat-context-v1`，与存储 schemaVersion 分开，不改变旧状态格式。

快照包括 system、ledgerVersion、shared、abilities、selection 和完整性信息。每个空间含 state、version（schemaVersion/revision/etag）、values、valuesComplete、omittedFieldCount；能力还含完整 objectId、runId、abilityTurnNumber、participatedInCurrentTurn。轮次开始时尚未采用的能力保留已累计计数与 false 登记状态，实际 use 后才增加参与轮次。旧快照 etag 不能覆盖后续采用或修改产生的新版本。

接续集合按最近一次实际参与的原生轮次计算：注入该轮登记过的全部能力；没有实际采用的轮次不清空接续。重复 Hook 同时包含本轮已登记能力，防止遗漏同轮新增采用。仅读取、比较候选、写变量但尚未 use 的空间不参与选择；下一轮真正切换采用后，旧集合退出默认注入。重新采用旧能力仍由 use 返回其保留状态。选择只依赖明确参与记录，不分析业务字段、归档正文、来源名称或长期设置。

状态数据块含标签最多 **12 KiB UTF-8**，最多 **16 个能力**，最多扫描能力目录 **128 项**。先保留元数据，再在公共与各能力间轮流放入完整顶层键值；大嵌套值整项省略，后面的小值仍可放入。`complete:false`、各 omitted 计数和 issues 明示省略或损坏，省略的键不能当作缺失、null 或未维护。需要时使用完整 ID 的 read 补读，完整存储值和 etag 不变。能力数超限明确 omittedAbilityCount；扫描超限返回 CHAT_CONTEXT_CAPACITY，接续集合不可确认，不猜选剩余文件。损坏能力单独标记并保留可核对的数据；公共空间损坏时不注入假空值，Hook 仍保留已确认的聊天轮数。

byteLength 为包含标签的数据块实际字节数，limits 为当前注入上限；这些是工程预算，不代表模型 token 数。快照中的变量字符串保持普通数据，不成为指令或新授权。正文采集关闭仍可自动注入；宿主没有触发 UserPromptSubmit 时不声称已注入，可由 context/read 查缺口。应用内转发续跑与真实用户原生消息须分别验证。

## 输出、并发与文件影响

统一 JSON 信封为 `{ok,command:"chat",operation,data,errors}`。成功及缺失退出 0；参数或输入错误退出 2；存储、身份、冲突及不支持格式退出 1。

read/use/修改结果含 `state`、`path`、`etag`、`schemaVersion`、`revision`，以及分开的：

- `system`：chatId、trackingEnabled、turnId、chatTurnNumber、countingSince；指定对象时另有 objectId、runId、abilityTurnNumber、participatedInCurrentTurn。
- `values`：仅用户动态变量。选择字段时 `missingFields` 区分未定义键与显式 null，系统字段无法通过变量覆盖。

修改另含 dryRun、changed、wouldChange、beforeEtag；remove 含 removedFields/missingFields。同值写入、重复 use 保持字节和 revision。预览返回提议值但 etag 仍为当前持久值，不能把预览的 runId 当作已发布。没有原生登记时 chatTurnNumber 为 null，不是 0；`state:missing` 仅说明该变量空间缺失。

状态在 `.agents/user-data/chats/`：config.json 为跟踪配置，`<chatId>/turns.json` 保存去重原生轮次，shared.json 保存公共变量，abilities 内按对象 ID 摘要保存能力 runId、参与轮次和变量。能力重启在同一文件原子发布，避免变量与计数分裂。单 scope 最大 1 MiB，轮次账本最大 4 MiB；超限拒绝更新，不截断历史。

同聊天写入用 `.agents/runtime-data/chat-state/` 的进程锁串行化；变量修改还核对完整 scope 文件的 SHA256 etag，临时文件 fsync 后原子替换，发布前再次检查旧字节与文件身份。锁仍存活或归属未知时不抢占。损坏 JSON、未知格式、符号链接及并发变化保留现场。跨文件不宣称事务。

read、context 和 dry-run 不创建状态、临时文件或写锁；共同启动器仍可能准备 Node 缓存。只读或禁止 Agent 写入时不调用 use 或变量修改，注入也保持只读，返回实际登记状态。正文采集暂停/关闭不重置计数和变量；明确禁止状态保存时须遵守对应限制。聊天变量只承载必要运行状态，正文、证据、成果、凭据仍保留各自边界。

Core 发行不携带真实聊天状态，升级/回滚保留原字节；它不是自动跨设备同步。变量历史界面、流程执行器、表达式和状态转换校验不在首版范围。

主要错误：CHAT_SOURCE_UNAVAILABLE、CHAT_SOURCE_AMBIGUOUS、CHAT_IDENTITY_REQUIRED、CHAT_HOST_UNSUPPORTED、CHAT_TURN_UNAVAILABLE、CHAT_TURN_CONFLICT、CHAT_SOURCE_IDENTITY、CHAT_CONFLICT、CHAT_LOCKED、CHAT_DATA_INVALID、CHAT_VERSION_UNSUPPORTED、CHAT_CAPACITY、CHAT_CONTEXT_CAPACITY；安全文件层还会返回 USER_DATA_PATH_INVALID，身份密钥缺失返回 ROUTE_KEY_INVALID。

实现为 `src/chat-state/`、`src/services/chat.js`、`src/commands/chat.js`，复用 `taskHook`。验证见 [chat.test.js](../../runtime/tests/chat.test.js)、[上下文专项](../../runtime/tests/chat-context.test.js)与[发行隔离测试](../../runtime/tests/chat-distribution.test.js)。程序验证、当前聊天实测与真正跨轮次验收分别记录，不互相替代。
