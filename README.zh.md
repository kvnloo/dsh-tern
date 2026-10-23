---
description: "基于 Tern Surface Protocol 的 DeepSeek Harness 交互式终端 profile，支持 ANSI 回退。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

[English](README.md) | 中文

## 概述

该 TUI 是叠加在 [dsh-base](../base/README.zh.md) 之上的 DeepSeek Harness 具名应用 bundle。它通过公共服务创建或恢复根 agent（智能体），将持久化的 Session 事件投影成一份 transcript（文本记录），并通过原生 Tern Surface Protocol（TSP）或普通 ANSI 呈现同一状态。它不另建 agent 运行时，也不影响其他应用 profile。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 启动与输入模式

在已安装依赖并生成源码路径别名的工作区检出目录中，通过受支持的 dsh CLI（命令行界面）启动 profile，而不是直接执行包文件：

~~~sh
pnpm dsh tui
pnpm dsh tui --session-id session-existing
pnpm dsh tui --no-native
~~~

原生模式使用已锁定并打包的 `@stencil-hq/tern@0.1.0` SDK（软件开发工具包）进行 hello/DA1 协商、PTY 按键解码、带内封帧、分块、信用额度控制、输入焦点管理以及终端恢复。无法协商原生能力的终端会回退至 Node readline；即使在 Tern 内，`--no-native` 也会强制使用按行输入的 ANSI 模式。无需另装 Tern 插件，也无需手动安装 SDK。

ANSI 会在审批提示出现前后保留未发送文本及 readline 光标位置。管道输入将不完整的 UTF-8 行与审批缓冲区分别保存。基于 SDK 的输入隔离层会缓存探测期间收到的普通按键，并在 readline 接管前过滤延迟到达的 APC/OSC 回复；关闭时只释放自身派生的输入流与监听器，不会销毁进程输入流。被动探测结束也不会暂停成功连接的 SDK 输入。

### 命令、Session 与人工决策

普通输入会提交后续请求，包括 agent 运行中排队的下一轮。`/steer TEXT` 请求步骤边界 steering（中途引导）；`/stop` 取消当前任务，`/quit` 退出，`/help` 显示命令。Ctrl+C 取消正在运行的轮次，空闲时连续按两次退出；Ctrl+D 退出原生界面，ANSI 在 EOF 时关闭。

`/models` 或 `/model` 打开当前 provider 目录选择器；`/model PROVIDER/MODEL` 通过 `llm.listProviders` 和 `llm.listModels` 校验路由，再由 `agentDefaultModel` 保存选择，并更新 agent 范围内后续步骤使用的模型。`/sessions` 列出同一工作目录中可恢复的根 Session；`/resume ID` 与 `/new` 仅在当前 agent 空闲后切换归属。缺少持久化、已有 agent 占用、工作目录不匹配，以及 preset/subagent Session 都会被拒绝恢复。

`/plan`、`/tasks`、`/jobs`、`/job ID` 与 `/job-stop ID` 读取或控制公共计划、待办和后台任务服务；读取后台任务详情不会消耗模型使用的输出游标。`/agents`、`/agent ID`、`/agent-steer ID TEXT` 与 `/agent-stop ID` 使用公共后代 registry 以及可继续运行的子 agent 控制能力。两种渲染模式都显示来源服务的生命周期状态及稳定 id，不会虚构进度百分比；`/session` 返回当前 Session id。

审批只提供“允许一次”或“拒绝”；无人应答或取消时默认拒绝。问题支持既定选项、自由文本和多选。两种渲染模式均由问题独占输入，并保留普通编辑器中尚未发送的草稿，不会将草稿误作答案或模型输入。

### 无密钥 profile 与私有 Tern 复现

测试专用的 `apps/cli/tests/profiles/tui/fixtures/tui-llm.ts` 通过真实 profile 注入确定性 LLM（大语言模型）适配器；它不替代 Agent、Session、工具或审批服务，也不需要 provider 密钥。完成依赖安装及源码/构建准备后，可在隔离的 Tern Session 中使用私有存储运行 fixture（测试前置数据）：

~~~sh
mkdir -p /tmp/dsh-tui-private
chmod 700 /tmp/dsh-tui-private
DSH_TUI_TEST_STORE=/tmp/dsh-tui-private/sessions \
DSH_TSP_RECORD=/tmp/dsh-tui-private/metadata.jsonl \
pnpm dsh --profile tui --patch apps/cli/tests/profiles/tui/fixtures/cordis.yml
~~~

在 Tern 内外分别输入 `first`、粘贴多行文本，然后依次操作 `[tool]`、`[failure]`、`/stop`、`/session` 与 `/quit`。对比持久化 Session id、稳定的工具调用/结果卡片、审批输入路由与终端清理。`DSH_TSP_RECORD` 只保存线路方向、操作类型、真实 UTF-8 内容/线路字节数、分块、帧与 ACK、协商能力、修订号和事件序号，不保存提示词、模型输出、工具内容或普通按键文本。`DSH_TSP_RECORD_FULL` 则会捕获敏感的完整 SDK 负载：必须先执行 `umask 077`，使用自己控制的私有路径，且绝不可发布或提交录制文件。

-----

<a id="understand-the-implementation"></a>
## 了解实现

### Session 权威数据与呈现

- `src/index.ts` 负责根 Agent 创建/接管、监听器、审批与问题 waterfall（瀑布式事件）以及关闭；`src/services.ts` 通过公共能力读取模型、Session、后台任务、计划、待办和 subagent，而不访问 Agent 内部实现。
- `src/model.ts` 依据已提交的 Session 事件生成稳定的用户、助手和工具行。助手实时增量只替换临时预览；中断可能保留标记为 interrupted 的持久化助手部分回复，完整历史不会被显示窗口截断。
- `src/ansi.ts` 通过 readline 呈现共享状态。`src/draft.ts` 管理尚未发送的原生编辑文本、撤销及 UTF-16 光标/编辑偏移量；过期编辑事件不能覆盖新草稿。PTY 输入和粘贴属于普通 SDK 按键事件，而非 TSP edit 事件。
- `src/native.ts` 将状态同步为经协商的语义节点，保留稳定的工具调用 id、原生编辑器、受限历史重放和模态问题输入。不可用的语义节点类型会使用协商支持的本地展示组件；原生 send 经相同的 Agent 回调原子提交所携带的文本。
- `src/input-fence.ts`、`src/terminal.ts`、`src/questions.ts` 与 `src/lifecycle.ts` 分离输入决策和逆序清理。`src/record.ts` 只在选择启用时观察传输元数据，不保存消息正文或 Agent 持久化数据。

### 保留策略、信用额度与打包 SDK

Tern 管理原生滚动历史、焦点、尺寸变化和已渲染节点；DSH 管理每一条持久化 Session 事件。已 settled 子节点的 `gone` 通知只会通过下游 `Surface.forget(ids)` 扩展删除 SDK 展示缓存引用；既不会删除 Session 日志，也不会重启无关 surface。整个 surface 的 `gone` 可以触发新的受限恢复代际；隐藏的 surface 会等到重新可见再恢复。主题与尺寸变化则重新协调已有快照。

持久化历史重放按受限前缀推进：每一步预计序列化条目数据不超过 512 KiB，单条目超过 20 MiB 时拒绝发送，并且仅在真实 SDK `onAck` 回调后继续，以保留完整的 Session 身份信息并遵守协议 24 MiB 的重组消息限制。原生关闭受信用额度约束：隐藏或分离的终端可能无法 ACK 待发送帧，因此 SDK 至多发送关闭操作并丢弃未发送的展示工作，不会无限阻塞关闭。帧已经发送并不等于终端已确认。

根 pnpm 对 `@stencil-hq/tern@0.1.0` 的补丁为开发环境提供严格 hello、子节点遗忘、ACK 重放和受保护关闭约定。根目录 `patchedDependencies` 配置不会随 npm 使用方一起安装，因此包内 `tsdown.config.ts` 会将打过补丁的 SDK 打入发布的主机侧 `lib/index.js`。必须通过 `pnpm pack` 对照未经修补的公共 registry 压缩包进行反向验证；无需发布包或使用真实模型密钥。发布文件应包含完整主机入口、patch YAML 和生成的声明文件树；运行时分块代码必须已内联或由构建产物纳入。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-base](../base/README.zh.md) — 共享应用组合、公共服务与持久化。
- [TUI RFC #6](https://github.com/kvnloo/deepseek-harness/issues/6) — 完整协议与验收约定。
- [Hermes x Tern frontend](https://github.com/kvnloo/hermes-tern) — 可比较的原生 surface 实现；Tern 及其协议的原创贡献来自 Can Bölük / Stencil Labs。
- [Hermes TSP groundwork](https://github.com/kvnloo/hermes-agent/pull/431) — 可供参考的先前成果，而不是 DSH 的另一套运行时。
- [双语文档约定](../../../docs/i18n/README.zh.md) — 本 README 的中英对照维护方式。

-----

<a id="model-experience"></a>
## 模型体验

无额外影响。此 profile 不添加面向模型的工具、系统提示词、token 指令或另设 Agent 调用路径；用户输入仍通过标准 follow-up/steering API。

#### KV Cache 影响

除正常 Agent 请求外无额外影响。终端帧、待发送草稿、实时预览和元数据录制都不会进入模型上下文前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **原生能力需要协商** — 不支持的终端使用 ANSI 回退。SDK 单元测试通过并不代表真实 Tern/SSH/tmux/ConPTY 及分离后重连场景已验收。
- **受公共服务边界约束** — 模型选择依赖已挂载的 LLM 和默认模型服务；Session 接管需要持久化和兼容的根 Session；一次性 subagent 不支持继续控制。
- **终端历史不是 Session 历史** — Tern 滚动历史可能丢失已 settled 子节点，而持久化历史仍保留；超过原生消息安全预算的单个条目会明确报错，不会静默丢弃。
- **关闭时不保证最后的 ACK** — 隐藏或分离的原生终端可能无法确认最后一帧；清理会放弃尚未发送的展示内容，但不会丢失 Session 持久化记录。
- **RFC 验收尚未完成** — 无密钥的真实 profile PTY 与真实 Tern 证据仍须覆盖审批/多选、真实原生指针动作、信用额度/APC/分块/解析器模糊测试、尺寸/主题/可见性、gone/settle、Hermes/OMP 差分记录、SSH/多路复用器/ConPTY、取消和故障恢复。合成 harness 输出不能替代上述验证。

<a id="dev-note"></a>
### 开发说明

<details>
<summary>维护者工作上下文 — 点击展开</summary>

公共 Tern SDK 及带补丁的使用方必须在包含真实 `.git` 目录的确切 Git 提交检出上验证。不要屏蔽分离源码归档导致的环境错误。源码 profile 启动前应生成源码路径别名；fixture 通过 CLI manifest 声明的默认模型依赖运行。JSDoc 或 README 更新后，必须使用官方生成器更新配置、Cordis API、插件目录及按章节记录的翻译一致性文件，不能手动维护来源指针。若大型 V8 文档依赖图遇到堆内存中止，应单独排查环境，而不是自动放宽门禁。

以下命令应在获授权的检出目录运行；列出命令不代表已执行或通过：

~~~sh
pnpm install --frozen-lockfile --prefer-offline
pnpm run gen-tsconfig-paths
pnpm run gen-cordis-catalog
pnpm run gen-config-catalog
pnpm run gen-plugin-packages
pnpm run verify-translation-pairing --write packages/bundle/tui-app/README.md
pnpm run constraints
pnpm run verify-cordis-config
pnpm run verify-export-jsdoc
pnpm run build:native-system
pnpm exec vitest run packages/bundle/tui-app/tests/retention.spec.ts packages/bundle/tui-app/tests/transport-conformance.spec.ts packages/bundle/tui-app/tests/native-regressions.spec.ts
pnpm run build:lib:host
node packages/bundle/tui-app/tests/fixtures/verify-packed-sdk.mjs
pnpm run test packages/bundle/tui-app
pnpm run test:e2e apps/cli/tests/profiles/tui/tests/keyless.e2e.ts
pnpm run typecheck
pnpm run build
pnpm run hygiene
pnpm run doc-sync
~~~

对于打包使用方的反向对照，可将 `REGISTRY_TERN_TARBALL` 指向事先下载的**未打补丁** registry 压缩包。打包 fixture 会核对 SDK 方法及字节一致性，且不发布包。差分录制使用私有的 `DSH_TSP_RECORD_FULL` 和 Hermes `TERN_TSP_RECORD` 路径，归一化时间戳与临时 surface 代际；应比较稳定的语义 id、输入归属和 settle 行为，而不是原始转义字节顺序。GUI 测试只能在隔离的私有无头合成器中运行，不能触及宿主桌面或用户服务进程。

</details>

