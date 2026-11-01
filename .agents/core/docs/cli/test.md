# test 命令

现行开发、CI 和发行规则见[统一测试规范](../testing.md)。命令通过本实例固定启动器调用；跨目录使用该启动器绝对路径，Windows 使用 `.agents/ksf.ps1`。

```sh
.agents/ksf test
.agents/ksf test --suite full
.agents/ksf test --component sdk
.agents/ksf test --changed --base main
.agents/ksf test --files .agents/core/runtime/tests/testing.test.js
.agents/ksf test --changed --plan --json
.agents/ksf test --reuse
.agents/ksf test --suite full --shard 1/4
.agents/ksf test --help
```

| 参数 | 行为 |
| --- | --- |
| `--suite quick/full` | 默认 quick，单元及轻量集成；full 包含所选范围全部确定性测试 |
| `--component <名称>` | core、web、sdk、app:完整应用ID；省略覆盖全部第一方组件 |
| `--changed` | 默认从 HEAD，包含暂存、未暂存、未跟踪、删除和重命名两端 |
| `--base <Git引用>` | 仅配合 changed；取引用与 HEAD 共同祖先，再加当前工作树 |
| `--files <路径...>` | 精确登记文件；与 component、changed 互斥，不执行任意脚本 |
| `--plan` | 只读选择、原因、依赖及缺口，不导入测试模块 |
| `--json` | stdout 单个标准 JSON 信封，进度及诊断在 stderr |
| `--reuse` | 仅显式本地 quick 允许；full、CI 拒绝 |
| `--shard <序号/总数>` | 1≤序号≤总数≤64，按平台耗时估计确定分片 |

路径相对 KSF 根解析，支持中文、空格及跨目录调用，文件路径包含空格时加引号。未知组件、未登记文件、越界和参数组合错误不作为空选择；quick 显式选 full 专属文件报错。

changed+full 执行受影响组件完整集合；changed+quick 按输入关系选组，并报告 `requiredFullComponents`，不自动升级。Git 不可用或基准不存在返回失败，可改为明确组件。合法空选择返回 not-applicable，某个空分片返回 empty-shard，平台排除单列。

执行子进程使用同一随包 Node、组件目录和显式文件，清理继承的测试筛选、分片、报告及预加载参数。缺依赖运行失败；plan 仍可列出缺口。不会安装依赖、构建主工程、执行付费 AI 或重启服务。

JSON 信封为 `{ok, command:"test", operation:null, data, errors}`。计划包含选择原因、依赖、范围及 `execution`（最多并行文件数与独占文件集合）；运行包含同一执行策略、逐文件结果、时限、计数、日志、输入指纹、排除项及回执位置。成功缓存只有显式 reuse 才读取；执行前后输入变化即 complete=false。范围外的验证不得由本结果推定。

退出码：0 为所选范围成功或明确不适用，1 为检查或执行失败，2 为参数错误。超时和取消不通过、不复用，并清理本次子进程。运行材料位于忽略的 `.agents/runtime-data/tests/`。

实现见[计划器](../../runtime/src/testing/planner.js)、[清单](../../runtime/testing/catalog.json)和[运行器](../../runtime/src/testing/runner.js)。返回[索引](index.md)。
