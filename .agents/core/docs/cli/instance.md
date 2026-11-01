# instance 命令

`instance init [--revision <完整 Core SHA>] [--dry-run] [--json]` 将从 Core 模板创建的独立仓库或已验证的 Core 包初始化为个人实例。

原始模板通过初始提交的完整树匹配官方 Core 来源；较旧模板可指定完整 SHA，仍须匹配该树。当前系统改动会阻止首次初始化。普通文件夹从包内清单固定来源，不要求 Git。源码模板 receipt schema 5 区分于正式发行 receipt schema 4。

命令补齐缺少的通用个人文件，保留已有 USER、BOT、知识与设置；只有未定制的 Core 根 README、忽略规则及属性会被实例种子替换。本地分支改为 `main`，已有另一条 main 或 detached HEAD 会报冲突；不提交、推送、更改 origin 或远端默认分支。初始化官方 Core 源仓库会被拒绝。

结果包含 initialized、changed、core、version、branch、previousBranch、files、preserved。已初始化实例返回 changed:false，不重新填充或覆盖个人空间。dry-run 联网校验并预览，不写文件或改分支；中断事务须通过实际 init 恢复。发生并发编辑时保留冲突现场。

回执已写入但初始化事务尚未收尾时，固定入口仍返回 instance-setup，须先完成恢复，不能因凭据存在而跳过。

成功后再执行固定入口 `context entry --json`，完整读取孵化或 runtime 要求。启动入口本身只读本地状态，不联网验证或升级。

JSON 使用 `{ok,command:"instance",operation:"init",data,errors}`；成功 0、操作失败 1、参数错误 2。常见错误为 INSTANCE_SOURCE_UNVERIFIED、INSTANCE_SOURCE_MODIFIED、INSTANCE_BRANCH_CONFLICT、INSTANCE_RECOVERY_CONFLICT；保留实际错误，不手写来源回执。完整机制见[发行说明](../distribution.md)。
