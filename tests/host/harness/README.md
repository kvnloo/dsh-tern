# RFC #6 private Tern acceptance harness

English | [中文](README.zh.md)

**Test infrastructure only.** This harness exercises the real unmodified DeepSeek Harness CLI, Loader, Agent, Session, approval, tool and projection APIs. Deterministic model/tool fixtures are in `../fixtures/`. No provider accounts, production Tern plugins, substitute Agent loops, user desktop/daemon or inherited credentials.

## Exact-head prerequisites

The standalone checkout must contain the reviewed `@kvnloo/dsh-tern` head. A **separate** checkout specified by `DSH_HOST_ROOT` must be exact, unmodified `kvnloo/deepseek-harness` master `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, with normal dependency installation, a built `apps/cli/lib/bin.js` and a complete non-stale host `.dsh-build/client-build-environment.json`. A host-only lib build is not a substitute for its complete host build record. Pin Node >=22.19/24, pnpm 11.7, Python3, a real Linux PTY, and for native dogfood a private Sway/Tern 0.9.5 installation.

From standalone checkout, **after OMP canonically generates and commits the lockfile**:

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

Each public source/lib test run installs one **real packed plugin** via the host's `dsh plugin --profile tui add <absolute-tarball>` and invokes `dsh tui` (or `--profile tui`) using the existing deterministic fixture `../fixtures/cordis.yml`. Both modes must pass all **15 cases**, retry zero, unchanged deadlines. They inspect persisted physical Session JSONL rather than synthetic replay claims.

## Private native and replay

Under an owned, isolated Linux compositor and with a real signed window:

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

`startup` requires real hello/DA1, opened inline semantic surface, frame and ACK, no prompt. `live` checks real alpha/beta/failure user/assistant Session facts, split, resize, hide and show. `replay` is categorically **replay only**, never a simulated local live capture. An explicit **remote** trusted launcher uses `DSH_TUI_LAUNCHER` plus its attested source/artifact/provenance fields and retains `remote-uncollected` for missing physical logs.

`DSH_HOST_ROOT` and `DSH_TUI_PACKAGE_TARBALL` are separate mandatory local inputs; the recorded host source and build digest are **not** the plugin Git SHA and packed artifact digest. Evidence sealing checks both identities and SHA256 of the captured tarball and admits only owner-only allowlisted files: full SDK wire, metadata, real physical Session JSONL, private command transcripts and the independently measured plugin artifact. It snapshots inputs, preserves immutable content hashes, redacts outside the private archive, and refuses symlink/hardlink or overwrite attacks. Do not upload unredacted recordings.

`compare_wire.py` compares two actual separately captured startup files plus their manifests. The DSH side requires plugin source/artifact identity; the Hermes/OMP peer remains a separately attested source. Comparisons normalize ephemeral surface timings but check independent semantic negotiation, stable IDs, controls and true bytes.

**Not yet certified:** native signed-window pointer hit-testing, atomic editor send, approval ownership, detach/reattach, and peer differential require real owned MBP runs. Tern 0.9.5 daemon-backed `cx.session:event` can say `no program runs in that pane` while native UI submission works. Qualify atomic send with native UI in the signed window and the API in an **owned daemonless `tern serve`**, not a fictitious daemon API green. Keep exact wire/Session failures as failures; no assertion relaxation or retry.
