# release 命令

从唯一 Core 源构建和发布一个系统产品。创建实例见 [instance](instance.md)，完整协议见[发行说明](../distribution.md)。

| 调用 | 作用 |
| --- | --- |
| `release build [--output <目录>] [--platform <平台>] [--allow-dirty] [--dry-run]` | 构建 Core 包、索引和本地检查用实例目录 |
| `release publish <发行目录> [--dry-run]` | 校验冻结产物并发布到 Core 自身的 Release |

两个操作均支持 `--json`、单独 `--help`。输出为 `ksf-core-<版本>-<平台>.tar.gz`、schema 2 的 `ksf-core-index.json` 和本地 `ksf/`。只上传 Core 包与索引，不发布第二个模板产品或仓库。结果 `instance` 为检查目录，`template` 暂保留为该路径的兼容别名。products 仅包含 core、instance。

build 默认构建 build.json 声明的全部平台并合并成一个索引，每平台一个 Core 包；--platform 可构建单平台检查包，正式发布拒绝缺少声明平台的索引。build 要求干净纯系统提交，Core 凭据记录精确仓库、`core-main` 和 SHA；`--allow-dirty` 只生成不可正式发布的开发包。dry-run 不创建输出目录。发布预览只核对本地产物，不认证、不写远程；真实发布需要 GitHub 授权，拒绝同版本标签换源和已公开资产换内容。上传未知结果用同一版本与资产对账，不能直接换包重发。

`release template`、`release mirror` 和 `--release-only` 已退役；新命令返回参数错误。旧实例升级可读取旧索引，不能把旧的双产品包当作新发布输入。

JSON 使用 `{ok,command:"release",operation,data,errors}`，成功 0、操作失败 1、参数错误 2；不输出令牌。官方 Actions 使用冻结 artifact ID、Core SHA 和索引摘要，实际远端结果单独留证。

旧客户端继续读取 `ksf-core-release.json`。该兼容索引由同一新索引派生，只保留旧 schema 1 的身份字段并指向同一批 Core 资产，不带 Workspace 包；发布核对两份索引严格一致。新 Core 的默认来源改为 `ksf-core-index.json`，无需旧用户手工跳过来源检查。旧模板在 Windows 上可能带有 Mac 平台凭据；升级后的新 Core 选择本机平台，并允许同版本、相同完整 SHA 的平台标记校正，不允许借此换源或降级。
