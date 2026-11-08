# RFC #6 私有 Tern 验收 harness

[English](README.md) | 中文

**仅供测试。** 调用未修改的 DeepSeek Harness CLI、Loader、Agent、Session、审批、工具及投影 API；确定性 LLM/工具 fixture 位于 `../fixtures/`。不使用 provider 账户、生产 Tern 插件、虚假 Agent loop、用户桌面或 daemon、继承凭据。

## 指定提交的前置条件

独立仓库需检出审核后的 `@kvnloo/dsh-tern` 提交。另外使用 `DSH_HOST_ROOT` 指定**独立的** DSH 宿主检出，必须等于未修改的 `kvnloo/deepseek-harness` 主分支提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，含已安装依赖、真实 `apps/cli/lib/bin.js` 及未过期的完整 `.dsh-build/client-build-environment.json`。仅执行 host-only lib 构建不足以提供该记录。环境需要 Node >=22.19/24、pnpm 11.7、Python3、Linux PTY；原生测试另需隔离的 Sway/Tern 0.9.5。

**负责人正规生成并提交锁文件后**，在独立仓库运行：

```sh
export DSH_HOST_ROOT=/absolute/path/to/deepseek-harness
test "$(git -C "$DSH_HOST_ROOT" rev-parse HEAD)" = 5badb15009ae1756c3afe0ae0cef1faafc290ccc
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run test:unit
pnpm run test:public:source
pnpm run test:public:lib
pnpm run test:packed
bash -n tests/host/harness/private_tern.sh
python3 -m py_compile tests/host/harness/*.py
```

源码/lib 两种模式均通过宿主真实的 `dsh plugin --profile tui add <absolute-tarball>` 安装包，并由 `dsh tui`（或 `--profile tui`）及现有 `../fixtures/cordis.yml` 启动。各自必须通过 **15 个公开用例**，重试次数为零、超时不变；查验真实持久化 Session JSONL，而非合成事件。

## 私有原生捕获及重放

在自己控制的 Linux 合成器及签名窗口中：

```sh
mkdir -m 700 -p /absolute/private/plugin-packages
pnpm pack --pack-destination /absolute/private/plugin-packages
export DSH_TUI_PACKAGE_TARBALL=/absolute/private/plugin-packages/<generated-tarball>.tgz
DSH_TUI_EVIDENCE_DIR=/absolute/new/evidence-root \
  bash tests/host/harness/private_tern.sh startup
bash tests/host/harness/private_tern.sh live
bash tests/host/harness/private_tern.sh replay /absolute/private/original-sdk.jsonl
python3 tests/host/harness/evidence_bundle.py \
  --evidence-dir /absolute/new/evidence-root --out /absolute/private/new-seal.tar.gz
```

`startup` 验证真实 hello/DA1、inline surface、frame 和 ACK，不能发送模型提示；`live` 验证持久化 alpha/beta/failure 轮次和分屏、缩放、隐藏/重新显示；`replay` 必须标记为**仅重放**。显式可信**远程**启动器使用 `DSH_TUI_LAUNCHER` 及源码、摘要、来源声明；未复制的远端日志始终标记为 `remote-uncollected`。

`DSH_HOST_ROOT` 与 `DSH_TUI_PACKAGE_TARBALL` 是**两个独立输入**：宿主源码及 build SHA256 不能冒充插件的 Git SHA 与 tarball SHA256。封存器同时校验两类身份及所采集 tarball 的真实 SHA256，仅接受 owner-only 白名单文件：完整 SDK wire、元数据、物理 Session JSONL、私有命令记录与独立的插件工件。程序复制输入快照、校验不可变哈希、脱敏后封存，拒绝符号/硬链接和覆盖；不要公开原始敏感记录。

`compare_wire.py` 对比两个独立真实启动捕获及 manifest。DSH 方必须含插件源码/工件身份；Hermes/OMP 方保留自己的来源证据。比较会规范化临时 surface 时序，但验证协商、稳定 ID、实际操作和线路数据。

**尚未认证：** 实际签名窗口中的指针命中、编辑器原子发送、审批优先权、分离与恢复以及对比证据仍需 MBP 执行。Tern 0.9.5 在 daemon 模式的 `cx.session:event` 可能返回 `no program runs in that pane`，即使原生 UI 能提交。原子发送应分别通过签名窗口原生 UI 和**自己控制的 daemonless `tern serve`** API 验证，不得声称 daemon API 绿灯；失败不得靠重试、修改断言掩盖。
