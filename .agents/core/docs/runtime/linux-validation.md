# Linux 核心支持验证记录

日期：2026-11-02。实际环境：Ubuntu 22.04.5 LTS、WSL2 x86_64，随包 Node.js 24.21.0。来源为 Core 0.5.2 的本地 Linux 适配分支；没有提交、推送、发布或新增正式 Linux 发行凭据。

## 运行时来源

Linux Node 归档从 npmmirror 国内镜像获取，下载约 58 MB。SHA-256 与 Node 官方 HTTPS 的 v24.21.0/SHASUMS256.txt 核对：`6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff`。首次准备和显式 verify 均验证归档与可执行成员摘要、精确版本。前端依赖通过现有 npm 国内镜像和本地缓存准备，使用锁文件 integrity 校验，未更改系统镜像、代理或 Docker daemon 配置。

## 本机证据与验收入口

- 真实固定入口已执行 build、hello、context entry 和 runtime verify，使用实例内准备的 Linux Node；不使用全局 Node 执行业务。
- 引导测试验证首次安装、热启动、错误摘要、损坏修复、并发安装、中断与旧版本保留；Linux build 在缺失生成清单时可读取独立配置，并拒绝重复 JSON 键。
- 审查修复回归覆盖同平台旧 Node 归档保留、发行包准确选择声明版本、固定提交声明被篡改时拒绝，以及通过 FD 9 继承监听器的冷启动、热启动、显式校验和损坏修复；业务进程运行时确认安装锁已释放。
- 恢复测试验证缺失 Core 时恢复、根文件冲突、入口自身恢复、活跃事务保护、flock 互斥与退出释放。
- Linux 专项验证不支持的操作在配置、后台进程及 PTY 加载前拒绝；完整孵化默认关闭自启动及自动打开；后台可启动、健康检查、重启、诊断和停止。
- 共用后台服务 26 项生命周期与控制测试、配置与 CI 失败回执测试已单独通过。发行测试使用隔离仓库和模拟 API，不代表实际公开发布。监控 HTTP 测试验证桌面不可用不阻断核心请求。
- 前端 TypeScript 检查及生产构建已完成。文档索引使用 documentation.mjs 重新生成并校验。

最终统一检查使用 `.agents/ksf test --suite full --component core --json`，统计与逐文件原始证据保留在本实例被忽略的 `.agents/runtime-data/tests/`；平台不适用项仍列在回执中，不能将核心覆盖扩大为全产品 Linux 验收。实例同步另保留逐文件摘要、备份和可恢复日志，核对用户内容与 Git 配置不变。

## 尚缺原生证据

Ubuntu 22.04/24.04 的原生 GitHub CI 作业已加入源码，本次未推送触发。原生 Ubuntu、Debian 12、macOS 和 Windows 的本轮执行证据尚缺；当前 WSL2 的成功不代表这些环境已经验收。ARM64、musl、原生终端、Desktop 联动、登录自启动与正式 Linux 发行不在本轮范围。
