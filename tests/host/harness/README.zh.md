# RFC #6 Tern 一致性测试与私有证据

[English](README.md) | 中文

仅用于测试。不替换运行时，不使用虚假 Agent、渲染器回调替身、生产用 Tern 插件、提供商密钥或模型调用。已交付的 dsh CLI/Loader/Agent/Session 与 `../fixtures/tui-llm.ts` 中的 fixture 适配器协同运行。`@stencil-hq/tern@0.1.0` 是真实的解析器、KeyDecoder、Session、Surface 和渲染器。仅用于测试的远端终端只发送原始字节、TSP hello 及 ACK/事件。

Hermes 对齐参考：`kvnloo/hermes-tern/frontend/src/turn/router.ts`、`frontend/src/view/dockModel.ts`、`frontend/src/draft/keys.ts`、`frontend/src/__tests__/composer.test.ts`，以及 `kvnloo/hermes-agent:preview/tern-frontend/ui-tsp`。DSH 生产代码未复制任何 SDK 内部实现。

## 全新检出环境中的命令，由 OMP 执行（此处尚未运行）

前置条件：Linux 和真实 POSIX PTY、Python 3.10+、与根目录 `package.json` 一致的 Node ^22.19.0 或 >=24.0.0、Corepack 和 pnpm 11.7.0，以及已安装的工作区构建依赖。在仓库根目录的 Draft PR #7 准确分支上执行：

~~~sh
git fetch origin tern/native-profile
git switch tern/native-profile
git rev-parse HEAD
corepack pnpm install --frozen-lockfile
# Default local private_tern.sh mode (NO DSH_TUI_LAUNCHER) requires the
# COMPLETE root build, under MBP's fleet build lock. Release the lock BEFORE
# native Tern. build:lib:host alone does NOT create the required build record.
corepack pnpm run build
python3 -m py_compile apps/cli/tests/profiles/tui/harness/*.py
bash -n apps/cli/tests/profiles/tui/harness/private_tern.sh
corepack pnpm exec vitest run packages/bundle/tui-app/tests/harness-evidence.spec.ts
corepack pnpm exec vitest run packages/bundle/tui-app/tests/transport-conformance.spec.ts packages/bundle/tui-app/tests/native-pty.spec.ts
corepack pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/profiles/tui/tests/keyless.e2e.ts
DSH_EXAMPLE_MODE=lib corepack pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/profiles/tui/tests/keyless.e2e.ts
~~~

默认的**本地原生**运行器与单元/e2e 命令有独立的前置条件：它要求完整根构建生成的 `.dsh-build/client-build-environment.json`，而非仅有 `apps/cli/lib/bin.js`。此前 MBP 上仅执行的 **host-only** `build:lib:host` 不会生成此记录。缺少它属于预期的完整构建前置条件失败，**不**代表运行时缺陷；不得伪造或绕过该记录。运行器还会拒绝陈旧的源代码/版本、构建时工作区脏状态元数据、已记录客户端产物被修改，以及比构建记录更新的 CLI。

另一种方式是由所有者明确提供**可信、已构建的可执行启动器**，并同时设置 `DSH_TUI_LAUNCHER`（绝对路径的可执行文件）、`DSH_TUI_LAUNCHER_LOCATION`（`local` 或 `remote`）、`DSH_TUI_LAUNCHER_SOURCE_SHA`（已证明的准确源码）、`DSH_TUI_LAUNCHER_ARTIFACT_SHA256`（已证明的启动器/构建摘要）和 `DSH_TUI_LAUNCHER_PROVENANCE`（构建/传输来源）。这种显式覆盖**不是**默认本地 CLI 模式，也不允许信任未经构建的包装脚本。本地覆盖会重新测量可执行文件 hash，并要求与当前检出 SHA 一致；远端记录在单独取得实际远端文件前仍标记为 `remote-uncollected`。两种路径都不得把缺失的远端 wire/Session 文件标作本地捕获。

源码模式通过 tsx 启动真实的 `apps/cli/src/bin.ts`。lib 模式启动真实的 `apps/cli/lib/bin.js`。两者都运行公开的 `--profile tui` 或 `tui` 简写，仅应用既有无密钥 fixture 补丁，不使用宽泛的不安全权限覆盖。Linux PTY 驱动器拥有控制终端，子进程拥有真实的 Agent/Session。运行环境排除凭据、代理、继承的 GUI/daemon/multiplexer 状态，并为 `DSH_HOME` 与会话设置私有空间。只有上述命令完成并记录退出码后，才能宣称测试成功。

传输测试通过 Tern 输入发送真实 APC 和 OSC 877，包括分片/畸形/外来协议帧、随机 UTF-8 字节分割、分片边界、协商后的 hello 与 DA1、渲染 credits/ACK、可见性、尺寸调整、主题、动画、错误与终端清理。原生测试输入包含多个字符的原始 PTY 数据块、分开的 emoji 字节，进行编辑与删除、在括号分隔符之间粘贴多行、以真实 Enter 提交，并测试原生 SDK send 事件。CLI e2e 断言实际持久化 JSONL 用户消息恰好写入一次、两个轮次、模型流失败以及新进程恢复；并分别检查 stdout 和持久化的 Assistant 文本。

行为见证刻意保持**严格**。若失败，不得修改预期文本或合成回调：
- SDK `typescript/src/input.ts` 的 InputParser 似乎会消耗括号粘贴起始分隔符，因此 KeyDecoder 可能把原始换行视作 Enter。精确的多行一次性提交测试会暴露该问题。
- SDK `typescript/src/session.ts` 似乎不验证 hello 中的版本 `v:99`。负向协商测试要求回退。
- 应检查 DSH `packages/bundle/tui-app/src/model.ts` 中嵌套工具结果块的 `callId`。一致性测试工具必须揭示实时与持久化状态的差异，不得修补对侧源码。

## 私有真实 Tern，不访问用户显示器或 daemon

额外外部工具：提供 `serve`/`ctl`/`surface-play` 的 Tern CLI、Sway/wlroots 无头后端、pixman、截图支持、bash、Python、git 及已构建的 DSH。可使用 SSH/Linux 运行器；必须清除 `TMUX`、`TMUX_PANE`、`STY` 和 `ZELLIJ`。`WLR_BACKENDS=headless` 与 `WLR_RENDERER=pixman` 由运行器设置，不从宿主继承。生成的 Sway 配置明确禁用 Xwayland。全部套接字、Tern serve daemon、HOME 和 XDG 目录均为新建且私有。运行器绝不连接宿主 compositor、现有 Tern 标签页或登录/账户/凭据门禁。

~~~sh
bash apps/cli/tests/profiles/tui/harness/private_tern.sh live

# Replace with the PRIVATE evidence path printed above:
python3 apps/cli/tests/profiles/tui/harness/evidence_bundle.py \
  --evidence-dir /tmp/PRIVATE_DSH_EVIDENCE \
  --out /tmp/dsh-native-evidence.tar.gz
~~~

本地 live 运行器使用已核验为全新、仅所有者可访问的空工作区（`DSH_TUI_TEST_WORKSPACE`），并通过绝对路径的无密钥 fixture 补丁启动**实际构建完成**的 CLI。它使用普通 Tern 按键/Enter 交互提交 alpha/beta/failure fixture，不构成原生 `e/send` 证明，并通过本地 `/quit` 退出，要求测得退出码 0。运行器捕获 Tern state/tree/CSS、SDK JSONL 和实际 Session JSONL；拆分、聚焦、调整大小和重新显示仍是互相独立的可视检查。默认本地路径同时要求完整根构建记录和已构建 CLI 的 hash。运行器不会在 groot 上构建或安装，也不能证明 daemon 冷重启、dispatcher 语义、宿主指针输入或模型质量。

完整 SDK JSONL 包含私有提示词/输出，仅保留在所有者专用归档中，同时保存持久化 Session 记录、截图、原始日志和文件 hash。证据生成器拒绝符号链接或其他用户可读的输入，生成不含内容的 `redacted-wire.jsonl`（仅方向、verb、字节数和 SHA-256），加入来源 manifest，且绝不上传。

## 回放不是真实运行中的程序

~~~sh
bash apps/cli/tests/profiles/tui/harness/private_tern.sh replay "/absolute/private/path with spaces/dsh-sdk-wire.jsonl"
python3 apps/cli/tests/profiles/tui/harness/evidence_bundle.py \
  --evidence-dir /tmp/PRIVATE_REPLAY_EVIDENCE \
  --out /tmp/dsh-replay-only.tar.gz
~~~

Tern `ctl surface-play` 对解码后的文件名要求使用**场景层双引号字符串**（字面 UTF-8，且仅支持 `\\"`、`\\\\`、`\\n`、`\\t` 转义；不解码 JSON `\\uXXXX`）；它**不会**去掉 POSIX `shlex.quote` 生成的单引号路径字面量。测试工具仅在场景层对文件名编码。对于 `ctl run`，场景解析器先移除这一层引号，随后由 pane shell 执行结果；测试工具先用 `shlex.quote` 构造安全的可执行命令字，再对整个 shell 命令加双引号/转义，以供场景解析器处理。这样无需执行任意用户片段，即可处理启动器、日志 pane 和回放路径中的空格、反斜杠及引号。合成引用规则单元测试执行实际隔离的辅助函数并核验其调用点；它**不是**原生 Tern 运行。

回放使用 Tern `surface-play`，而不启动 dsh；`source_kind` 始终为 `surface-replay`。完整录制可能在 `out/x` 之后移除了实时 composer，因此回放就绪要求保留 main 区域的语义身份/状态，而非 dock。如果终端没有保留 main 状态，则拒绝回放；要检查局部区间，使用 Tern 文档所述 `surface-play` range 选项，明确记录任何截止位置，并**绝不**将缩短的回放标记为完整 live 运行。回放无法证明进程启动、Session 模型/服务、输入解析、TTY 清理或 Hermes 对齐。

## 可执行的 Hermes / OMP 差异比对

只比较真实 DSH 和真实 Hermes/OMP 进程的**启动时未输入提示词**捕获，每个进程使用独立的全新空工作区和私有 daemon。双方 manifest 必须证明准确 Git SHA、捕获 ID、模型 ID、**完全相同的 Tern CLI 版本与二进制 SHA256**，以及各自独立录制的 SDK JSONL 的 SHA256。此命令不读取提示词列表，也不宣称用户/模型回复一致。无法取得基于 fixture 的对侧进程时，状态为 **BLOCKED**；不得用渲染器生成的 JSON 或金标回放替代。完整原生行为另需独立的功能性 Session 和 `e/send` 证据，不能依赖该启动 oracle。

~~~sh
python3 apps/cli/tests/profiles/tui/harness/compare_wire.py \
  --dsh /private/dsh/log/dsh-sdk-wire.jsonl \
  --peer /private/hermes/sdk-wire.jsonl \
  --dsh-manifest /private/dsh/manifest.json \
  --peer-manifest /private/hermes/manifest.json \
  --out /private/differential.json
~~~

该工具要求观察到 `q.v:[1]` 和程序端 `q.features:[edit,undo,send]`，终端提供 `r.v:1`、编辑器/输入 kinds 及终端拥有的（**而非** edit/send）`r.features`。接受 body 为 base64、包含 `params.id/mime` 的 SDK `b`，以及 SDK 对 `add`、四字段 `text`、`set`、`splice`、`move`、`del`、`settle`、`focus`（字符串 ID，或以 **null** 取消聚焦）、`reveal`、`scroll`、`suspend` 和 `resume` 的准确 tuple 形状。拒绝畸形或未识别的 tag，包括不受支持的 `props`；历史保留的 b675 *实际*录制中，frame2 的 focus 是 `["focus","dock.composer.line.input"]`。包含该 focus 的单元 fixture 是**构造数据**，不是重放/执行过的比对。限定范围的 oracle 将观察到的初始 credits 限制在 1–2，并验证累计 ACK。完整启动必须包含真实的 `out/x` CLOSE；关闭之后允许已在途的有效累计 ACK 排空，但关闭后帧、超额 credit、error 事件、错误/缺失 node 或伪造的 manifest 终端版本均会**失败**。CLI `Tern 0.9.5` 和 SDK `r.ver:"0.9.5"` 统一为相同版本；hash 和完整版本来源仍必须精确。oracle 只报告实际语义 ID 和 credit 摘要，**不证明原生 send、模型/响应质量、角色或功能对等**。

## 范围、待完成门禁与平台限制

此分支切片**仅**拥有 `apps/cli/tests/profiles/tui/**`，以及新增的 `packages/bundle/tui-app/tests/native-pty.spec.ts` 和 `transport-conformance.spec.ts`。生产源代码、包 manifest 和现有包测试归 SERVICES 所有。后续由测试侧拥有的切片依次为：工具调用/结果/错误与实时/持久化对齐；与写到一半的草稿争夺输入的审批和问题；取消/EOF/崩溃状态恢复；真正的 daemon 冷重启/恢复；私有真实 Hermes/OMP fixture 差异比对。任何源代码缺陷均由独立 SERVICES 工作线程修复，不得藏在测试代码中。

通过 JS SDK 覆盖 APC/OSC 877 不能证明原生 Windows ConPTY/Win32 行为。MBP 原生冒烟测试与所有 Windows/ConPTY 门禁由负责人承担；仅有解析器测试不能给予认证。

## TRN13 修正的证据约定（connector 编写，未运行）

本地运行在启动前检查空的 mode-0700 `workspace/` **和**空的 `sessions/`。生成的启动脚本切换到该工作区，**不**切换到仓库根目录，并使用绝对路径的已构建 CLI 和补丁。本地默认启动拒绝缺失/陈旧的 `.dsh-build/client-build-environment.json`、不匹配的源码提交前缀或包版本、已记录客户端产物变化、构建时脏状态元数据，以及晚于构建记录的 CLI。显式覆盖仍需来源证明；没有复制证据的远端运行属于 `remote-uncollected`，不是本地证明。Tern `surface-play` 路径采用场景字符串引用规则；`run` 路径先由 shell 引号保护，**然后**编码为场景字符串。远端就绪只在既有的 45 秒截止时间内重试；清理使用经核验的子进程启动身份及 Linux pidfd 信号，保证不会误杀复用 PID 的新进程。

归档封存工具把白名单输入复制进该次调用专属的私有快照，在脱敏**之前**固定 hash，随后再次核验，并与已完成 tar 的字节内容核对。即使远端处于 LIVE，它也拒绝 `log/replay-source.jsonl`、符号链接/路径包含绕过、畸形或非所有者专用输入以及所有覆盖写入。工具绝不读取 `runtime/`、`home/`、`cache/`、凭据、套接字或未知文件。合成单元套件覆盖脱敏读取后发生的突变、符号链接祖先路径、回放数据夹带、有效 SDK BLOB/close、frame2 focus 与 null-focus、迟到的累计 ACK，以及严格的畸形操作负例；其中隔离的引用规则单元测试检查真实编码辅助函数，却不调用 Tern。**合成单元测试成功不等于原生证明。**

为独立证明真实原生语义 send，负责人曾通过 `tern ctl carly lua` 和文档所载的 `cx.session:event(PANE,{ev="send",sf=SF,id=EDITOR,text=TEXT})`，确认 **Tern 0.9.5 本地 Window Event API** 可用。PANE、SF 和 EDITOR 必须取自**当前实时**的私有 Tern pane/editor，并用真实持久化 DSH Session 事件核对所提交的准确 TEXT。这是 Tern 窗口事件，**不**是 Carly agent dispatcher 的证明。不得用 IME commit 冒充原子 send。`/quit` 属于本地清理，不是提供商/模型提示词。负责人此前在 **b675f23c39375c8081709eb017d4d865affe7e06** 观察到三条精确回显（包括多行 Unicode）、Shift+ArrowLeft 将 15 移到 16 且以 Z 替换后长度为 16、Meta+z 撤销、相同/不同草稿的正确清除，以及真实的 `/quit` 退出码 0；原始 SDK SHA256 为 **3af780f622be7c1f60ccf44fb882403c462585befad0e03d812b209de030f0eb**。这些历史结果**不能**用于认证合并后的当前 head；f36/ACK33/credits2 关闭时 credit 缺陷是归 TRN12 所有的运行时 RED，不可作为 comparator 例外。

仅按负责人拥有的无头 Sway 自动化说明执行私有原生步骤，且必须先释放 MBP 构建锁。不得连接任何宿主显示器/daemon 或使用真实密钥。所需的新测试和静态检查列于本 README 开头；原生 `startup`、`live`、`replay`、`compare_wire.py` 和 `evidence_bundle.py` 必须在**同一个准确的合并 head** 上分别执行并记录退出码。剩余验收还包括物理 PTY/Session 和原生窗口事件、指针 pick/click、daemon 冷启动后 detach/restart，以及独立的真实 Hermes/OMP 差异比对。

## TRN6 公共服务验收（严格、connector 编写、未运行）

相邻的 `tests/public-services.e2e.ts` 新增了**九个**已交付 CLI 的验收见证。它们重用 `fixtures/cordis.yml`、`fixtures/tui-llm.ts` 中真实的模型适配器，以及无害的 `fixtures/tui-tools.ts`。工具拥有的唯一文件系统副作用，是在新分配的 mode-0700 `DSH_TUI_TEST_WORKSPACE` 内直接以独占方式创建 `approval-allowed.marker`；模型不提供路径，也不执行 shell。生产 `@deepseek-ai/dsh-tool-ask-user` 工具及公开的 `ctx.userQuestions.ask()` 负责问题答案；生产 `ctx.approval.request()` 负责审批策略、取消和成对的持久审计。Agent、Session 和原生渲染器都没有被 mock。

场景包括：ANSI 真实工具开始/结果两次，且持久化的 `toolCallIds` 不同；原生单卡片原位显示工具结果并在新进程中恢复；通过键盘拒绝时保留 Unicode/多行草稿与 caret；对一次新的 allow-once 请求，从实际发出的 `el(tag:button)` 文档找到选项后发送真正的 TSP `ev:action`、`act:click`；协商 kitty Escape 并验证拒绝；ANSI 问题单选；原生问题单选与多选/自定义答案；原生问题 Escape 取消；观察到实际实时文本的进行中提供商流，经 Ctrl-C 后有且仅有一个持久化的 `interrupted:true` 部分结果、一个新的已完成轮次，以及持久化进程恢复。

每个结果均对照真实物理 Session JSONL 检查；原生用例还核验已发出的 SDK frame 操作。没有测试伪造 Session 事件或导入 agent-loop 内部实现。现有 `keyless.e2e.ts` 的五个用例及断言不变。

PTY 驱动器现在读取实际 surface-frame 的 `add` 文档，以发现每次打开时最新的带 hash 的 `layer.request.*` 编辑器和 `el(tag:button)` 操作 ID；绝不发送历史硬编码问题路径。驱动器在解析、确认 ACK 和检查完整 frame 之前，按字节精确重组协商的 `c/m` APC 分片。语义 node/after 检查点检查真实 SDK `add`/text/属性更新、稳定卡片 ID 以及编辑器的 `sendable`/caret 状态。仅用于 fixture、可中止的 `fs.watch` 交接机制在 ApprovalService 接管输入前阻塞真实工具；驱动器只有在通过真实 PTY 按键输入 Unicode 多行草稿后才解除阻塞。`wait_after` 等待观察到的新字节出现，`node_after` 等待之后按序发生的语义状态变化，而不是睡眠。失败时，在报告的私有工作区保留仅所有者可访问的 PTY 字节、解码文本、JSON frame 及持久化 Session；成功则在子进程退出后删除整个私有工作区。

**对当前分支进行的源代码约定检查，不是执行后得到的 GREEN：** `packages/bundle/tui-app/src/index.ts` 中的实际审批监听器在 `request.signal` 未中止时，把 Escape 的 null 响应映射为 rejected；只有真实中止的 signal 才映射为 cancelled。`packages/core/agent-loop/src/agent.ts:448-465` 中真实 Agent 会提交带 `interrupted:true` 的非空中断块，而提供商失败仍不会提交。测试保留这两项约定。仅含工具调用的 assistant 消息文本为空，因此文本回复 oracle 会过滤它们，但仍完整检查真实工具调用/结果 ID。最初的 MBP 源码运行在生产提交 `08768d429d` 上记录了 **6/14 通过、8/14 失败**（五个先前存在的 keyless 用例和 ANSI 问题场景通过）；本工作线程**没有**重跑这些门禁，也不宣称修复后的通过结果。

负责人 OMP 必须获取 fleet-build 锁，在 groot 之外的私有 Linux PTY 环境执行，并记录准确退出码，而非猜测通过数量：

~~~sh
git rev-parse HEAD
corepack pnpm install --frozen-lockfile
corepack pnpm run build:lib:host
python3 -m py_compile apps/cli/tests/profiles/tui/harness/*.py
corepack pnpm exec vitest run --config vitest.e2e.config.ts \
  apps/cli/tests/profiles/tui/tests/keyless.e2e.ts \
  apps/cli/tests/profiles/tui/tests/public-services.e2e.ts
DSH_EXAMPLE_MODE=lib corepack pnpm exec vitest run --config vitest.e2e.config.ts \
  apps/cli/tests/profiles/tui/tests/keyless.e2e.ts \
  apps/cli/tests/profiles/tui/tests/public-services.e2e.ts
~~~

没有 Linux PTY 执行环境的 macOS/Windows 宿主会**跳过**这些 `describe.skipIf` 测试套件：跳过不等于验收。GitHub-only 工作线程未执行以上任何命令。仅通过这些公开 fixture 也无法完成 RFC #6 的真实 Tern、SSH/tmux、ConPTY、daemon 保留、Windows、压力测试及 Hermes/OMP 差异比对门禁。必须保留既有严格检查，将其他 RED 记录为真实的 API/文件/观察值与期望值的差异，不得据此授权编辑 `apps/cli/tests/profiles/tui/**` 以外的内容。

## TRN8 公共门禁 fixture 修复（仅 connector；测试未运行）

拥有的改动路径：`tests/public-services.e2e.ts`、`fixtures/tui-llm.ts`、`fixtures/tui-tools.ts` 和 `harness/pty_driver.py`，以及本 README。`fixtures/cordis.yml` 中的注册仍保持原有的生产 ask-user/tool/LLM fixture 配置不变。

验收仍包括此前存在的全部五个 keyless 场景与九个公共服务场景，分别在源码模式和已构建 CLI 中执行。fixture 现在等待真实双轮工具结果与 assistant 完成后的**实际**新 idle，而不是等待流式 token。三个审批场景先提交触发词，在真实工具阻塞期间通过真实 PTY 按键编辑草稿，释放仅 fixture 持有的状态，然后断言 composer 阻塞/恢复、准确的 UTF-16 caret、关联审计、独占 marker 副作用及无重复用户消息。Escape 发送 CSI 27u。问题场景等待已解码的语义 node 文本及真实 idle；仅用户消息计数使用 `source.kind=user`。Ctrl-C 预期一个持久化的 `interrupted:true` 部分结果、一个已完成的后续轮次、一个稳定的实时/持久化 assistant 卡片身份，并在恢复后回放。

此 GitHub connector 工作线程没有运行测试命令。负责人必须在具备 Linux PTY 的机器上，持有已有的私有 fleet 锁、且不提供任何提供商密钥，捕获准确 SHA、stdout/stderr 和每条命令的退出码：

~~~sh
git fetch origin tern/native-profile
git switch tern/native-profile
git rev-parse HEAD
corepack pnpm install --frozen-lockfile --prefer-offline
corepack pnpm run build:lib:host
python3 -m py_compile apps/cli/tests/profiles/tui/harness/pty_driver.py
corepack pnpm exec vitest run --config vitest.e2e.config.ts \
  apps/cli/tests/profiles/tui/tests/keyless.e2e.ts \
  apps/cli/tests/profiles/tui/tests/public-services.e2e.ts
DSH_EXAMPLE_MODE=lib corepack pnpm exec vitest run --config vitest.e2e.config.ts \
  apps/cli/tests/profiles/tui/tests/keyless.e2e.ts \
  apps/cli/tests/profiles/tui/tests/public-services.e2e.ts
corepack pnpm exec vitest run packages/bundle/tui-app/tests/native-pty.spec.ts \
  packages/bundle/tui-app/tests/transport-conformance.spec.ts
~~~

其余产品 RED 必须向独立的生产代码负责人报告实际 Agent/Session 日志、已解码的完整 TSP frame 和准确的 src 文件及行号。此 fixture 切片无权改动生产 TUI、Agent、SDK、lockfile、keyless 或 Cordis 注册。

## TRN10 原生语义：要求真实 Tern 指针见证（未运行）

此前仅 SDK 的 `ev:action` fixture 证明了 action 分发，而非指针命中测试：在已构建的 Tern 0.9.5 窗口中，可见的问题按钮位于 `[18,98,1244,16]`，但 `tern ctl pick 640 106` 命中的是下方的 transcript。验收要求**实际**控制服务器能够 pick 当前 overlay 按钮，并通过**真实指针点击**产生入站 TSP `e/action`。

使用**全新**的 0700 证据工作区、隔离的私有 Sway/headless Tern 服务器和实际交付的 CLI。复用 `private_tern.sh`（第 23–151 行）的环境、清理 trap 和启动序列，作为一次私有指针场景的准备，并且**在脚本自动执行 alpha/error/quit 序列之前停止**。不得连接用户 Tern、桌面、pane、提供商账户、SSH 密钥或 multiplexer。固定并记录 `tern --version`、Tern 可执行文件 SHA256、DSH 提交 SHA、SDK frame 及真实持久化 Session JSONL。与通用 live 样例不同，审批场景还需要 fixture 的私有 `DSH_TUI_TEST_WORKSPACE` 目录：在 `BASE` 下创建并设置 mode 0700，且须在启动 `tern serve` 和 `dsh` **之前**把其绝对路径加入私有 `SAFE_ENV`。无密钥 fixture 的审批屏障有意等待 `approval-release.barrier`；只有测试所有者才能在输入预期的未发送草稿后创建该文件。

通过脚本中的 `ctl <label> <tern ctl arguments...>` 辅助函数及其 `CONTROL` 端点运行两个全新 live 场景，**不得**使用 `surface-play`：

1. 问题：先执行 `ctl question type '[question-choice]'`、`ctl question-send key Enter`。真实问题出现后，捕获 `ctl question-tree tree "[data-role='dsh.question.choice']"` 和 `ctl question-dump dump "[data-role='dsh.question.choice']"`。从**这次** tree/dump 提取最新 Beta 按钮的 `[data-id]` 和几何信息；不得重用历史 `layer.request.*` ID 或硬编码坐标。核验带 modal backdrop 的原生 `[data-role='dsh.question']` **overlay** 包含该按钮，且 dock composer 为 `sendable=false`。在实际按钮矩形内选一个点，执行 `ctl question-hit pick X Y`，要求最上层结果为**同一个按钮**，而不是 `sf-main`、`sf-dock`、overlay backdrop 或 transcript。再执行 `ctl question-click click X Y`。要求私有完整 SDK 记录中包含与最新选项 ID 完全相同、`act=click` 的入站 `e/action`，并在持久化 Session 中有实际公开 `ask_user_question` 结果 `answers:[{id:'choice',selected:['Beta']}]`，且问题 overlay 已移除。
2. 允许审批：在另一个独立的私有工作区发送 `[approval-allow]`，等待真实 `approval-waiting.barrier`，通过真实 PTY 按键输入**未发送**的 Unicode/多行草稿，且 caret 位于行中，并按 `public-services.e2e.ts` 的做法原子创建 `approval-release.barrier`。真实 ApprovalService 对话框打开后，对其 **Allow once** 按钮重复上述最新 tree/dump/几何信息/`pick`/`click` 过程。要求 SDK 入站指针 `e/action`、一条持久化 `approval/asked` 与配对的 `approval/decided:allowed-once`，以及只独占创建一次、内容为 `allowed-once` 的 `approval-allowed.marker`。普通 composer 必须保持 `sendable=false`，直到 modal 关闭，然后恢复**完全一致**的 Unicode 草稿与 caret，最后只真实发送一次。另用全新场景点击 **Deny**，要求持久化 rejected 决定且**没有 marker**；审批 action 不得创建新的 Agent 用户轮次。

对于每次点击，分别在操作前后捕获 `state`、`tree`、`dump`、`pick`、`shot`、私有 `DSH_TSP_RECORD_FULL`、元数据 recorder 输出和持久化 Session 事件。直接注入 `ev:action` 只是额外的 dispatcher 回归检查，**不能**替代 `pick` 加真实 `tern ctl click` 测试。如果最新 pick 返回 `sf-main` 或 `sf-dock`、没有入站 action、实际审批/问题仍待处理、错误身份回答、Deny 引发任何宿主副作用，或草稿/caret 有变化，都必须失败。

同时在 Tern 中执行已完成的真实 `[tool]`，并协商 `tool`：同一个调用 ID 必须始终对应单个 `.sf-tool`，带有命名 head，从 `running` 转为 `done`，且用户切换的折叠状态在重绘/重新附着后仍保留。仅有调用而没有文本的 assistant 消息不得产生空卡片。使用真实公共服务 PTY 和持久化 JSONL oracle 检查结果内容与回放，绝不推断模型/工具输出。

**OMP 按以下顺序在这个准确的 PR head 上执行**（此处不宣称通过）：

~~~sh
git rev-parse HEAD
corepack pnpm install --frozen-lockfile --prefer-offline
# Heavy MBP build gate: acquire fleet flock, finish build, RELEASE lock.
corepack pnpm run build:lib:host
# Every native/PTY/real-Tern smoke below runs AFTER the lock is released.
corepack pnpm exec vitest run \
  packages/bundle/tui-app/tests/native-semantics.spec.ts \
  packages/bundle/tui-app/tests/native.spec.ts \
  packages/bundle/tui-app/tests/native-fallback.spec.ts \
  packages/bundle/tui-app/tests/native-regressions.spec.ts \
  packages/bundle/tui-app/tests/native-pty.spec.ts \
  packages/bundle/tui-app/tests/model.spec.ts \
  packages/bundle/tui-app/tests/ansi.spec.ts
corepack pnpm exec vitest run packages/bundle/tui-app/tests/retention.spec.ts \
  packages/bundle/tui-app/tests/transport-conformance.spec.ts
python3 -m py_compile apps/cli/tests/profiles/tui/harness/*.py
corepack pnpm exec vitest run --config vitest.e2e.config.ts \
  apps/cli/tests/profiles/tui/tests/keyless.e2e.ts \
  apps/cli/tests/profiles/tui/tests/public-services.e2e.ts
DSH_EXAMPLE_MODE=lib corepack pnpm exec vitest run --config vitest.e2e.config.ts \
  apps/cli/tests/profiles/tui/tests/keyless.e2e.ts \
  apps/cli/tests/profiles/tui/tests/public-services.e2e.ts
~~~

只有**重量级 MBP host 构建/typecheck/hygiene 门禁**需要取得 fleet build flock：`corepack pnpm run build:lib:host`、`corepack pnpm run typecheck`、`corepack pnpm run hygiene`、`corepack pnpm run doc-sync`，以及负责人指定的 packed-SDK 检查。**原生 PTY 冒烟测试和真实 Tern 指针运行必须在 MBP 构建 flock 之外执行**，使用各自的私有运行环境；不得使用真实提供商密钥。

## TRN15 源码/lib PTY fixture 修正（connector 编写，未运行）

在 **f99f09517b7bb30251e949230ca65590ae85d186** 上进行的 20261023-112718-c2dc MBP 运行通过了冻结依赖安装、完整根构建、客户端约定类型检查、Python/Bash 语法检查，以及 **18 个文件中的 117 个重点测试**。其使用 `--retry=0` 的源码 PTY 矩阵在 15 个用例中为 **11 PASS / 4 FAIL**；这些只是在该准确旧 SHA 上的历史结果，**不能视为新 head 已通过**。

此次仅测试侧的修正保留全部六个 keyless 和九个公共服务场景（共 15 个）、它们的超时、无密钥模型适配器，以及正常的 Session/ApprovalService/UserQuestion 负责人。较晚出现的 ANSI 协议 fixture 仅统计 **`source.kind=user`** 意图，而不把其他合法、持久化的 `user/message` 上下文计入。连续两个 ANSI fixture 工具调用现在断言准确发出的名称及从 `running` 到 `done` 的生命周期文本，同时仍证明两个独立的持久化调用 ID、已完成结果与 assistant/tool 关联。

PTY 驱动器现在从**当前**发出的 `dsh.question` 语义文档中发现可操作的问题控件，无论它处于 `layer`（协商的 modal）还是 `dock`（无 overlay 回退）。驱动器也支持拥有请求范围语义身份、只有叶子节点的协商 dock 选项。每次完整 SDK frame 后均根据实时节点（包括 `add`、`set` 和 `del` 更新）重新生成选择；被替换、重新打开的问题不再保留旧控件。无关的 composer/editor/navigation 节点不符合条件。驱动器仍发送真实的 `ev:action,act:click` 与 `ev:send,text` SDK 事件形状；**不**伪造指针点击。`packages/bundle/tui-app/tests/harness-evidence.spec.ts` 中的合成单元回归测试涵盖 modal、dock、只有叶子节点及 row 选项、editor ID、替换/删除/重新打开、排除无关 dock 控件，以及准确生成的事件对象。这些测试**不**宣称真实提供商、Agent、Session 或原生指针证明。

OMP 必须在**新的准确 head** 上运行以下命令（此 GitHub connector 工作线程未运行测试），使用私有 Linux PTY 且不提供提供商密钥。重量级构建/typecheck/hygiene 门禁须先取得再释放 fleet 构建锁；执行原生 PTY 或真实 Tern 测试时不得持锁：

~~~sh
git fetch origin tern/native-profile
git switch tern/native-profile
git rev-parse HEAD
corepack pnpm install --frozen-lockfile --prefer-offline
corepack pnpm run build
corepack pnpm run typecheck
python3 -m py_compile apps/cli/tests/profiles/tui/harness/*.py
bash -n apps/cli/tests/profiles/tui/harness/private_tern.sh
corepack pnpm exec vitest run packages/bundle/tui-app/tests
corepack pnpm exec vitest run --config vitest.e2e.config.ts --retry=0 \
  apps/cli/tests/profiles/tui/tests/keyless.e2e.ts \
  apps/cli/tests/profiles/tui/tests/public-services.e2e.ts
DSH_EXAMPLE_MODE=lib corepack pnpm exec vitest run --config vitest.e2e.config.ts --retry=0 \
  apps/cli/tests/profiles/tui/tests/keyless.e2e.ts \
  apps/cli/tests/profiles/tui/tests/public-services.e2e.ts
corepack pnpm run hygiene
corepack pnpm run doc-sync
~~~

记录准确 SHA、15 个源码模式及 15 个 lib 模式用例的结果数量，以及所有命令的退出码。负责人还必须单独执行上文所述的私有真实 Tern 指针 `pick`/`click` 冒烟测试：SDK 注入 action 路由**不**能证明命中测试。新的运行时失败必须向对应负责人提供私有完整 frame 和物理 Session 证据，绝不能放宽 fixture 或伪造 Session 事件。
