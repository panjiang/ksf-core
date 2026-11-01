# macOS 与 Windows 平台边界

Core 的业务协议、对象/项目、能力路由、聊天状态、任务归档、应用、AI、通信与升级事务共用 JavaScript 实现。CLI、HTTP 和应用 SDK 调用相同服务，不各自维护 Windows 业务分支。

依赖方向：入口 → 业务服务 → 平台接口 → 原生实现。接口装配在 `runtime/src/platform/index.js`，具体实现位于 `darwin.js`、`windows.js`；包描述由 `catalog.js` 集中管理。`shared` 可调用平台基础操作，平台不得反向依赖业务服务。静态依赖检查见 `runtime/tests/runtime-layers.test.js`。

| 边界 | 共享契约 | 平台实现 |
| --- | --- | --- |
| 程序调用 | 可执行文件与参数数组，不拼接业务 Shell | macOS 系统工具；Windows 原生 exe / UTF-16 编码 PowerShell |
| 进程 | 仅对存活的直接子进程操作；记录 PID 与启动身份 | macOS 进程组 / ps；Windows StartTime UTC ticks / taskkill 子树 |
| 文件发布 | 同目录临时文件、完整写入、替换；失败保留原件 | Windows 对 EPERM/EACCES/EBUSY 有上限重试；目录 fsync 只忽略明确不支持错误 |
| 模式 | 包及 Git 声明保留 0644/0755 | NTFS 不模拟 chmod；采用已知声明，固定 POSIX 启动器规范为 0755 |
| Desktop | 同一帧协议、状态、回执、未知结果对账 | macOS Unix socket；Windows `\\.\pipe\codex-ipc`，当前用户 MSIX 动态发现 |
| 打开会话 | `codex://threads/<id>` | macOS open；Windows 交互会话 Start-Process |
| 运行时 | SHA256、Node 版本、安装身份、锁、分阶段替换和恢复 | macOS tar.gz；Windows 官方 ZIP，仅提取校验后的 node.exe/LICENSE |

持久化的实例相对路径统一 `/`，绝对路径在文件 I/O 边界使用系统路径。不能把盘符当作 URI，也不能将 junction/symlink 当作普通受管目录。Markdown 相对引用按平台路径解析后转为 `/`。Windows 字段名如 Path/SystemRoot 采用不区分大小写的环境选择。

在 Node 就绪前，固定 `.agents/ksf` / `.agents/ksf.ps1` 只处理 launcher protocol 1 恢复，再进入 Core 的 bootstrap。两端原生引导遵守相同的归档摘要、成员摘要、安装记录、独占锁、旧版本保留与失败恢复契约；就绪后使用同一 JavaScript CLI。正常启动不使用全局 Node。

新增目标为 `win32-x64`，官方 Node 包名为 `win-x64`，映射不能通过简单字符串替换散落到服务。Windows 随包版本 24.21.0，ZIP 的可信摘要保存在 build.json，来源为 Node 官方 SHASUMS256.txt。Core 发行包仍为 tar.gz；中文或超出 USTAR 名称边界的路径使用明确 UTF-8 PAX path 记录。解包器只接受受约束 path 记录和普通文件，拒绝链接、重复成员及越界路径。

三方文本合并使用随包 MIT `node-diff3` 3.2.1，来源、摘要和许可在 `runtime/src/vendor/node-diff3/`，保持 local/base/release 冲突格式。升级不依赖系统安装的 diff3。

Windows Desktop CLI 已实测 `0.165.0-alpha.1.2` 的本地认证、App Server、IPC 和真实托管 AI 执行；`0.166.0-alpha.5.1` 在 Windows 原生首次初始化、会话接续、后台账号认证及飞轮托管 AI 的事件流与最终输出验收通过。兼容表按 Windows 精确版本登记，后者的 Desktop IPC 验收仍单独记录。稳定 0.163.x 原有范围保持。新版本应先做实际协议与执行验收，不能直接放宽到全部 alpha。

Desktop URI 操作需要 当前用户的交互会话；SSH 会话可访问命名管道及 CLI，但系统可能拒绝启动桌面 URI。工作台入口以当前用户 Interactive Token 启动；启用自启动后添加当前用户登录触发器。发现会话持有者时只对暂时无客户端和超时进行有界只读重试；发送结果未知时保留回执并对账，不自动重发。

## 验证入口

- 共用业务与平台契约：`node --test runtime/tests/*.test.js`（在 runtime 工作目录执行时用 `node --test tests/*.test.js`）。
- Windows 原生引导：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .agents/core/runtime/tests/bootstrap-windows.ps1 -Root <实例根>`。
- POSIX Shell 引导测试只在 macOS 运行；Windows 使用上述真实 ZIP/PowerShell 测试替代。其他跳过必须单独说明平台原因。
- 手动工作台：`.agents/core/runtime/tools/workbench-windows.ps1 -Action start|stop|status|logs`；统一后台日志在 `.agents/runtime-data/service/`。

支持目标与已验收结果分开。Windows 原生隔离评估、其他 CPU 架构、真实断电和长期运行不能由单次单元测试推断为通过；具体结果以本次验收报告为准。

## Windows 手动使用

在资源管理器中运行 `runtime/tools/start-workbench.cmd`；停止和日志分别使用同目录 `stop-workbench.cmd`、`logs-workbench.cmd`。这些入口定位其所在实例，默认监听 127.0.0.1:1313。计划任务以当前用户交互身份运行；service autostart enable 添加登录触发器，disable 移除触发器。关闭浏览器不结束后台；停止入口发送带实例 nonce 和启动身份的请求，避免结束其他实例。

命令示例：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\ksf\.agents\ksf.ps1 hello --json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\ksf\.agents\core\runtime\tools\workbench-windows.ps1 -Action start
```

Mac 可使用 `ssh -N -L 1313:127.0.0.1:1313 user@windows-host`，然后访问 `http://127.0.0.1:1313/`。浏览器写接口按当前 Origin 校验，转发不向局域网开放工作台 HTTP。ConPTY 和 Desktop 原生交互以 Windows 本机会话验收为准。

## 应用与工作台的边界

应用应发布一个通用 `.ksfapp`，macOS 与 Windows 安装相同 SHA256 的包。应用业务、界面、状态格式和调用参数不按操作系统分叉；平台特性由工作台宿主实现。新清单严格按 SDK v1 校验；需要原生平台约束时可声明 `target` / `nodeAbi`。

- `context.services.call('terminal', method, [input])`：create/list/read/write/resize/close。宿主从已验证的窗口租约注入 runtimeId/instanceId，应用不传 PID 或选择所有者。终端尺寸、UTF-8 数据、输出游标和退出回执共享；Shell、登录参数、ConPTY/PTY、原生二进制由宿主选择。窗口关闭、租约过期和后端进程退出都会清理该窗口会话；其他窗口不受影响。SDK v1 后端按应用共享；终端资源按窗口租约隔离。
- `context.services.call('git', method, args)`：Git 应用仅调用公共服务。仓库发现、可执行文件、环境清理、进程树、工作区写入锁和操作回执由工作台处理。回执位于 `.agents/runtime-data/applications/data/com.ksf.git/operations.json`，避免回执写入反过来改变实例仓库的 Git 版本；首次使用会复制旧用户区回执并保留原件，继续核对既有请求，不重发历史操作。关闭窗口不取消已受理操作。
- `context.services.call('projects', 'list'|'read'|'tasks', [input])`：宿主直接调用共享项目与任务服务；项目应用不再生成 Shell/PowerShell 命令。
- `context.storage.read(name)` 返回 `{exists,text,etag,path}`；`write(name,text,{ifMatch?})` 返回 `{etag,path}`。宿主限定到调用应用的数据目录，只接受普通 `.json/.md/.txt` 文件和 8 MiB 以内文本；同目录原子替换、fsync、原生重试及进程锁共用实现。ifMatch 可为 null，表示文件须尚不存在；冲突保留原件。SDK `createJSONStore` 继续负责业务校验、迁移和 revision，通过宿主保存。独立 Node 测试的旧 context 保留便携式文件后备实现。

`runtime/native/node-pty` 是工作台原生依赖，MIT 许可与上游来源随包。重建：在 `runtime/native-build` 以锁文件运行 npm ci，然后使用随包 Node 执行 `runtime/tools/vendor-pty.mjs`。原生模块不再进入终端应用包。宿主适配器的真实执行范围仍为本轮 Mac ARM64 与 Windows x64。
