# 下载后首次使用

目标：确认拿到了匹配平台的完整工作区，核对必要身份与运行环境，完成一项不依赖付费模型的初次工作。

## 前提与准备

从官方 Core 模板创建自己的私有仓库并克隆，或下载并校验匹配平台的 Core 包（macOS ARM64/Windows x64），解压到空目录；目录名不参与系统版本身份。一台设备默认一个实例，先核实已有实例，避免复制整套运行数据另开服务。

使用随包入口运行，无需为普通使用预装Node、npm、Python或Git。工程仓库功能需要Git；应用开发另有[开发环境要求](../app-development/quickstart.md)。离线可以使用已有包，安装远程应用或检查更新需要网络。

## 1. 核对入口

在实例根打开终端。macOS：

```sh
./.agents/ksf hello --json
./.agents/ksf --help
```

Windows PowerShell：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .agents/ksf.ps1 hello --json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .agents/ksf.ps1 --help
```

预期hello的ok为true，ksfRoot是当前实例，Node为随包版本。首次调用可能校验和解压运行时；它不检查或安装远程新版。若失败，保留完整错误，按[启动排障](../operations/troubleshooting.md#入口与运行时失败)处理，不手动改manifest或用全局Node绕过。

## 2. 初始化与定义必要信息

新 Core 模板仓库或更新包先执行固定入口 `instance init --json`，联网验证精确 Core 来源、创建缺少的用户文件，并将本地个人分支改为 `main`。它保留已有个人内容，不提交、推送或修改 origin。完成后重新执行 `context entry --json` 进入孵化。已初始化实例无需重做；完整过程见[实例初始化](../cli/instance.md)。

阅读根USER.md和BOT.md，填写或明确要求Agent维护自己的稳定身份、偏好及协作方式。两份文件保持普通Markdown；技术身份与实例名称另由配置中心维护。

```sh
./.agents/ksf config read identity --json
./.agents/ksf config read instance --json
./.agents/ksf config list --json
```

缺值不代表损坏，读取不会生成默认配置。按[身份与配置](identity-configuration.md)明确保存名称等值，已有记录使用read返回的etag。模型凭据、通信信任和业务内容不是首次使用必填项。

新模板通过context entry进入首次孵化，Agent一次确认称呼、实例名、局域网本机名和登录启动，保留你的原始请求。可以暂停或明确跳过；旧实例缺少孵化状态时正常进入runtime，不重新初始化。完成或跳过后重新取入口再继续原任务。完整规则见[孵化接口](../cli/incubation.md)。不需要填写所有能力设置或配置外部AI。

## 3. 打开工作台

```sh
./.agents/ksf open --json
./.agents/ksf service status --json
```

Windows把入口换为上述PowerShell调用。open启动或复用主服务并打开浏览器。默认本机地址为http://127.0.0.1:1313/；已配置hosts时可使用http://ksf.ai:1313/。直接输入URL无法唤起已经停止的服务。

进入“KSF手册”，再按需要打开项目、文档或终端。关闭浏览器不停止后台；自启动是独立选项。若端口占用，不会自动切换到另一个端口，先用service doctor核对。

## 4. 完成第一项工作

让支持文件和终端工具的宿主Agent打开本实例，读取根AGENTS.md，再提出一项明确的文件整理或分析任务。按[第一项工作](first-task.md)核对成果和恢复信息，不必先建立整套能力。

## 成功标准与失败处理

- 固定入口返回正确根目录和随包运行时。
- 人和Agent知道本次目标、范围以及必要协作偏好。
- 工作台能打开当前系统文档。
- 第一项工作有实际产物、检查结果和必要的继续入口。

hello成功只证明启动链路；工作台可见不证明AI已配置或通信已配对。保存失败保留原文与草稿，不使用默认值覆盖损坏文件。升级、初始化和备份是不同操作，见[日常维护](../operations/daily.md)。
