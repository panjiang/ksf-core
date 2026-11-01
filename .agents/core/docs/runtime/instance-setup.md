---
id: cooperation.ksf.instance-setup
name: KSF 实例初始化
version: 0.1.0
status: active
---

当前目录尚未初始化为个人实例。先保留用户原始请求与材料，再完成本地初始化：

- macOS：`.agents/ksf instance init --json`
- Windows：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .agents/ksf.ps1 instance init --json`

命令会联网核对模板初始文件树对应的精确 Core 提交，创建缺少的用户文件，记录系统来源，并将当前个人分支改为 `main`。不更换 Git 远端，不覆盖已有个人资料，不提交或推送。

核对退出码、`ok` 与 `errors`。成功后再次执行固定启动器的 `context entry --json`，完整遵循返回的孵化或正常工作要求。失败时保留现场并报告实际错误；不能猜测 Core SHA、手写安装回执或跳过初始化。较旧模板查找不到来源时，可在核实原始 Core 提交后使用 `instance init --revision <完整 SHA> --json`。
