# instance 命令

`instance init [--revision <完整 Core SHA>] [--dry-run] [--json]` 将从 Core 模板创建的独立仓库或已验证的 Core 包初始化为个人实例。

原始模板通过初始提交的完整树匹配官方 Core 来源；较旧模板可指定完整 SHA，仍须匹配该树。当前系统改动会阻止首次初始化。普通文件夹从包内清单固定来源，不要求 Git。源码模板 receipt schema 5 区分于正式发行 receipt schema 4。

命令补齐缺少的通用个人文件，保留已有 USER、BOT、知识与设置；只有未定制的 Core 根 README、忽略规则及属性会被实例种子替换。Git 实例从当前 HEAD 新建并切换到 `main`，保留原本地分支和远端 `core-main`；已经选中 main 时沿用该分支，另一条 main 未满足下述恢复条件或 detached HEAD 会报冲突。初始化仅写本仓库的 `push.default=current`、`branch.main.remote=origin`、`branch.main.merge=refs/heads/main` 和 `branch.main.pushRemote=origin`，避免继承 core-main 的跟踪关系。它不提交、推送、更改远端 URL 或远端默认分支；首次正常推送才建立远端 main。显式 origin push 映射或 mirror 配置会报冲突并保留原设置。初始化官方 Core 源仓库会被拒绝。

重新克隆后若仍处于初始 core-main，命令先检查已有本地 main，再检查 origin/main。有效安装凭据、与当前 HEAD 的祖先关系及无已跟踪工作区/暂存修改均核实后，离线切换至已有实例；保留未推送的本地 main 提交，不重新孵化、填充用户文件或变更远端默认分支。缺失/损坏凭据、不同历史或本地文件冲突时保留现场并报错，不重新从快照创建 main。切换显式保护被 Git 忽略的本地文件。旧入口不支持恢复时，可在新目录用 `git clone --branch main <个人仓库地址>`。

本地没有 main 时，仅完整的标准 origin 分支映射可以继续首次初始化。single-branch、depth 默认单分支及自定义 fetch 映射可能隐藏已有个人 main，均先报 INSTANCE_BRANCH_CONFLICT；应取得全部 origin 分支，或明确克隆已有 main，不把未获取的分支当成不存在。

结果包含 initialized、changed、core、version、branch、previousBranch、createdBranch、pushTarget、files、preserved；本轮执行初始化或分支恢复时另有 resumed，true 表示接续已有实例。已选中的初始化实例返回 changed:false，不重新填充或覆盖个人空间。首次 dry-run 联网校验来源，恢复预览只读本地 Git 对象，均不写文件或改分支；中断事务须通过实际 init 恢复。初始化失败会恢复本轮文件、Git 设置和当前分支；只有引用与本轮创建记录均未改变时才删除本轮新建的 main。进程中断后若用户已提交或修改 Git 设置，保留提交与事务并报告恢复冲突。schema 3 分开记录切换前后提交，兼容恢复旧 schema 1/2 事务。

官方 Core 的常见 HTTPS、SCP 和 SSH 地址均作为系统源拒绝初始化。origin 的实际推送地址包含官方 Core 时，即使拉取地址是个人仓库也返回 INSTANCE_PUSH_CONFIG_CONFLICT；不修改原有 URL、pushurl 或重写规则。

回执已写入但初始化事务尚未收尾时，固定入口仍返回 instance-setup，须先完成恢复，不能因凭据存在而跳过。

旧 schema 1 重命名记录没有保存 HEAD。涉及 Git 时，只有当前提交仍与原始 origin 分支引用一致，且当前分支仍属于该事务，才自动恢复；新增个人提交或无法核实原节点时，先报 INSTANCE_RECOVERY_CONFLICT 并保留文件、分支及事务。无 Git 的旧文件事务仍按逐文件摘要恢复。

成功后再执行固定入口 `context entry --json`，完整读取孵化或 runtime 要求。启动入口本身只读本地状态，不联网验证或升级。

JSON 使用 `{ok,command:"instance",operation:"init",data,errors}`；成功 0、操作失败 1、参数错误 2。常见错误为 INSTANCE_SOURCE_UNVERIFIED、INSTANCE_SOURCE_MODIFIED、INSTANCE_BRANCH_CONFLICT、INSTANCE_PUSH_CONFIG_CONFLICT、INSTANCE_RECOVERY_CONFLICT；保留实际错误，不手写来源回执。完整机制见[发行说明](../distribution.md)。
