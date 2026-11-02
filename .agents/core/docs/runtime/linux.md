# Linux 核心运行（兼容 WSL2）

开发目标为 Linux x64、glibc 用户空间。首批兼容目标是 Ubuntu 22.04/24.04、Debian 12；WSL2 中使用同类发行版，执行同一 Linux 启动器，不调用 Windows 程序。ARM64、Alpine/musl、跨机器共享的 NFS 运行目录不在本轮支持范围。

## 启动与依赖

在实例根目录使用 `.agents/ksf`。普通启动只从随包官方 Node.js 24.21.0 归档准备精确运行时，不下载、不使用全局 Node。需要 POSIX Shell、awk、GNU coreutils（包括 stat、sha256sum）、tar/gzip、procps（ps）和 util-linux（flock）。Linux 的 `build` 另外需要 `/usr/bin/python3` 读取独立 JSON 构建输入；普通命令不依赖 Python。缺失工具时由用户安装，KSF 不修改系统包或镜像设置。

```sh
.agents/ksf hello --json
.agents/ksf context entry --json
.agents/ksf runtime verify --json
.agents/ksf service start --json
.agents/ksf service status --json
.agents/ksf service doctor --json
.agents/ksf service stop --json
```

HTTP 默认只监听 `127.0.0.1:1313`，使用启动回执中的 `directUrl` 手动访问。支持 start/status/stop/restart/logs/doctor；WSL2 中后台随 Linux 环境关闭而结束，不提供宿主登录自启动。

Linux 安装锁用 flock 有界等待约 30 秒；恢复锁占用时立即返回 RECOVERY_BUSY。锁文件保留，锁由文件描述符持有，退出自动释放；正常执行业务前主动关闭描述符。事务恢复仍使用协议 1，进程身份为 LC_ALL=C 的 ps lstart 规范化文本，与 JavaScript 平台适配一致。可以在 Core 或 Node 缺失时调用 `.agents/ksf launcher recover`。

## 能力与发行边界

核心 CLI、构建、测试和后台 HTTP 可用。原生工作台终端、Codex Desktop 联动、自动打开 URI、登录自启动暂不支持；请求在原生模块加载、进程启动或配置写入之前返回 PLATFORM_UNSUPPORTED。登录自启动可保存 false/null；已有 true 不会被读取操作覆盖，需要显式修改。Linux 新孵化默认不自动打开工作台，登录启动默认关闭。服务状态和配置读取提供平台 capabilities。

桌面连接与资源采集不可用时，监视器返回局部不可用信息，HTTP 健康检查与核心控制接口继续可用。Linux 原生 AI/Codex 执行不在本轮验收范围，不能据此声明已支持。

linux-x64 属于开发运行目标。正式发行默认仍只选择原有 Mac/Windows 目标；显式 Linux 正式构建、发布及发布恢复请求拒绝。不会生成或冒充正式 Linux 发行凭据。

## 验证

`.agents/ksf test --suite full --component core --json` 执行清单中明确登记的 Linux 核心覆盖，报告同时列出平台不适用项；它不是全部产品功能的 Linux 验收。Ubuntu 22.04/24.04 的原生 CI 独立运行并上传报告，不参与原有 Mac/Windows 正式发行证明。

本轮实测与尚缺环境证据见 [Linux 验证记录](linux-validation.md)。
