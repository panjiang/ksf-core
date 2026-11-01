---
id: cooperation.ksf.instance-setup
name: KSF 实例初始化
version: 0.1.2
status: active
---

当前检出的目录需要初始化或恢复已有个人分支。先保留用户原始请求与材料，再完成本地初始化：

- macOS：`.agents/ksf instance init --json`
- Windows：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .agents/ksf.ps1 instance init --json`

命令会联网核对模板初始文件树对应的精确 Core 提交，创建缺少的用户文件，记录系统来源，并从当前 HEAD 新建、切换到个人 `main`，保留原本地和远端 `core-main`。命令仅在本仓库设置 main 跟踪和默认推送到 `origin/main`，不继承 core-main 的跟踪关系。远端默认分支可以保持 core-main；首次正常推送才建立远端 main。不更换远端 URL，不覆盖已有个人资料，不提交或推送。

核对退出码、`ok` 与 `errors`。成功后再次执行固定启动器的 `context entry --json`，完整遵循返回的孵化或正常工作要求。失败时保留现场并报告实际错误；不能猜测 Core SHA、手写安装回执或跳过初始化。较旧模板查找不到来源时，可在核实原始 Core 提交后使用 `instance init --revision <完整 SHA> --json`。

如果这是已有个人实例的再次克隆，命令会先核实并恢复已有本地 main 或 origin/main，沿用该分支的安装凭据和个人内容，不重新填充或孵化，不联网升级。main 的历史或凭据冲突、工作区已修改、切换将覆盖普通或被忽略文件时均保留现场，不创建另一条初始 main。原 core-main 继续保留模板初始节点。
