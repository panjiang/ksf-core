# Codex Desktop 项目对话

`codex-conversations-v1` 是工作台的原生会话服务，当前已接入macOS和Windows，精确客户端版本与原生验收范围见[平台说明](runtime/platforms.md)。项目应用通过 SDK v1 公共服务桥调用；Desktop 执行并保存线程，Core 保存关联与操作回执。DeepSeek/API 和隔离的 Codex CLI AI 任务服务继续使用原有契约。

系统设置“AI 任务服务”提供 Desktop 连接状态、详情及项目入口。其他业务可使用 `@ksf/sdk/ai-services` 的 `createAIServiceClient` 统一发现/选择任务或会话路径，再通过其 conversations 客户端接续；仍需声明 codex-conversations 权限，不会自动拓宽权限。调用示例见[统一AI接入](app-development/ai.md#按业务选择执行路径)。

## 调用与身份

应用声明 `codex-conversations` 权限，后端使用 `@ksf/sdk/codex-conversations` 的 `createCodexConversationsClient(context)`。宿主从已核验的应用包绑定 appId、version、releaseDigest，拒绝未声明权限或不符合当前SDK v1完整契约的应用。根目录由宿主提供；接口不接受 cwd、IPC 地址、任意方法或持有者参数。

| 方法 | 输入 | 结果 |
| --- | --- | --- |
| check | 无 | 当前平台、连接可用性与契约版本；不发起模型轮次 |
| create | operationId、project{name,scope}、text、可选 title | 异步操作回执 |
| attach | taskId、project | 核验历史归属与原生身份后关联；不能匹配则只读 |
| read | threadId | 有界消息、当前轮次、问题/计划、KSF 路由及聊天状态 |
| history | threadId、offset、limit(1–50)、可选 version | 最多 256 KiB 一页；单条过长明确标 truncated |
| send | operationId、threadId、text、mode(new/steer)、补充时 expectedTurnId | 异步回执；运行中不会自动把新一轮转换成补充 |
| events | threadId、afterVersion | 合并后的最新状态；变化才附 snapshot，不暴露原生状态树 |
| interrupt | operationId、threadId、expectedTurnId | 核对准确轮次后请求停止 |
| answer | operationId、threadId、version、request{type,value}、answers；或 planRevision | 只处理普通问题和明确执行计划；审批留在 Desktop |
| openDesktop | threadId | 打开已关联原生线程；不创建或投递消息 |
| operation | operationId | 原操作进度及待核对结果 |

操作编号在应用身份内唯一。同编号同请求返回原回执，同编号不同内容拒绝。操作通常立即返回，应用再轮询，不占用公共 RPC 的 20 秒窗口。关闭项目窗口只结束观察，Core 中的操作继续完成。项目应用保存最近选择及操作编号；草稿留在窗口会话中。

## 创建与接续

1. 使用 Desktop 随包 CLI 启动短生命周期 App Server，分页读取 Codex 项目，按规范化根目录精确匹配唯一项目；以 KSF 根和原生 projectId 创建持久线程，并核对原生返回的项目身份。缺少、歧义或不匹配时停止，不退回普通对话。KSF 内的业务归属项目仍保留在首句定位中，与 Codex 侧栏项目分开。
2. 设置名称，注入最小事实元数据，等待草稿写进程退出。此阶段不启动模型轮次。
3. 用 `codex://threads/<id>` 打开 Desktop，轮询只读持有者发现。
4. 经持有者发送一次正常 userMessage。首句包含明确项目定位以及逐字保留的用户原文；不额外增加“上下文就绪”轮次。
5. 之后开始、补充、停止和回答均通过 Desktop owner/follower IPC，继承线程设置。

### 聊天状态权限

默认沿用 Codex 权限。`workspace-write` 递归保护 `.agents`，因此 `ksf chat use/write` 写入轮次、变量时可能反复请求审批。经用户明确授权并配置根目录 `.codex/config.toml` 中的 `ksf-workbench-chat-state-v1` 命名权限后，工作台创建新线程时显式选择它，不修改已有线程。服务仅检查配置，不写入或修复配置。

当前 CLI 要求定义 `[permissions]` 时同时提供顶层 `default_permissions`；只添加 profile 或只保留选择器都会使配置加载失败。选择器会影响当前根下其他新会话的默认权限，因此不能把根配置安装描述成只影响工作台。配置的拥有者须整体管理选择器和 profile。此处的 `stateProfileBlock` 只是核验所需的 profile 内容，不能单独当作完整配置安装。首轮实机曾漏验这一要求并发生交叉回退，现有实例由用户安排的 Workbuddy 修复；接入服务不再参与该文件写入。

此配置基于 `:workspace`，保留 `.agents`、`.git`、`.codex`、`.aws` 的只读保护，只给当前根的 `.agents/user-data/chats` 和 `.agents/runtime-data/chat-state` 增加写权限。普通业务目录沿用工作区写权限，网络和审批沿用原策略。配置模板由 `codex-conversations/permissions.js` 提供，不由服务自动安装。检测到不完整或改变的受管配置时停止创建，不静默换权限；App Server 必须允许选择该 profile 且原生返回相同 profile 才交接 Desktop。命令、Core 修改和其他受保护写入仍可能需要正常审批。

IPC 使用 4 字节小端长度前缀，帧上限 64 MiB。快照绑定连接代次和已发现的持有者，数字版本较旧的快照被丢弃。历史顺序按 Desktop canonical history 的 islands/entries 取得；不从字典顺序或旧 compact turns 推断当前轮次。推送合并为失效通知，5 秒静默后有界刷新；观察租约 30 秒无查询后解除，不停止原生任务。

大整数原生请求标识在协议层保持整数精度，SDK 使用 `{type:"number",value:"9007199254740993"}` 等显式类型引用；不把数字和同形字符串混同。回答前重新获取持有者与权威快照，核对问题及快照版本。异步公开提问沿用 Assistant 的 question-item ID 和回复信封；密钥问题和命令/文件/权限审批不在工作台回答。IPC 收件确认与问题消费分开核对。

## 状态与恢复

实例状态位于 `.agents/user-data/codex-conversations/v1/state.json`，普通文件、原子发布和写锁保护。保存版本化线程关联、操作哈希、投递状态、前置消息标识及文本摘要，不保存第二份完整聊天正文。不读取或复制认证文件。

`queued → preparing → opening(创建时) → dispatching → accepted`；回答核验通过为 `succeeded`。派发后断线或超时为 `unknown`，不会自动重发。服务退出后的未完成回执也保留待核对；读取原生历史只能在发现一条新的、摘要完全匹配的用户消息时确认投递。存在结果未知操作时拒绝继续派发另一操作。Desktop 离线保留输入及关联，不切换执行端。

现有档案接续通过原生 rollout 元信息核验 KSF 根、排除内部 worker，再以现有 `sessionKey(root,{host:"codex",sessionId:threadId})` 比对 taskId，且核验该项目的历史主归属。不按标题、时间或项目名称猜配。不使用 thread.sessionId 代替实际 threadId，分叉保持独立身份。

KSF 正常从根 `AGENTS.md → ksf-runtime` 进入，能力发现、预设、核对和采用均由 Agent 现行规则处理。Core 只读取现有路由、`KSF_CHAT_STATE_V1` 对应状态与档案。原生 Hook 或显式 `chat sync` 校验来源后维护轮次，CAS 变量规则沿用 `ksf chat`；同轮 steer 不生成另一轮。缺少可靠原生登记时显示 unconfirmed，不造轮次；兼容字段 hookState=observed 表示本轮登记已核实，不单独证明宿主触发过 Hook。项目正式聊天统计仍以已报告归属为准。

## 兼容与验证

适配移植自 KSFAssistant 的本机实际源码，含 MIT 许可、源文件摘要和私有协议兼容边界，见 [NOTICE](../runtime/src/codex-conversations/NOTICE.md)。App Server 使用公开协议，Desktop IPC 属于需按版本回归的私有适配；不能据此宣称任意版本和平台兼容。macOS/Windows之外的平台返回unavailable；支持平台也需满足具体客户端适配范围。

协议与恢复测试：`node --test .agents/core/runtime/tests/codex-conversation*.test.js`。另运行 SDK 测试、项目应用构建/安装测试以及受影响的应用宿主、chat、task 测试。程序测试不能代替工作台新建、Desktop 项目列表可见、原生消息、双端续聊及 KSF 状态的实机验收。
