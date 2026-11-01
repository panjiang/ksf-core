# system 命令

已实现无 Git 工作区的版本检查、显式更新、手动同步和回滚。完整协议与恢复见[发行说明](../distribution.md)。

| 调用 | 作用 |
| --- | --- |
| `system read` | 模式、版本、来源、系统改动和备份 |
| `system check [--source <地址或索引文件>]` | 检查适用的新 Release |
| `system update [--source <地址或索引文件> \| --from <Core包>] [--dry-run]` | 校验、合并、升级；from 指定更新包 |
| `system sync [--quiet]` | 仅显式调用时按间隔检查和升级，记录尝试结果 |
| `system rollback [--dry-run]` | 恢复上次事务保存的系统 |
| `system cleanup [--apply \| --dry-run]` | 默认只预览受管材料退役；apply 才清理 |

各操作支持 json、单独 help。quiet 仅限 sync，与 json 互斥。source 与 from 互斥，不持久改变来源；文件按 KSF 根定位。接受 HTTPS、本地文件和 loopback HTTP；拒绝公开明文 HTTP、带凭据地址和降级重定向。

read/check 不写业务目标。schema 4/5 实例的 read 会联网读取固定 Core 提交的文件树以比较差异，不查询新版；升级双方修改同一文本时按需读取并校验原文。联网是维护前提，读取失败保留当前系统。未发布的 development 小型凭据只返回身份，changes:null、baselineVerified:false、baselineStatus:development-package，不尝试把个人或未发布提交冒充远程原版；开发包仍不能贡献或正式升级。update 预览也下载、合并、验证候选，但不切换系统或建立正式备份。update 通常要求新版本；源码模板 schema 5 可将同版本且验证为原 Core 提交后继的正式发行安装为 schema 4，同版本 Release 落后于已验证模板来源时 check 返回 sourceAhead:true、available:false，保留当前源码；显式安装旧包仍拒绝。旧正式凭据仍拒绝同版本换源。旧版本使用 rollback。开发仓库 read 返回 development，其余安装操作要求有效 release.json。

## 在用户实例里手动升级

用 Agent 打开自己的 KSF 实例目录，在当前会话里说：

> 请检查 KSF Core 是否有新版本，先预览更新；没有冲突就执行升级，完成后核对版本，并检查我的项目文件是否保留完整。

也可以在实例根目录依次执行：

```sh
./.agents/ksf system read --json
./.agents/ksf system check --json
./.agents/ksf system update --dry-run --json
./.agents/ksf system update --json
./.agents/ksf system read --json
```

`check` 的 `current` 是实例当前版本，`latest` 是公开发行版本，`available: true` 表示有适用的新版本；`available: false` 时无需执行升级。显式 `check` 和 `update` 不受 sync 的检查间隔限制，可以立即检查刚发布的版本。

预览成功且 `conflicts` 为空时再执行实际升级；出现冲突时先检查返回的路径和内容，解决后重试。完成后以 `system read` 的 `version` 确认安装版本，并核对需要保留的个人文件。`.ksf-template.json` 记录初始模板出处，升级后仍可能保留初始版本。

系统更新从发行源下载 Core 包，个人实例无需合并 Core 或模板仓库的分支。需要撤销本次升级时，可先运行 `system rollback --dry-run --json` 预览，再运行 `system rollback --json`；升级后新增的 Core 编辑可能阻止回滚，具体以命令结果为准。

## 输出与错误

JSON：`{ok, command:"system", operation, data, errors}`，成功 0、操作失败 1、参数错误 2。update 提供 current/latest、changed、changes、conflicts 和 backup。UPDATE_CONFLICT 时 data 保留冲突内容。sync 的 quiet 提示写 stderr，不混入业务 stdout；失败不宣称现有系统必然可用。

错误包括 BASELINE_UNVERIFIED、BASELINE_MISMATCH、DOWNLOAD_FAILED、RELEASE_NOT_FOUND、CHECKSUM_MISMATCH、RELEASE_INVALID、RELEASE_REPLACED、VERSION_NOT_NEWER、UPDATE_CONFLICT、CANDIDATE_INVALID、SYSTEM_CHANGED、UPDATE_BUSY、BACKUP_MISSING、ROLLBACK_LOCAL_CHANGES。

升级只管理系统文件和本机事务，不写个人目录、Git 配置或忽略规则。固定启动器先按协议 1 恢复中断，再交给 Core 准备运行时；不撤销活跃事务。启动和普通命令不检查更新或安装。sync 仅显式调用时使用间隔缓存，失败也记录；read 的 automaticUpdates 固定为 false。KSF_SKIP_AUTO_UPDATE 是无作用兼容项。显式操作按实际结果退出。

入口独立恢复可调用 `ksf launcher recover`，不需要 Core 或 Node。协议、并发改动保护与 Windows 范围见[启动入口](../../runtime/launcher.md)。

实现 system.js、network.js 和模板固定启动器；system-update.test.js 覆盖合并、回滚、故障注入和真实 SIGKILL，release-network.test.js 使用真实本机 HTTP。

## 清理运行材料

`ksf system cleanup --json` 返回候选、保留项、警告及可释放容量，不修改目标；`--apply` 与 `--dry-run` 互斥。应用清理前再次核对回执、文件和源码保护依据，错误保留现场。唯一文件或独立 Git 历史尚未保全时，`warnings` 中返回 `source-not-preserved`，该材料不会进入候选。

本命令只管理已识别的切换／正式备份及统一测试材料，保留最近可用回退。范围、源码归属与任务结束处理见[运行数据与源码保留](../runtime/runtime-data.md)。业务状态及未知历史目录需另外核对，不根据日期批量删除。

check 另返回 installedPlatform、platform 与 platformSwitch。旧模板或跨设备复制保留了其他平台的发行凭据时，新索引按本机平台选包；同版本且完整 Core SHA 相同，允许显式 update 完成平台标记校正，保留原始来源与个人数据。旧客户端由兼容索引先升级程序，再重新检查并完成本机平台校正。
