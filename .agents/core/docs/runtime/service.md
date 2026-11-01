# KSF 后台服务

每台设备默认一个实例。主服务管理应用进程、通信、AI 和会话，界面只是客户端。关闭浏览器不停止后台；界面资源损坏时管理 API 和 CLI 继续工作。默认监听 `127.0.0.1:1313`，配置本机 hosts 后使用 `http://ksf.ai:1313/`。通信监听端口独立配置。

## 使用

```sh
.agents/ksf service start --json
.agents/ksf open --json
.agents/ksf service status --json
.agents/ksf service stop --json
.agents/ksf service restart --json
.agents/ksf service logs --json
.agents/ksf service doctor --json
.agents/ksf service autostart enable --json
.agents/ksf service autostart disable --json
.agents/ksf service autostart status --json
```

Windows 使用 `.agents/ksf.ps1`。`ksf web` 是前台调试入口，默认同一端口，遵守同根服务互斥；退出终端会停止此前台进程。`service run` 是系统服务使用的前台入口，普通使用选 start 或 open。

用户主动调用应用或通信 CLI 时，入口先启动并等待后台，再发送业务请求。并发启动共用一个服务。状态、日志和离线诊断不启动服务；后台扫描和远端消息不会启动已经停止的主服务。业务结果未知时查询原 operationId，不凭启动恢复自动重发。

Mac 登录启动采用当前用户 LaunchAgent；Windows 使用当前用户交互登录计划任务，不保存密码。只启动后台，不打开浏览器。未配置的自启动状态保留未选择，由孵化界面承担默认选中。关闭自启动不停止当前业务。 关闭登录启动只处理本实例的启动项，保留其他实例的设置；无法核实归属时会报错并保留原件。手动停止正常退出，后续主动入口或已启用的下次登录可启动。

浏览器直接访问 URL 需要后台已运行；设备启动脚本和 `ksf open` 才能在后台关闭时启动进程。

## 应用运行管理

```sh
.agents/ksf app runtime list --json
.agents/ksf app runtime status <appId> --json
.agents/ksf app runtime start <appId> --json
.agents/ksf app runtime stop <appId> --json
.agents/ksf app runtime restart <appId> --json
.agents/ksf app runtime logs <appId> --json
```

显式 start 表达手动保活意图；stop 保存设备范围的停止状态，后续界面、CLI、消息和后台协调都不会替用户撤销，start 或 restart 恢复。停用应用仍需先在商店启用。纯界面应用没有后台进程。

停止/重启拒绝新调用并等待在途调用、任务租约、通信发送和已接收的传输会话。排空期间不接收新消息会话；已经受理的材料传输与回执可以完成。超过等待时间返回 APP_BUSY。显式 `--force` 可终止进程，业务结果仍需按业务操作回执核对，不能视为取消成功。

## 数据、诊断与恢复

服务策略、进程锁及日志位于 `.agents/runtime-data/service/`，控制入口位于 `.agents/runtime-data/web/control.json`；应用停止/手动运行策略和日志位于 `.agents/runtime-data/applications/`，只属于本设备。业务数据仍在 `.agents/user-data/applications/`。

启动锁与宿主锁分别保护启动协调和实际进程生命周期，记录 PID、进程起始身份及随机标识。服务状态还核对实例根目录和健康响应身份。启动请求带独立标识；后续启动或用户停止使旧请求失效，延迟进程不能在手动停止后重新建立后台。端口被其他程序占用时明确失败，不自动改用另一个端口。无法核实的活进程不强行接管。

service doctor 提供状态、日志及恢复提示；运行面板显示通信发送、接收和应用投递数量。日志尾部受大小限制并遮蔽常见凭据；应用开发者仍不得主动打印业务密钥。控制令牌和通信私钥不进入状态接口。

配套升级时先准备 Core、全部新应用和安装索引，再停止旧后台、一起切换。失败时恢复完整匹配快照；新 SDK v1 不加载旧应用契约。
