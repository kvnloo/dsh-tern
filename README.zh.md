# @kvnloo/dsh-tern

[English](README.md) | 中文

**独立 DeepSeek Harness/Cordis 插件包**：提供交互式终端会话、Tern Surface Protocol（TSP）原生语义界面与普通 ANSI 回退。它**不是**受信任的 Tern 运行时插件，不会另建 Agent 或 Session 运行时。代码从既有 DSH 下游 TUI 原型抽取，保留 Git 历史和 [DeepSeek 原版 MIT 许可](LICENSE)。

## 安装指定提交

要求已安装 DeepSeek Harness `0.2.1-alpha.1`、Node `^22.19.0 || >=24.0.0`，源码构建使用 pnpm 11.7.0，以及正常可用的 `dsh` 命令。本包**尚未发布至 npm**。请固定审核过的完整 Git 提交或由其构建的工件，不要把浮动分支当成生产版本。

```sh
git clone https://github.com/kvnloo/dsh-tern.git
cd dsh-tern
git checkout <reviewed-commit-sha>
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm pack --pack-destination /absolute/private/packages
dsh plugin --profile tui add /absolute/private/packages/<generated-tarball>.tgz
dsh tui
dsh tui --no-native
dsh tui --session-id session-existing
```

必须通过真正的 **`dsh plugin`** 命令安装和启用。宿主使用原有包管理器初始化 `tui` profile，将 `@kvnloo/dsh-tern` 放在 `@deepseek-ai/dsh-base` 之后；`cordis.patch.yml` 在宿主原有 patch 系统注册 `@kvnloo/dsh-tern/startup` 和主入口。请使用 **`dsh tui`** 启动，不要直接运行插件包或修改 DSH 核心。

使用 Git URL 安装时，pnpm 的**构建审批**策略可能阻止 `prepare`。仅审核并批准输出中确切的插件提交，在 profile 的 `pnpm-workspace.yaml` 内使用 `allowBuilds`，然后重试 `dsh plugin --profile tui add <pinned-git-spec>`；禁止全局放宽策略。**已构建 tarball** 包含 JS、声明文件、patch YAML 和内嵌的已修补 SDK，使用方不需要构建审批或额外 patch map。

独立仓库的 `pnpm-lock.yaml` 需要由负责人使用 pnpm 11.7.0 **正规生成并提交**；没有该锁文件前，不得宣称 frozen install 已通过。不得编造锁文件或发布记录。

## 使用

持久化 Session、真实 Agent、工具、审批、问题及恢复行为均由 DSH 宿主负责。ANSI 与 TSP 根据同一个语义状态渲染；临时流式更新不代替 Session 日志。TSP hello/DA1 协商成功后启用原生 inline surface 和稳定身份的编辑器/工具卡片；协商失败、超时或 `--no-native` 均使用 ANSI。底层 SDK 管理 PTY、分块、额度、ACK 与终端恢复。

`/help` 列出命令。`/model` / `/models` 使用挂载的 provider 目录；`/session`、`/sessions`、`/new`、`/resume ID` 管理合法的根 Session。`/plan`、`/tasks`、`/jobs`、`/job ID`、`/job-stop ID`、`/agents`、`/agent ID`、`/agent-steer ID TEXT`、`/agent-stop ID`、`/steer TEXT`、`/stop` 均通过既有公开服务实现。审批或问题激活时由其持有输入，不会隐式提交草稿。

## 构建与验证（由 OMP 运行；此处尚未执行）

```sh
export DSH_HOST_ROOT=/absolute/checkout/of/kvnloo/deepseek-harness
test "$(git -C "$DSH_HOST_ROOT" rev-parse HEAD)" = 5badb15009ae1756c3afe0ae0cef1faafc290ccc
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm exec tsc --noEmit -p tsconfig.json
pnpm run test:unit
pnpm run test:public:source
pnpm run test:public:lib
pnpm run test:packed
bash -n tests/host/harness/private_tern.sh
python3 -m py_compile tests/host/harness/*.py
```

公开 PTY 测试使用**真正的宿主 CLI/Loader/Agent/Session**；源码与 lib 模式都通过 `dsh plugin --profile tui add` 安装单独打包的插件，只有 LLM/工具适配器为确定性测试数据。两种模式各执行未删减的 **15 个公开用例**，不重试、原始超时不变。宿主源码模式需要其正规路径别名；lib 模式需要真实宿主构建。原生证据捕获还需要宿主完整且未过期的 `.dsh-build/client-build-environment.json`；仅有 host-only 构建不足以替代。不能使用 provider 密钥、用户 daemon/桌面、虚假的 Agent 或未经采集的远程日志作为证据。

`tests/host/harness/private_tern.sh` 读取绝对路径 `DSH_HOST_ROOT`、真实宿主 CLI 和 `DSH_TUI_PACKAGE_TARBALL`（已构建 tarball 的绝对路径），在私有 profile 安装后通过普通 `dsh tui` 于隔离的 Sway/Tern 中运行。证据严格**分别**记录宿主的 Git SHA/构建工件和插件的 Git SHA/tarball SHA256，私有封存真实全量 wire、元数据与物理 Session JSONL，验证不可变哈希并脱敏。重放、未采集的远程证据不能被冒充为本地现场记录。详情见 [私有 harness 文档](tests/host/harness/README.zh.md)。

消费者验证会检查已构建与打包字节的一致性、全新 npm 安装，并把内嵌修补后的 SDK 与**未经修补的公共 registry 0.1.0** 做反向对照。离线时仅可通过 `REGISTRY_TERN_TARBALL` 提供真实原版 tarball。

## SDK、贡献来源与许可

- `@stencil-hq/tern@0.1.0` **精确固定**；`patches/@stencil-hq__tern@0.1.0.patch` 合格 SHA256 为 `c222b3495ade7f7b334ae4f5f94be05b2b4edb2764645dd1972f90ad436e0998`。生产构建内嵌**已修补** SDK，不能在独立安装时回退至原版；变更补丁需要新的真实验证。
- Tern/TSP 原创作者：**Can Bölük / Stencil Labs**；DSH/Cordis 的 Agent、Session、插件接口贡献者：**DeepSeek Harness/Cordis contributors**。对比实现来自 **Hermes Agent contributors** 与 [Hermes x Tern](https://github.com/kvnloo/hermes-tern) 的 `frontend/src`，以及 [Hermes preview/tern-frontend](https://github.com/kvnloo/hermes-agent/tree/preview/tern-frontend/ui-tsp)。本项目复用官方 SDK，没有重新实现协议。
- [LICENSE](LICENSE) 保留 DeepSeek 原版 MIT 条款，SDK 的归属与通知详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- [权威 RFC #6](https://github.com/kvnloo/deepseek-harness/issues/6) 与 [独立跟踪 issue #1](https://github.com/kvnloo/dsh-tern/issues/1) 定义验收要求。

**本抽取工作尚未完成认证**。仍需由 OMP 正规生成锁文件及语言记录，在 MBP 验证准确合并头，完成签名窗口中的指针/审批/分离、用户控制的 daemonless API 发送，以及 Hermes/OMP 差分证据。Tern 0.9.5 的 daemon 模式 `cx.session:event` 即使界面可用也可能返回 `no program runs in that pane`；原生 UI 成功不代表 daemon API 通过。
