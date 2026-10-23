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
