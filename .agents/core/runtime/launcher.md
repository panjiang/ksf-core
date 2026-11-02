# 固定启动与恢复入口

入口与事务恢复协议为 1。Core 更新包使用 schema 3 文件校验清单，已安装实例及用户模板使用 schema 4 精简发行凭据；两者均不内嵌原版正文。恢复逻辑依据事务协议执行，不把发行凭据 schema 当作恢复协议。当前入口位置如下，旧根入口迁移由系统更新处理，不保留运行时路径别名或转发文件：

| 平台 | 入口 | 当前范围 |
| --- | --- | --- |
| macOS | `.agents/ksf`（系统 `/bin/sh`） | 启动、恢复及现有 Core 命令 |
| Windows | `.agents/ksf.ps1`（Windows PowerShell 5.1 及以上） | 独立恢复、路径检查、参数/标准输入转交；随包 Node 24.21.0 ZIP 与共享 CLI 已接入 |

两个入口都放在可整体替换的 `.agents/core/` 外。Linux 尚未验证；Shell 恢复锁目前使用 macOS shlock。

## 稳定职责

入口只定位根、检查路径、恢复事务、准备本机运行目录、加载指定平台的 Core bootstrap 并转交原始参数。显式维护命令的更新间隔、发行源、Node 安装和业务命令均归 Core。

入口仍属于发行清单管理，允许缺陷修复；内容及权限不变时，普通升级不替换其文件。修改入口或恢复协议必须同时验证事务生产端和两个恢复端，不以候选的 runtime verify 代替全部恢复验收。

### 无运行时恢复

```sh
./.agents/ksf launcher recover
```

Windows PowerShell：

```powershell
& .\.agents\ksf.ps1 launcher recover
```

若本机策略阻止已审阅的脚本，可以为本次进程调用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\.agents\ksf.ps1 launcher recover
```

入口不修改全局执行策略；组织组策略仍可能限制脚本执行。不要求 Git Bash、WSL、预装 Node 或管理员权限。PS1 直接调用，当前不增加 CMD 包装层，以减少参数二次解析。恢复命令仅证明恢复契约，业务覆盖以实机验收报告为准。

`launcher recover` 成功退出 0，其他 launcher 参数退出 2；路径、锁、事务、bootstrap 等错误退出 1，诊断写 stderr，正常 Core 的 stdout 由 Core 持有。

### Core 转交契约

- 根目录按入口自身位置定位，不依赖 cwd 或调用者提供的 KSF_ROOT。
- 入口设置 KSF_ROOT、KSF_INSTALLED_LAUNCHER=1、KSF_LAUNCHER_PROTOCOL=1。
- Shell 加载 `.agents/core/runtime/bootstrap.sh`；PowerShell 加载 `.agents/core/runtime/bootstrap.ps1`。
- Core 定义 `ksf_bootstrap_main`，接收原参数列表。Shell 最终 exec 对应程序；PowerShell 函数设置 LASTEXITCODE 或显式 exit，入口原样返回该状态。
- PowerShell 必须用参数数组传递，不拼接命令文本或 Invoke-Expression。未来向 node.exe 转交时仍需验证 Windows PowerShell 的本机参数编码；原生参数、标准输入、PowerShell 管道及直接 -File 均由 bootstrap-windows.ps1 验证。
- Windows bootstrap 缺失时报 BOOTSTRAP_MISSING，入口不自动选择全局 Node、下载程序或宣称业务可用。

## 恢复事务协议 1

位置固定为 `.agents/runtime-data/system/transaction/`。生产端完成基础元数据后，再原子公布该目录。

| 文件或目录 | 约定 |
| --- | --- |
| protocol | 精确值 1；缺失或未知时保留材料并停止 |
| owner、owner.start | 正整数 PID 和启动身份；macOS/Linux 为 LC_ALL=C 的 ps lstart 规范化文本，Windows 为进程 StartTime 的 UTC ticks 十进制字符串 |
| name | 以 ASCII 字母或数字起始，其余只含 ASCII 字母、数字、点、下划线或短横线的归档名 |
| old-core、new-core | 旧系统与候选系统；整体目录交换 |
| old-root、new-root | 有变化的 AGENTS.md、.agents/ksf、.agents/ksf.ps1 的完整前后快照；安装后保留 new-root |
| root-intent/相对路径 | 写根文件之前记录替换意图，解决替换后、记账前断电的窗口 |
| committed | 正式切换完成；出现后只完成归档，不撤销升级 |

未提交时，先核对所有带替换意图的根文件：等于旧快照则无需恢复，等于新快照则可以恢复；其他内容或缺失视为并发改动，报 RECOVERY_CONFLICT，保留当前文件与事务，人工核对后再恢复。准备阶段没有替换意图的根文件保持原样。恢复本身可重复执行。

入口拒绝事务中的符号链接；Windows 同时拒绝 junction/reparse point。恢复使用独占锁：Linux flock 由文件描述符持有，锁文件保留且进程退出自动释放；macOS shlock 回收死亡 owner，Windows FileStream FileShare.None 在进程退出时释放。锁不可用时返回错误供重试。活跃升级不会被恢复；未知协议不能猜测执行。事务归档到 system/failed 或 system/backups，已有同名归档不被覆盖。

这是本机进程中断恢复机制；未对断电时所有文件系统缓存的持久化或恶意并发目录替换作完整证明。

## 验证

- launcher.test.js：无 Core 恢复、缺失 bootstrap、参数和退出码、协议拒绝、准备阶段改动、入口自身替换、根文件冲突、链接、归档及恢复锁。
- system-update.test.js：真实 SIGKILL、逐根文件替换中断、F01 准备失败、并发编辑及普通升级保留入口 inode。
- launcher-windows.ps1：不依赖 Node 的 PowerShell 行为测试，Windows CI 使用系统 Windows PowerShell 5.1；包含 junction 与入口自身替换。
- macOS 上的 PowerShell 验证不等同于 Windows 运行验证。实际通过范围记录在交付结果中。

官方 PowerShell 语义参考：[自动变量与退出码](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_automatic_variables?view=powershell-5.1)、[脚本执行策略](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-5.1)、[File.Replace](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.replace?view=netframework-4.8)。

## 系统级用户数据边界

`.agents/user-data/` 由 Core 的 [user-data 服务](../docs/cli/user-data.md) 按注册格式管理，随用户实例保留。入口不创建默认设置、不读写它的业务字段，也不因增加命名空间而改变恢复协议。正常工作产生的数据继续放正常用户空间。

Linux x64 与 WSL2 共用 POSIX 固定入口，独立恢复不依赖 Core、Node 或 Python。Linux 核心开发范围见 [Linux 平台说明](../docs/runtime/linux.md)。
