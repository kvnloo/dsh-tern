# RFC #6 Tern conformance and private evidence

Test-only. No runtime replacement, fake Agent, renderer callback stand-in, production Tern plugin, provider keys or model calls. The shipped dsh CLI/Loader/Agent/Session operate with the fixture adapter in ../fixtures/tui-llm.ts. @stencil-hq/tern@0.1.0 is the real parser, KeyDecoder, Session, Surface and renderer. The test-only remote terminal merely sends raw bytes, TSP hello and ACK/events.

Hermes parity references: kvnloo/hermes-tern/frontend/src/turn/router.ts, frontend/src/view/dockModel.ts, frontend/src/draft/keys.ts and frontend/src/__tests__/composer.test.ts; kvnloo/hermes-agent:preview/tern-frontend/ui-tsp. No SDK internals have been copied into DSH production.

## Clean checkout commands, to be run by OMP (unrun here)

Prerequisites: Linux + real POSIX PTY, Python 3.10+, Node ^22.19.0 or >=24.0.0 matching root package.json, Corepack + pnpm 11.7.0; workspace build dependencies installed. Run from repository root on the exact Draft PR #7 branch:

~~~sh
git fetch origin tern/native-profile
git switch tern/native-profile
git rev-parse HEAD
corepack pnpm install --frozen-lockfile
corepack pnpm run build:lib
python3 -m py_compile apps/cli/tests/profiles/tui/harness/*.py
bash -n apps/cli/tests/profiles/tui/harness/private_tern.sh
corepack pnpm exec vitest run packages/bundle/tui-app/tests/transport-conformance.spec.ts packages/bundle/tui-app/tests/native-pty.spec.ts
corepack pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/profiles/tui/tests/keyless.e2e.ts
DSH_EXAMPLE_MODE=lib corepack pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/profiles/tui/tests/keyless.e2e.ts
~~~

Source-mode spawns the real apps/cli/src/bin.ts under tsx. Lib-mode spawns real apps/cli/lib/bin.js. Both run the public --profile tui or tui shorthand with only the existing keyless fixture patch and no broad unsafe permission override. The Linux PTY driver owns the controlling terminal; the subprocess owns its real Agent/Session. Credentials, proxies, inherited GUI/daemon/multiplexer state are excluded and DSH_HOME plus sessions are private. No successful test outcome is claimed until the above commands finish with recorded exit codes.

Transport tests send real APC and OSC 877 via Tern input, fragmented/malformed/foreign protocol frames, randomized UTF-8 byte partitions, chunk boundaries, negotiated hello versus DA1, render credits/ACK, visibility, resize, theme, motion, errors and terminal cleanup. Native tests type multi-character raw PTY chunks, split emoji bytes, edit and delete, paste multiline between bracket delimiters, submit with real Enter, and exercise native SDK send events. The CLI e2e asserts actual persisted JSONL user messages exactly once, two turns, a model stream failure and fresh process resume; checks stdout and durable Assistant text independently.

Behavioral witnesses are intentionally STRICT. If they fail, do not alter the expected text or synthesize callbacks:
- SDK typescript/src/input.ts InputParser appears to consume the bracketed-paste start delimiter, so KeyDecoder may see raw newline as Enter. Exact multiline-once tests expose this.
- SDK typescript/src/session.ts appears not to validate version v:99 on hello. The negative negotiation test requires fallback.
- DSH packages/bundle/tui-app/src/model.ts should be checked for the nested tool-result block callId. The conformance harness must expose live/durable divergence without patching peer source.

## Private real Tern, no user display/daemon access

Extra external tools: Tern CLI with serve/ctl/surface-play, Sway/wlroots headless backend, pixman, screenshot support, bash, Python, git and built DSH. An SSH/Linux runner can be used; TMUX, TMUX_PANE, STY and ZELLIJ must be unset. WLR_BACKENDS=headless and WLR_RENDERER=pixman are set by the runner, not inherited from the host. Xwayland is explicitly disabled in a generated Sway configuration. All sockets and the Tern serve daemon, HOME and XDG directories are new and private. The runner never attaches to a host compositor, existing Tern tabs or a login/account/credential gate.

~~~sh
bash apps/cli/tests/profiles/tui/harness/private_tern.sh live

# Replace with the PRIVATE evidence path printed above:
python3 apps/cli/tests/profiles/tui/harness/evidence_bundle.py \
  --evidence-dir /tmp/PRIVATE_DSH_EVIDENCE \
  --out /tmp/dsh-native-evidence.tar.gz
~~~

The live runner starts actual pnpm dsh --profile tui in a private Tern pane, splits a log pane, types and atomically sends deterministic fixture prompts, injects [failure], resizes, changes focus, switches away and back, and captures stable semantic tree IDs, dump geometry, CSS, state, accessibility tree, screenshots, SDK JSONL, process logs, Tern binary hash, exact Git SHA and command replies. Each tern ctl call reconnects the control client. That does not prove a cold daemon/PTY detach and reattach; OMP must run and capture that separately.

Full SDK JSONL contains private prompts/output and stays only in the owner-only archive, with durable Session records, screenshots, raw logs and file hashes. The evidence generator fails on symlink/world-readable inputs, creates a content-free redacted-wire.jsonl (direction, verb, byte count and SHA-256 only), adds a provenance manifest, and never uploads.

## Replay is NOT a live program

~~~sh
bash apps/cli/tests/profiles/tui/harness/private_tern.sh replay /absolute/private/dsh-sdk-wire.jsonl
python3 apps/cli/tests/profiles/tui/harness/evidence_bundle.py \
  --evidence-dir /tmp/PRIVATE_REPLAY_EVIDENCE \
  --out /tmp/dsh-replay-only.tar.gz
~~~

Replay uses Tern surface-play rather than starting dsh; the manifest marks source_kind surface-replay. It does not prove startup, model/services, raw input parsing, TTY cleanup, or a real Hermes differential.

## Executable Hermes / OMP differential

Use the same exact Tern CLI binary SHA256/version for two **live** captures. The local DSH fixture prompts are in differential_prompts.json: alpha, atomic fixture, [failure]. For the second capture run the *actual* kvnloo/hermes-tern integration with real Hermes launcher (hermes tern) against a deterministic, local-only gateway fixture that answers the same prompts, or an actual OMP Tern frontend against a similarly fixture-backed service. Use a separate private home/socket/daemon, set TERN_TSP_RECORD to private JSONL, keep its full logs and screenshots, and write a manifest with mode live, git_sha and the identical tern_build string. Do not run live provider inference. If no real fixture-backed peer is available, mark this gate BLOCKED rather than passing against a renderer fake or recorded golden.

~~~sh
python3 apps/cli/tests/profiles/tui/harness/compare_wire.py \
  --dsh /private/dsh/log/dsh-sdk-wire.jsonl \
  --peer /private/hermes/sdk-wire.jsonl \
  --dsh-manifest /private/dsh/manifest.json \
  --peer-manifest /private/hermes/manifest.json \
  --fixture apps/cli/tests/profiles/tui/harness/differential_prompts.json \
  --out /private/differential.json
~~~

This fails on replay-only manifests, differing Tern builds, missing live program open or frame events, nonmonotonic frame sequences, absent exact fixture prompts, semantic IDs or role evidence. It reports each app's actual node identities/kinds/roles for comparison with Tern tree and CSS; it does not claim identical code or model behavior.

## Scope, remaining gates and platform constraints

This branch slice owns ONLY apps/cli/tests/profiles/tui/** plus the new packages/bundle/tui-app/tests/native-pty.spec.ts and transport-conformance.spec.ts. Source runtime, package manifests and existing package tests belong to SERVICES. Next owned test slices: tool call/result/error and live/durable reconciliation; approval and question competing with a half-written draft; cancellation/EOF/crash status recovery; true cold-daemon restart/resume; private real Hermes/OMP fixture differential. Any source defect must be fixed by the separate SERVICES chat, never hidden in test code.

APC/OSC 877 coverage through the JS SDK is not evidence of native Windows ConPTY/Win32 behavior. The lead owns MBP native smoke and any Windows/ConPTY gate; parser-only tests cannot certify them.

## TRN6 public-service acceptance (strict, connector-authored, UNRUN)

The adjacent tests/public-services.e2e.ts adds **nine** shipped CLI acceptance
witnesses. They reuse fixtures/cordis.yml, the real model adapter in
fixtures/tui-llm.ts, and the harmless fixtures/tui-tools.ts. The only
tool-owned filesystem effect is exclusive creation of approval-allowed.marker
directly in the newly allocated, mode-0700 DSH_TUI_TEST_WORKSPACE; the model
supplies no path and no shell runs. The production @deepseek-ai/dsh-tool-ask-user
tool and public ctx.userQuestions.ask() own question answers; the production
ctx.approval.request() owns approval policy, cancellation and paired durable
audit. Neither Agent nor Session nor native renderer is mocked.

Cases exercise: ANSI real tool start/result twice with different persisted
toolCallIds; native one-card in-place tool result plus fresh-process resume;
Unicode/multiline draft and caret through keyboard denial; genuine
TSP ev:action, act:click on a choice found from emitted el(tag:button)
documents for a fresh allow-once request; negotiated kitty Escape rejection;
ANSI question choice; native question choice and multi-select/custom
answer; native question Escape cancellation; genuinely in-flight provider
stream with observed live text, Ctrl-C, one durable interrupted:true partial,
new completed turn and durable process resume.
Every outcome is checked against the real physical Session JSONL and, for
native, emitted SDK frame operations. No test manufactures a Session event
or imports agent-loop internals. Existing five keyless.e2e.ts tests and
assertions are unchanged.

The PTY driver now reads actual surface-frame add documents to discover
current per-open hashed layer.request.* editor and el(tag:button) action
IDs; it never sends historical hard-coded question paths. It reassembles
negotiated c/m APC chunks byte-exactly before parsing, acknowledging and
inspecting complete frames. Semantic node/after checkpoints inspect actual
SDK add/text/property updates, stable card IDs and editor sendable/caret
state. The fixture-only, abortable fs.watch handoff holds the real tool before
ApprovalService takes input; the driver releases it only after composing a
Unicode multiline draft through real PTY keys. wait_after waits for an
observed new byte occurrence and node_after for a later ordered semantic state change, never
a sleep. Failures keep owner-only
PTY bytes, decoded text, JSON frames and durable Sessions in their reported
private workspace; success removes the entire private workspace after
the child has exited.

**Source contracts checked against current branch, not an executed GREEN:**
The actual approval listener at packages/bundle/tui-app/src/index.ts maps
an Escape null response to rejected when request.signal is not aborted;
only an actual aborted signal maps to cancelled. The real Agent at
packages/core/agent-loop/src/agent.ts:448-465 commits nonempty interrupted
blocks with interrupted:true, while provider failures remain uncommitted.
The tests preserve both contracts. Tool-call-only assistant messages have
empty text, so the textual-reply oracle filters those without omitting real
tool call/result ID checks. The original MBP source run at production
08768d429d recorded **6/14 passing, 8/14 failing** (all five preexisting
keyless plus the ANSI question scenario passed); this worker did
NOT rerun those gates and claims no corrected pass result.

Lead OMP must obtain its fleet-build lock, run in the private Linux PTY
environment off groot and record exact exit codes, not guessed pass counts:

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

A macOS/Windows host without the Linux PTY execution environment
**skips** these describe.skipIf suites: a skip is not acceptance.
No command above was executed by the GitHub-only worker. Passing these
public fixtures alone will not close RFC #6's true Tern, SSH/tmux,
ConPTY, daemon-retention, Windows, stress, and Hermes/OMP differential
gates. Preserve existing strict checks and report any other RED as the
actual API/file/observed-vs-expected behavior, not as permission to
write outside apps/cli/tests/profiles/tui/**.

## TRN8 public-gates fixture repair (connector-only; tests UNRUN)

Owned changed paths: tests/public-services.e2e.ts,
fixtures/tui-llm.ts, fixtures/tui-tools.ts and harness/pty_driver.py,
plus this README. The registration in fixtures/cordis.yml remains the
unchanged production ask-user/tool/LLM fixture configuration.

Acceptance remains all five preexisting keyless cases plus all nine
public-service cases, for both source and built CLI. The fixture now waits
for *actual* new idle after its real two-turn tool result and assistant
completion, not a streamed token. The three approval cases submit the
trigger first, compose with real PTY keys while the real tool is blocked,
release owned fixture state, then assert blocked/restored composer, exact
UTF-16 caret, correlated audit, exclusive marker effects and no duplicate
user messages. Escape sends CSI 27u. Questions wait on decoded semantic node
text and real idle; user-only counts use source.kind=user. Ctrl-C expects
one interrupted:true durable partial, one completed follow-up, one stable
live/durable assistant card identity and replay after resume.

No test command was run by this GitHub connector worker. The lead must
capture exact SHA, stdout/stderr and exit code for each on a Linux PTY
machine, with the existing private fleet lock (no provider keys):

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

Any remaining product RED needs its actual Agent/Session log, decoded
complete TSP frames and exact src file:line reported to the separate
production owner. No production TUI, Agent, SDK, lockfile, keyless or
Cordis registration edits are authorized in this fixture slice.
