# context 命令

固定入口另提供 `ksf context entry --json`，按实例孵化状态返回完整 Core 工作要求，不启动后台或初始化状态；详见[孵化接口](incubation.md)。下文 capabilities 契约保持不变。

## 状态与职责

已实现 `capabilities`。为 Agent 组织当前 KSF 的完整有效 Cooperation、Partner 发现信息，输出先协同组、后搭档组；排列不是实际选择顺序。复用对象服务的有效列表查询，用户接管、归档回退、冲突及固定入口保护均由对象层处理，不维护第二套扫描或 YAML 解析逻辑，不启动对象 CLI 子进程。

描述由对象作者维护，程序忠实取得 `description`，不补写、改写、截断或评价其业务充分性。程序只组织数据；匹配、澄清和后续行动由 [ability-route](../../abilities/competencies/ability-route/competency.md) 与 Agent 判断。

## 调用与参数

从 KSF 根目录调用；其他工作目录使用入口绝对路径：

```sh
.agents/ksf context capabilities
.agents/ksf context capabilities --json
.agents/ksf context --help
.agents/ksf context capabilities --help
```

| 参数或操作 | 行为 |
| --- | --- |
| 无操作、`context --help`、`context -h` | 显示命令组帮助，不执行发现 |
| `capabilities` | 返回两类完整有效对象的发现描述，默认可读文本 |
| `capabilities --json` | 同一业务结果的 JSON 表达，无值且只能出现一次 |
| `capabilities --help`、`capabilities -h` | 显示操作帮助；不能与其他选项或目标组合 |

没有位置目标；支持 --source <源ID> 限定能力源范围，不提供其他对象过滤参数。未知操作、多余参数、重复选项、带值的无值选项及混用帮助均报调用错误。`--` 不引入额外目标或选项能力。未提供独立的 discover/catalog 命令或兼容别名。

## 有效范围与读取边界

直接使用现有 Cooperation、Partner 的默认有效列表，每次查询当前文件，没有持久化索引。对象层按公共规则处理系统、个人与已关联源定义、精确身份、状态与冲突；context 不按系统/用户分组，也不提供另选来源的规则。

结果保留固定根入口协同和入口搭档，并通过 `protected=true` 标明。ability-route 从下游候选中排除这些固定入口，按当前明确要求、有效原安排、适用项目预设及全局协同/搭档形成安排，再判断通用 Agent；context 不执行语义匹配或宣布选择成功。项目预设不会过滤此全局集合，显式配置来源只解析对应项；只有用户或已确认范围明确限定源时才使用 --source 范围查询，不把该范围冒充全局。

只输出选定的发现字段，不返回原始元数据映射、版本、修订、正文、声明依赖、基本功、数据包或附属资源。对象底层会读取并校验对象定义，读取不代表这些内容已进入 Agent 上下文，也不代表专业适用性已验证。候选正文继续通过对应对象 `read` 命令按需取得。

## 文本与 JSON

文本先显示总体完整性，再显示 Cooperations、Partners；各组标明 complete/incomplete，空组显示 `(empty)`。每项提供名称、ID、定义路径、固定入口标记和完整 description。原始描述保留首尾空白和换行，不缩写或增加业务解释。

JSON 沿用统一信封：

```json
{
  "ok": true,
  "command": "context",
  "operation": "capabilities",
  "data": {
    "complete": true,
    "cooperations": { "complete": true, "objects": [] },
    "partners": { "complete": true, "objects": [] }
  },
  "errors": []
}
```

两组 `objects` 中每项包含 `id`、`name`、`description`、`path`、`protected`、`source`；能力源对象还含 `source_root`。系统/个人 path 相对 KSF 根，源对象 path 为实际绝对路径。顺序沿用对象服务的稳定顺序，不按语义相似度排序，不静默裁减数量。

## 不完整结果与错误

分别取得两类结果，单组失败仍保留另一组及当前可核实对象。两组均完整才有总体 `complete=true`。空列表且完整表示范围内没有有效对象；不完整的空列表不能证明没有对象。

Core 源码仓库不要求创建用户能力目录，未创建的用户范围视为空集合；发行工作区缺失用户能力目录仍报告不完整。源码识别与扫描边界见[对象公共规则](objects.md)。

业务文本与 JSON（包括错误）输出 stdout，日志和启动错误输出 stderr。错误项包含 `code/message`、所属 `type` 及底层可提供的 ID、路径等定位信息；复用对象错误码，意外查询失败报告 `CONTEXT_QUERY_FAILED`，不回显对象正文。调用错误采用 `INVALID_ARGUMENTS`，data 为 null；尚未识别合法操作时 operation 为 null。

| 退出码 | 含义 |
| --- | --- |
| 0 | 完整成功，或正常显示帮助 |
| 1 | 不完整或执行失败，仍需读取 stdout 中的有效项与错误 |
| 2 | 操作、参数或调用格式错误 |

发现不完整时，Agent 可以继续核对不依赖缺失范围的候选，不能宣称已排除全库协同或直接据此决定不存在匹配。详细处理沿用 ability-route。启动层尚未进入业务处理器时可能只有 stderr，不保证业务 JSON 已产生。

## 文件影响、实现与验证

命令自身只读，不改对象、正文、索引、缓存或运行状态。共同 bootstrap 仍可能准备 `.agents/runtime-data/runtime/`。内部复用对象服务，不重新实现覆盖、校验或排序逻辑；对象范围与规则见[公共对象命令](objects.md)。

CLI 适配在 `runtime/src/commands/context.js`，组合服务在 `runtime/src/services/context.js`。测试见 [context.test.js](../../runtime/tests/context.test.js) 与 [context-cli.test.js](../../runtime/tests/context-cli.test.js)，覆盖摘要保真、有效覆盖、归档回退、固定入口、部分失败、帮助、参数、退出码、跨工作目录与只读行为。自动化测试与真实路由走查分别验收，不把结构成功当作业务匹配正确。

### 首次 context 命令验证（2026-10-15，macOS ARM64）

- 当时通过随包入口执行 `ksf test`，123 项全部通过，其中 context 新增 13 项；没有跳过或失败。四类能力模型调整后的回归见[对象验证记录](objects-validation.md)。
- 真实执行文本命令，并从其他工作目录执行 JSON 命令，均退出 0、complete=true。该次验证返回 1 个固定入口协同、2 个搭档，其中入口搭档为 protected；普通下游候选为 ksf对象设计师。
- 路由走查采用模拟输入“完善一个搭档的职责与基本功配置”。实际取得上述摘要，排除固定入口后没有普通协同，依据摘要选择对象设计师；实际通过 `partner read partner.ksf.object-designer --part all --json` 读取正文，再按其精确声明读取 `competency.ksf.partner-design@0.1.0`，两次均退出 0、errors 为空。确认该任务属于搭档设计责任，下一步应取得目标搭档与实际问题，再按方法处理。
- 这是当前 Agent 的路由走查，使用了真实程序和正文读取；没有执行新的搭档设计任务，也没有独立会话、多 Agent 或长期效果验证。

后续 context 操作按真实需求另行设计；当前不提供项目、知识或任务状态的组装接口。[最小运行闭环](../runtime/minimal-runtime.md)中的项目发现与根卡读取使用 [project CLI](project.md)，资料和知识仍按基本功按需读取，不是新增的 context 程序接口。

返回[命令索引](index.md)。

2026-10-16 重构后，当前完整发现为 1 个固定入口协同和 3 个搭档：runtime 固定保护，maintainer 与对象设计师为普通候选。真实 CLI 已核对 complete=true、errors=[]；维护角色可发现和派生，固定入口仍从下游候选排除。

## 能力源过滤

默认聚合个人、全部已关联源和系统的有效协同/搭档。--source <源ID> 则聚合个人、指定源和系统，保留个人优先与固定入口。每项新增 source，源对象还含 source_root 和实际绝对 path；description 仍原样提供。多源同 ID 歧义返回 SOURCE_AMBIGUOUS 和候选，按明确源重新发现，不按配置顺序猜测。详情见[能力源协议](../sources.md)。

未初始化的 Core 模板或原始更新包优先返回 mode=instance-setup，固定定义引导显式 instance init。入口本身只读本地状态，不联网查版本；成功初始化后重新取入口，再进入 incubation/runtime。正式 Core 源仓库依据自身 Git 根与官方 origin 识别，不在官方源上创建个人资料。
