# project 命令说明

## 状态与职责

已实现。管理当前 KSF 的项目发现、读取、创建、更新、检查、删除及归档恢复；current 根卡为 `项目/<项目名>/project.md`，archived 为 `档案/项目/<项目名>/project.md`。根卡仍为普通 Markdown，没有必填 ID、版本、修订号或固定章节。

CLI 负责文件操作；主项目判断、来源核对、写入授权和成果验收仍由 Agent 完成。项目不进入能力发现集合，也不支持自动绑定工程、跨会话自动记忆或项目间事务。公共调用规范见 [CLI 命令设计规范](../CLI命令设计规范.md)。

实际工程默认位于 `repositories/` 或已有工作区，由 [repository CLI](repository.md) 显式创建和关联；根卡的可选 repositories 元数据保存路径列表。project write 不自动 git init，project remove 不跟随关联路径删除工程。项目归档整体移动项目记录、设置使用状态并重定位结构化关联，工程保留原位。

## 调用与操作

```sh
.agents/ksf project list --json
.agents/ksf project read "KSF运行机制测试" --part all --json
.agents/ksf project write "新项目" --data '{"metadata":{"name":"新项目","description":"本项目的目标"},"body":"# 新项目\n\n项目目标。\n"}' --dry-run --json
.agents/ksf project write "新项目" --from project-input.json --json
.agents/ksf project check "KSF运行机制测试" --json
.agents/ksf project check --json
.agents/ksf project remove "新项目" --dry-run --json
```

| 操作 | 目标 | 行为 |
| --- | --- | --- |
| list | 不接受目标 | 返回当前根下直接子目录的根卡摘要，不递归，不展开正文 |
| read | 必填项目目录名 | 读取根卡，默认 metadata 与 body 全部返回，不展开资料 |
| write | 必填项目目录名 | 根卡不存在时创建，存在时只更新提供部分 |
| remove | 必填项目目录名 | 删除整个项目目录，包含根卡、材料、成果及其他子目录 |
| check | 可选项目目录名 | 检查指定根卡；省略时检查全部直接子目录的根卡 |

`remove` 的完整删除范围由目标项目目录明确限定，不接受省略目标、`--all` 或 `--force`。保留项目但退出使用，可按用户要求修改根卡的 status；普通 write 不替用户移动目录；物理归档与恢复使用专用操作。

## 参数

| 参数 | 类型与默认行为 | 限制 |
| --- | --- | --- |
| name | 单个目录名，read/write/remove/archive/restore 必填，check 可选 | 中文、空格可用；不接受路径、斜杠、反斜杠、控制字符、空白名称、`.`、`..` 或保留的 `.ksf-project-` 前缀 |
| --part | 单个枚举，默认 all | 仅 read；metadata、body、all；未选部分不返回 |
| --data | 单个 JSON 对象字符串 | 仅 write；与 --from 恰选其一 |
| --from | 单个 UTF-8 JSON 文件路径 | 仅 write；相对路径以 KSF 根为基准，绝对路径直接使用；与 --data 同格式 |
| --dry-run | 无值布尔选项，默认 false | write/remove/archive/restore/recover；不写目标、不建业务目录、临时文件或锁 |
| --json | 无值布尔选项，默认文本 | 所有操作；只改变输出格式 |
| --help 或 -h | 无值帮助选项 | 命令级、操作级支持；单独使用，不与目标或其他选项混用 |
| -- | 结束选项解析 | 操作后的后续参数按目标解释，支持连字符开头的目录名 |

每项选项至多出现一次。未知、重复、缺值、多目标、不支持的选项及格式错误返回退出码 2。标准输入不作为隐式输入来源。

项目目标始终是目录名，例如 `KSF运行机制测试`；不接受 `项目/KSF运行机制测试/project.md`。名称是文件定位依据，metadata.name 可作显示名称，两者不必相同。

## 写入格式与保留范围

```json
{
  "metadata": {"name": "新项目", "status": "active", "tags": ["测试"]},
  "body": "# 新项目\n\n当前目标和下一步。\n"
}
```

顶层只接受 metadata 与 body，至少提供一项。metadata 是普通 JSON 字段映射，按顶层合并，未指定字段保留，嵌套值整体替换，null 是赋值；body 是字符串，提供时整体替换正文，省略时保留。新建根卡必须提供 body，允许明确的空字符串；不自动生成模板。

只修改正文时，保留原 frontmatter 字节；只修改元数据时，保留正文原字节，并尽量保留 YAML 注释和格式。无变化时不重写根卡。已存在的资料目录可以补建根卡，其他文件保持原样。损坏的 YAML、非 UTF-8、符号链接或无法按原意序列化的输入会失败，不静默修复或覆盖。

命令不自动改项目材料、成果、其他项目、外部工程或导航链接。需要同步时由 Agent 根据已授权差异处理。

## 可选 routing：四类能力偏好

根卡 metadata.routing 为可省略的映射，只接受下列可选列表；省略或空列表表示没有该类预设，空映射表示没有预设。routing 不是第五类能力对象，也不要求项目 ID 或版本。

| 字段 | 每项格式 | 作用 |
| --- | --- | --- |
| cooperations | `{ref: "cooperation.example.delivery@0.1.0", source: "team-methods"}` | 优先核对的协同 |
| partners | `{ref: "partner.example.editor@0.1.0"}` | 优先核对的搭档 |
| competencies | `{ref: "competency.example.review@0.1.0"}` | 按需采用的补充方法 |
| data_packages | `{ref: "data-package.example.materials@0.1.0"}` | 按需使用的资料包 |

能力项只接受 ref 与可选 source，ref 类型匹配列表并含精确 x.y.z；固定运行入口不能作为预设。source 省略时为 effective，也可显式指定 user、system 或源 ID，不能用 all。只影响该项定位，不过滤全局候选或改变源对象同源/Core 依赖规则。重复条目保留输入顺序，Agent 不因重复而重复执行。

routing.knowledge 已移除，check 返回 PROJECT_ROUTING_KNOWLEDGE_REMOVED，指出 routing.knowledge 并提示显式移除。程序不访问其值或目标文件；项目事实入口放正文，配套资料由承接能力声明，不新增替代路由字段。

write 校验显式提供的 routing 结构；未知字段、非映射、错误类型、非精确引用返回 PROJECT_ROUTING_INVALID、退出 2，不联网或检查对象当前可用性，允许先记录尚未可用的精确引用。routing 嵌套值仍整体替换；清空用 `{}`，不能用 null。只改正文或其他元数据时保留原配置。repository 等内部元数据变换保留未改变的旧配置，不借无关操作修复坏 routing。通用 metadata/宿主编辑不自动应用此领域校验，check 和采用时仍需核实。

read 原样返回 routing，不展开资料或校验可用性，坏配置不阻止读取其他项目事实。check 对每项独立检查：能力项复用对象 check，返回实际来源/路径及精确依赖，归档对象即使显式指定来源也不能作为有效预设。某项失败保留原配置和其他有效项，不自动换版本、安装、重置、建知识导航或读取/写入对象 user-data。

没有 routing 的旧项目响应不增加 routing 字段。配置存在时，指定及批量 check 的项目结果增加 `routing: {valid, entries}`。每项含 field（如 routing.partners[0]）、reference 和 valid；能力项另含 requestedSource、可解析时的 object 摘要及 references；失败项含 errors，对应问题汇总到顶层 errors。未知配置字段进入汇总错误，不生成虚构条目。部分失败退出 1，仍需读取 stdout 的可用项；list 不因 routing 失效而丢失项目摘要。批量 check 有任何错误时 complete/valid 均为 false，各条目仍返回已检查结果。

程序只证明配置结构和本机可用性，不选择能力或核实项目事实。明确指令、有效原安排及适用预设的选择顺序由[能力路由](../../abilities/competencies/ability-route/competency.md)持有，整体调度见[项目与能力路由协作](../runtime/routing.md)。裁剪示例见[配置模板](../templates/project-routing.md)。

## 输出

JSON 使用 `ok`、`command: "project"`、`operation`、`data`、`errors`。业务成功、失败及部分结果都写入 stdout，日志与启动诊断在 stderr；退出码 0 为成功，1 为操作失败或检查不通过，2 为调用错误。

| 操作 | data 主要字段 |
| --- | --- |
| list | complete、projects；每项含 name、title、description、status、path |
| read | project，含 name、path、directory、state 及所选 metadata/body |
| check 指定项目 | name、path、valid、state；配置存在时另含 routing 逐项结果 |
| check 全部 | complete、valid、projects，每项包含根卡检查结果 |
| write | name、path、dryRun、changed、wouldChange、created、wouldCreate、changes、写入后的 project |
| remove | name、path、dryRun、changed、wouldChange、removed、将移除的 entries |

结果中的 path、directory 相对 KSF 根。`state: absent` 表示没有 frontmatter，`present` 表示存在合法字段映射。无元数据的根卡也有效。

list 的 title 优先取非空字符串 metadata.name，其次正文的一级标题，否则取目录名；description 与 status 忠实保留原值，缺失时为 null，不自动生成摘要或判断活跃状态。默认列表仍列出当前目录中原位 status 为 archived 的旧项目；已移动项目通过 archived 或 all scope 列出，由 project-route 判断适用性。空集合且 complete 为 true 才是完整空库；单项损坏时保留其他有效项，complete 为 false 并返回错误。

write 的 changes 包含变动的元数据字段名和正文是否变化。预览时 changed/created 为 false，wouldChange/wouldCreate 表示计划变化，project 为拟写入内容；实际成功后才报告 changed/created。remove 的预览返回完整目录条目，成功删除后 removed 为 true。

## 检查与异常

check 检查根卡的安全路径、普通文件、UTF-8 和 frontmatter 可解析性，并对已配置 routing 执行上述逐项检查。不扫描正文中的所有 Markdown 链接，不核实事实来源、章节完整度、预算、项目语义或业务完成情况。只有所选 scope 下直接项目目录的 `project.md` 是入口；更深的同名文件与没有根卡的目录不成为项目条目。

| 错误码 | 含义 |
| --- | --- |
| INVALID_ARGUMENTS / INPUT_INVALID | 参数或写入信封无效，退出 2 |
| PROJECT_ROUTING_INVALID | 显式写入结构错误退出 2；检查存量配置时作为逐项错误、退出 1 |
| PROJECT_ROUTING_ARCHIVED | 显式来源对象已归档，不能作为可采用的预设 |
| PROJECT_KNOWLEDGE_NOT_FOUND / PROJECT_KNOWLEDGE_PATH_INVALID | 配置知识文件缺失或路径含链接/不安全父目录 |
| PROJECT_ROUTING_CHECK_FAILED | 不能完成某项可用性核对；对象/文件错误也保留其原错误码及 field |
| PROJECT_DIRECTORY_MISSING | 读取或发现所需目录不存在，不能当作空库 |
| PROJECT_NOT_FOUND | 指定项目根卡不存在 |
| PROJECT_PATH_INVALID | 项目目录或管理路径含符号链接或不是普通目录 |
| FILE_UNSUPPORTED / FILE_NOT_FOUND | 根卡或输入文件类型不支持或不存在 |
| YAML_INVALID 等 / ENCODING_INVALID | frontmatter 或字符编码不合法，保留原文件 |
| PROJECT_SERIALIZATION_FAILED | 输入序列化后含义改变，停止写入 |
| PROJECT_LOCKED / FILE_LOCKED | 项目锁或根卡元数据锁已被占用，先检查锁持有者 |
| PROJECT_CONFLICT / FILE_CONFLICT | 发布前发现路径、根卡或资料变化，保留并发修改 |
| PROJECT_RESOURCE_UNSUPPORTED / PROJECT_RESOURCE_BUSY | 删除范围包含链接、特殊文件或临时锁定资源 |
| PROJECT_CLEANUP_FAILED | 目录已退出项目集合但清理失败，data 报告 changed、removed 及 recoveryPath |
| PROJECT_IO_FAILED / FILE_READ_FAILED / FILE_WRITE_FAILED | 文件系统操作失败 |

remove 在项目根卡不存在时成功返回无变化，不删除无根卡的资料目录。已有根卡损坏时操作失败；不通过删除绕过无法核实的输入。清理失败时先检查 recoveryPath，不能把失败响应当成“什么都没发生”后盲目重试。

## 文件影响与并发

list/read/check 自身只读。修改类真实调用使用 `.agents/runtime-data/projects/write.lock`，与能力对象锁独立；读和预览不获取该锁。根卡写入和删除同时使用 metadata 文件锁，与通用 metadata 写入互斥。锁不自动根据 PID 删除，遗留锁需先核对。

已有根卡更新复用 metadata 的原子替换与发布前字节、文件身份检查；新根卡写到临时文件后以不覆盖方式发布，并保留原目录资源。删除前复核整个项目目录的内容，再重命名到 `.ksf-project-deleting-<随机值>` 后清理；清理失败保留恢复路径，隐藏临时目录不进入项目集合。

检查和锁保护命令执行期间的变更，不提供上一次 read 与后一次 write 之间的版本令牌；提交完整 body 前仍需由 Agent 核对来源和最新内容。单项目操作不构成跨文件、跨项目或外部工程事务。普通宿主编辑工具不受项目锁强制约束，故发布前仍进行比较。

启动准备可能更新 `.agents/runtime-data/runtime/`，所以命令自身只读或预览不保证整个启动流程零写入。运行依赖保持随包 Node.js，不依赖 Python 或全局 Node。

## 实现与验证

- [命令适配](../../runtime/src/commands/projects.js)：参数、帮助、文本与 JSON、退出码。
- [项目服务](../../runtime/src/services/projects.js)：发现、格式复用、写入、锁和目录删除。
- [纯结构校验](../../runtime/src/projects/routing-schema.js)、[routing 可用性检查](../../runtime/src/projects/routing.js)与[专项测试](../../runtime/tests/project-routing.test.js)：结构、精确引用、来源绑定、局部错误、知识路径及旧项目兼容。
- [服务测试](../../runtime/tests/projects.test.js)与 [CLI 测试](../../runtime/tests/projects-cli.test.js)：创建更新、无元数据、中文名称、预览、部分失败、字节保留、路径隔离、冲突、清理失败和跨 cwd 调用。

实际测试通过范围见本次 `ksf test` 输出；自动化使用隔离临时项目，不修改正式用户项目。返回[索引](index.md)。


## Scope、归档与恢复

未指定 `--scope` 保持 current 行为。list 与无目标 check 支持 current、archived、all；read/write/remove 和指定项目 check 支持 current、archived。响应返回实际 path 与 scope，同名跨 scope 明确区分，不自动合并。archived 范围缺失表示完整空集合；当前项目目录缺失仍报告原有错误。

```sh
.agents/ksf project list --scope all --json
.agents/ksf project read "项目名" --scope archived --json
.agents/ksf project check "项目名" --scope archived --json
.agents/ksf project archive "项目名" --reason "阶段结束，结果及未结事项见根卡" --dry-run --json
.agents/ksf project archive "项目名" --reason "阶段结束，结果及未结事项见根卡" --json
.agents/ksf project restore "项目名" --dry-run --json
.agents/ksf project restore "项目名" --status active --json
.agents/ksf project recover "回执中的操作UUID" --dry-run --json
.agents/ksf project recover "回执中的操作UUID" --json
```

archive 从 current 整体移到 archived，reason 必填且非空；restore 反向移动，status 默认 active，可指定非空字符串。两者不接受 scope，源和目标由动作确定。恢复是继续使用，recover 则核对并回滚一次中断程序操作，二者不同。

归档设置 status 为 archived，恢复设置所选使用状态，不推断业务完成、中止或搁置。根卡正文及结果说明保留，archive_history 数组追加 operation_id、action、at、reason、from、to、previous_status；现有非数组 archive_history 报错保留。首次归档前无元数据的根卡也支持。

预览返回 wouldChange、entries、changes、from/to 及 referenceReview，既不创建档案目录，也不写入历史、锁或日志。实际操作重核库存；目标已存在一律停止，不覆盖合并。在目标 scope 已存在且源已不存在时返回无变化，不重复追加历史。创建当前项目时发现同名档案项目也停止；archived scope 的 write 只维护已有根卡，不直接创建项目档案。

repositories 保持指向原目标，相对路径按新根卡目录重算。相对指向项目内部的工程关联、嵌套 .git、特殊文件、未知临时资源、不支持的链接或跨文件系统移动拒绝；项目内部相对符号链接和外部绝对链接保留，不遍历链接目标。项目材料的普通文件字节保留，根卡元数据按上述规则修改。

referenceReview 给出旧新前缀及移动的 Markdown 清单，资产维护据此审阅出入链接，核对其他当前根卡、知识/档案导航、档案说明及必要引用。程序不批量改写历史 JSON、原始来源表述或全部 Markdown，不证明所有链接或业务内容正确；这部分需 Agent 在已授权范围修复并验收后才能交付。

## 中断、并发与恢复边界

操作基线和根卡改前/拟改字节保存在 `.agents/runtime-data/projects/transitions/<UUID>/record.json`，pending.json 标识尚未收口的操作。程序阶段有 prepared、moved、card-written、completed；项目读和发现仍可使用，其他项目写入、删除及工程关联修改被 pending 阻止。

recover 在项目锁内核对实际所在目录、文件库存、原始或预期根卡字节，再回滚到改前位置及根卡。已完成操作只收尾遗留 pending，不撤销已成功完成的归档。对自身已死亡进程留下的项目锁、可核实的卡片暂存和元数据锁进行恢复；活动写入、他人锁、后续文件/目录修改或目标冲突保留现场并报错。重复 recover 无变化。

恢复不回滚 Agent 另行完成的跨文件入口补丁，资产维护需对自己的基线逐项核实；不承诺跨文件原子事务。系统 launcher recover 只处理系统升级事务，不自动处理项目日志。旧实例不自动移动，原位 status: archived 项目仍可按 current 读取。restore 只处理从档案位置移回；旧原位项目的明确复工请求使用普通 project write 更新 status，不把 restore 的无变化回执当作已激活。

常见新增错误：PROJECT_DESTINATION_EXISTS、PROJECT_ARCHIVED_EXISTS、PROJECT_TRANSITION_PENDING、PROJECT_CONFLICT、PROJECT_EMBEDDED_REPOSITORY、PROJECT_LINK_RELOCATION_UNSUPPORTED、PROJECT_CROSS_DEVICE、PROJECT_RESOURCE_BUSY、PROJECT_TRANSITION_FAILED。失败回执包含可用的 recoveryId/recoveryPath；不得从退出码推断一定没有变更。

旧 routing.knowledge 在 read/list 中原样保留，正文及无关元数据维护可以保留未变旧值；新增或修改 routing 时按 PROJECT_ROUTING_INVALID 拒绝，issues 内含 PROJECT_ROUTING_KNOWLEDGE_REMOVED。归档/恢复同样先验证 routing，须先清理旧字段，失败不产生部分移动。程序不自动改写现有项目，旧字段的路径不再重算。

## 项目管理主件

`project management` 管理根卡旁的一份 `项目管理.json`，完整职责与模型见[共同契约](../project-management.md)。读取缺失文件返回空投影与 `etag: missing`，不初始化；旧检查点、项目正文与聊天保持原位。

```sh
.agents/ksf project management read "项目名" --json
.agents/ksf project management check "项目名" --from "计划输入.json" --json
.agents/ksf project management write "项目名" --from "计划输入.json" --dry-run --json
.agents/ksf project management write "项目名" --from "计划输入.json" --json
```

read 支持 current/archived，write 只支持 current。check 的输入可为 plan 或 `{plan}`；write 输入为 `{plan,ifMatch,operationId}`。ifMatch 使用最近 read 返回的摘要，首次创建为 missing；operationId 为调用方预先保存的 8–128 字符字母/数字/下划线/短横线标识。输入文件路径沿普通 project write 的规则解析；不隐式读取标准输入。

read 返回 state/path/etag/revision/updatedAt/plan/warnings/projection；projection 包含各事项记录层面的 readiness/reasons、ready、在制数量/容量、状态计数与验收缺口。程序不判断业务价值、真实权限或证据语义。check 不写文件，缺失引用/循环/无证据完成等返回具体字段错误；读取已保存主件时，外部证据或来源失效保留内容并警告，不以空计划覆盖。

写入与归档共用项目锁，单文件临时刷盘后原子发布；并发版本变化返回 PROJECT_PLAN_CONFLICT，保留调用方草稿，读最新后合并。同一最近操作号同内容重放返回 replayed；同号不同内容返回 PROJECT_PLAN_OPERATION_CONFLICT。只保留最近一次写入回执：若后续操作已生效，旧操作重试仍受 ifMatch 保护，调用方应读当前内容对账，不能假定无限历史幂等。

损坏/未来格式、符号链接、越界、本地证据不可读取、归档项目写入明确失败。HTTP(S) 证据仅校验 URL 结构，不联网证明内容；本地证据限定当前 KSF 内普通文件，不开放运行数据或身份。文件上限 1 MiB，每类条目最多 500 项。

应用 SDK 的公共 `projects` 服务提供 `managementRead`、`managementCheck`、`managementWrite`，参数同服务的 `{name,scope,data?,dryRun?}`，返回 `{data,errors}`；宿主固定当前 workspace，不接受调用方切换根。后端调用通过 `context.services.call('projects','managementRead',[{name,scope}])`，需 filesystem 权限。应用不导入 Core 内部模块。
