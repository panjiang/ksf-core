# 构建、发行与系统生命周期

系统生命周期连接 Core 源码、生成清单、发行包和用户实例。程序维护者需要分清“当前源码”“已安装的正式基线”和“本机事务”，再判断一次构建、升级或贡献会读取和写入什么。精确发行协议由[发行说明](../distribution.md)持有，命令参数见 [release](../cli/release.md)、[system](../cli/system.md)和 [contribute](../cli/contribute.md)。返回[架构总览](README.md)。

## 输入、生成物和身份

| 文件或产物 | 谁生成及消费 | 维护方式 |
| --- | --- | --- |
| `core/build.json` | 维护者编写，build 读取 | 声明系统版本、Node 固定版本、随包压缩包路径及可信摘要 |
| `core/manifest.yaml` | build 生成，bootstrap 与程序读取 | 记录校验后的运行时声明、构建来源和系统摘要；不手工编辑 |
| `core/distribution.json` | 系统默认配置，发行与显式维护操作读取 | 声明产品仓库、发行源及默认间隔超时；个人覆盖留在 user-data |
| Core 更新包中的 `core/release.json` | release build 生成，安装前校验 | schema 3 文件校验清单，保存文件路径、权限与摘要，不内嵌原版正文 |
| 已安装实例及用户模板中的 `core/release.json` | release build / 安装生成，维护与贡献读取 | schema 4 精简凭据，保存精确 Core 来源、版本、平台和入口协议；不保存文件清单或原版正文 |
| `ksf-core-release.json` | release build 生成，检查与安装读取 | 声明各平台产物 URL、大小和摘要及 Core 身份 |
| `.ksf-template.json` | 用户模板生成时写入 | 记录模板初始出处；当前安装版本仍以 release.json 为准 |

build 校验固定输入与真实压缩包，推导可执行文件摘要，并对系统资产生成摘要。文档和测试也属于系统源资产，因此修改本目录后需要通过既有 build 刷新 manifest。生成前再次核对输入与源码未变化，使用同目录临时文件发布；build 不自动递增版本、提交或发布。

系统与实例身份由 [products.js](../../runtime/src/distribution/products.js)统一定义：ksf-core 同时是系统源、模板与唯一更新产品；ksf 或自定义名称是个人实例。官方主线 core-main，个人 main；初始化验证模板完整树并固定精确 Core SHA。模板包含系统、初始说明与空用户目录，不复制维护者的真实个人数据。

## 从源码到发行包

release build 从明确系统路径收集文件，在独立临时目录重新生成 manifest，生成 schema 3 文件清单，构建并回读验证 Core 包。生成用户模板与完整模板包时，将同路径的清单转换为 schema 4 精简凭据，再生成发行索引。包校验清单与已安装凭据用途不同，入口恢复协议仍为 1。默认输出位于 runtime-data/releases，也可显式指定。

正式包要求干净的 Core 源提交。`--allow-dirty` 只产生本地开发包，开发标记会阻止其作为正式更新和公开发行使用。生成包、向远程发布及同步官方模板是不同操作；构建成功不表示已发布。

以下命令会生成本地 manifest，应在实际完成系统资产修改后执行：

```sh
.agents/ksf build --json
```

正式发布需要明确版本、来源和发布授权，流程见发行说明和相应 CLI；本篇不把示例默认变成远程动作。

## 从检查到升级

system read 读取安装身份、本地差异及备份。正式 schema 4 实例按凭据固定的准确 Core 提交联网取得原版文件，才能比较本地差异；它不查询新版或安装更新。无安装凭据的开发源只返回本地开发身份，development 凭据返回 changes:null、baselineVerified:false，不伪称已核实正式基线。system check 获取并校验索引；system update 获取候选、校验并安装；显式 system sync 根据本机检查记录和有效配置间隔决定是否执行更新。普通启动不调用 sync。

更新采用旧正式基线、本地系统和新正式版本三方比较。原版按准确提交取回，不以 main 最新内容替代，也不常驻复制一套原版正文。未改文件更新，本地单独修改保留，双方文本修改使用 diff3；冲突返回路径与可审查信息，保留当前系统。生成的运行时 manifest 采用发行候选。用户目录、user-data、用户 README 和忽略文件不作为 Core 更新目标；repositories 工程及其 Git 历史保留原位。

候选在独立临时目录验证随包运行时、变化 JavaScript 的语法和系统对象的精确引用。定义校验使用候选自身身份规范，支持合法旧版本回滚。安装前重核当前系统指纹，避免验证期间的并发修改被覆盖；预览完成验证后返回计划，不切换当前系统。

检查和升级预览都会按来源访问索引或候选包。指定包入口、固定原版的联网读取、来源解析、下载限制和错误契约见 system 文档；预览不等于不联网。

## 事务切换、恢复与回滚

安装先在 runtime-data/system/prepare-<ID> 写入事务基础元数据，再原子公布 transaction 目录，随后准备与交换 Core。事务记录 owner 的 PID 与启动身份；变化根文件在替换前写 root-intent，并保存完整前后快照。

固定入口与程序失败处理共同遵守以下边界：未 committed 的事务恢复旧 Core 和本事务替换的根文件；已 committed 的事务完成备份归档。根文件若既不等于旧快照也不等于新快照，视为并发编辑，保留文件和事务并报告冲突。未知协议或活跃 owner 不猜测恢复。

恢复可在 Core 或 Node 尚不可用时由固定入口执行。当前事务、完成备份和失败归档的保留条件见 [runtime-data](runtime-data.md)；具体记录布局由[入口协议](../../runtime/launcher.md)持有。

回滚读取最近备份，先确认当前系统指纹等于上一事务完成时的指纹，再验证旧候选并通过事务安装。升级后新改动导致指纹变化时拒绝静默回滚。回滚不恢复用户工作内容或 user-data；它们不属于系统事务范围。

## 从用户实例贡献系统修改

贡献准备读取用户实例最新 HEAD 中的系统文件，以及同一提交保存的正式 release.json。暂存、未暂存和未跟踪内容不参与，也不要求工作目录整体干净；prepare 不自动 add 或 commit。开发包基线不能用于新贡献。

prepare 按[提交信息规则](../git-commit-message.md)检查公开标题与正文，冻结相对正式基线的选定差异、公开 diff、完整提交消息、摘要、本地 sourceCommit 和基线身份。读取与预览使用这份计划；首次发布前 HEAD 改变需要重新准备，继续编辑未提交文件则不改变已冻结内容。

submit 在远程写入前核对原版 Core 的选定文件和权限，从正式 Core 提交创建新的系统提交及草稿 PR。个人文件、Git 历史、原提交说明、作者配置和本地 sourceCommit 不进入公开提交。远程状态缓存只供续查，重试仍需核对真实分支、提交和 PR；具体授权与交付规则见 [Git 协作](../git.md)。

## 修改与验证入口

修改构建输入或生成摘要时，核对 [build-manifest.js](../../runtime/src/services/build-manifest.js)与[构建说明](../../runtime/build.md)。修改发行管理范围、身份或归档格式时，联合核对 [common.js](../../runtime/src/distribution/common.js)、[release.js](../../runtime/src/distribution/release.js)和 [archive.js](../../runtime/src/distribution/archive.js)。修改事务同时核对 [system.js](../../runtime/src/distribution/system.js)与两个原生恢复入口。贡献来源与远程提交分别见 [committed-source.js](../../runtime/src/distribution/committed-source.js)和 [contribute.js](../../runtime/src/distribution/contribute.js)。

已有验证包括 [build.test.js](../../runtime/tests/build.test.js)、[distribution.test.js](../../runtime/tests/distribution.test.js)、[release-publish.test.js](../../runtime/tests/release-publish.test.js)、[release-network.test.js](../../runtime/tests/release-network.test.js)、[system-update.test.js](../../runtime/tests/system-update.test.js)、[contribute.test.js](../../runtime/tests/contribute.test.js)及 [lifecycle.test.js](../../runtime/tests/lifecycle.test.js)。测试中的模拟 API 与本机 HTTP 不表示已经向真实远程发布。生命周期通过共享服务与平台适配器接入 macOS 和 Windows x64。Windows 原生恢复、安装与升级测试单独记录；配置和实现不能代替实际发布或长期运行验收。
