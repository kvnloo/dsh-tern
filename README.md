---
description: "Interactive DeepSeek Harness terminal profile: native Tern Surface Protocol or ordinary ANSI."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

## Summary

The TUI is a normal DSH plugin bundle layered over dsh-base. It creates or
resumes a root Agent through the existing registry, projects durable Session
events into one view model, and supports multiple turns without changing the
Agent loop. Other application profiles are unaffected.

## Use this package

From a workspace checkout:

~~~sh
pnpm dsh tui
pnpm dsh tui --session-id session-existing
pnpm dsh tui --no-native
~~~

Outside Tern, Node readline is a complete
line-oriented ANSI/PTY fallback. Approval/question input uses an isolated
readline parser. TTY drafts and cursor positions are restored using public
readline writes; pipes retain partial UTF-8 lines under explicit draft
ownership so approval input never inherits an unsent user prompt. It does not require a custom cell renderer
or terminal plugin and works in ordinary terminals and SSH sessions.

The shipped package pins @stencil-hq/tern 0.1.0 with a frozen-lockfile
entry and a narrow pnpm patch rejecting unsupported hello versions;
no manual SDK install is needed. Its public connect negotiates TSP,
decodes PTY typing/paste, and owns framing, credits, chunking, reconciliation,
surface focus and raw-mode restoration. Ordinary typing does NOT arrive as
semantic editor edit events. The --no-native option always forces readline.

A line of ordinary text queues a follow-up. While a turn is running,
new input queues another turn; `/steer TEXT` sends step-boundary steering.
`/stop` cancels current work; `/quit` exits. Model selection uses the
mounted `llm.listProviders/listModels` catalog and
`agentDefaultModel.saveSelection`, then updates the Agent-scoped selection
for the next admitted step. `/models` or `/model` opens a picker;
`/model PROVIDER/MODEL` selects a catalog route directly.

`/sessions` lists resumable, same-directory root Sessions from
`sessionQuery`. `/resume ID` and `/new` switch through the ordinary
Agent registry, preserving each Session's durable history and request
model routing. Running turns must finish or be stopped first; transient
pickers and switches never send the existing composer as a model prompt.

`/plan` and `/tasks` expose logged plan and todo states. `/jobs`,
`/job ID`, `/job-stop ID` use the public job registry, including a
non-consuming read of retained output. `/agents`, `/agent ID`,
`/agent-steer ID TEXT`, `/agent-stop ID` browse and control continuable
descendants through `subagents`; no one-shot control is fabricated.
Both ANSI and native project stable job, task and child identities with
their source lifecycle labels, without guessed completion percentages.
`/session` shows the active ID; `/help` lists commands. Ctrl+C cancels
active work and exits on two presses while idle; Ctrl+D exits the native
UI, EOF exits ANSI.

Human approval explicitly offers Allow once / Deny and fails closed when
unanswered. Typed user-question answers, including multiple selections,
travel over the existing Cordis waterfall. Both backends preserve an unsent
normal composer across safety questions; ANSI also saves/restores readline's
cursor and draft.

## Understand the implementation

- src/index.ts owns root-Agent lifecycle, resume admission, scoped listeners,
  answerer waterfalls and application shutdown.
- src/model.ts projects the durable Session log; live model deltas are
  replaceable view hints and never added as durable transcript entries.
  Its complete durable projection is never truncated by display-window limits.
  Cancellation can retain a nonempty partial assistant reply as a durable
  `assistant/message` with `interrupted: true`. Resume/replay preserves its
  canonical text and identity; the shared view model labels it `Interrupted response`
  for both ANSI and native Tern instead of presenting it as a completed reply.
- src/services.ts reads public model, session, job, plan, todo and subagent
  registries, and routes user requests to their owning APIs, not Agent internals.
- src/ansi.ts renders the same state using Node readline.
- src/native.ts uses public Tern SDK connect/open/node/render/focus/settle,
  real PTY keys and native edit/send/undo handlers. The editor uses UTF-16
  offsets, rejects stale edits, and submits supplied native send text
  atomically. A missing whole surface creates a distinct new surface epoch.
- src/terminal.ts, src/draft.ts, src/questions.ts, src/lifecycle.ts and
  src/record.ts own decision routing, resource teardown and opt-in metadata
  capture independently of model execution. The metadata recorder observes
  actual SDK input/output wire bytes, TSP verbs, frame sequences, ACKs and
  negotiation, without writing user or model bodies to its output file.

References: Tern / OMP by Can Bölük (Stencil Labs), with public SDK\n`@stencil-hq/tern` 0.1.0; the public Hermes for Tern frontend at
https://github.com/kvnloo/hermes-tern ; the earlier Hermes TSP PR at
https://github.com/kvnloo/hermes-agent/pull/431 .

## Model Experience

None. The profile contributes no additional model tools, system text,
or token instructions; submitted prompts use standard Agent follow-up
and steering APIs.

#### KV Cache effect

None beyond ordinary requests. Presentation and live-stream buffers do
not enter the model's context prefix.

## RFC #6 acceptance and reproduction

The Draft PR remains incomplete until independent execution confirms the full
RFC #6 matrix. The following are release gates, not waived requirements:
shipped-profile PTY and real Tern end-to-end tests, tool approval and
multi-select scenarios, durable replay consistency, OMP/Hermes differential
captures, detach/reattach and gone/settle recovery, tmux/SSH/ConPTY,
capability downgrades, resize/theme/visibility, event parser fuzzing,
APC/credit limits and chunking, cancellation, startup failure and teardown.
Unsupported semantic kinds must render using supported local primitives.

### Test without provider keys

~~~sh
pnpm install --frozen-lockfile --prefer-offline
pnpm run test packages/bundle/tui-app
pnpm run build:lib:host
pnpm run build:lib:client
pnpm run test:e2e apps/cli/tests/profiles/tui/tests/keyless.e2e.ts
pnpm run typecheck
pnpm run build
pnpm run hygiene
pnpm run doc-sync
~~~

The test-only plugin at
`apps/cli/tests/profiles/tui/fixtures/tui-llm.ts` is a deterministic
LLM **adapter** mounted through a real profile. It does not replace the
Agent, Session, tool registry or approval runtime; it supplies tool, normal,
and intentional `[failure]` stream paths without model keys or network
inference. A real Tern session can be exercised with:

~~~sh
mkdir -p /tmp/dsh-tui-private
chmod 700 /tmp/dsh-tui-private
DSH_TUI_TEST_STORE=/tmp/dsh-tui-private/sessions \
DSH_TSP_RECORD=/tmp/dsh-tui-private/metadata.jsonl \
pnpm dsh --profile tui --patch apps/cli/tests/profiles/tui/fixtures/cordis.yml
~~~

Enter `first`, paste a multiline message, `[tool]`, `[failure]`,
`/stop`, `/session`, then `/quit`. For real input, repeat the same
script inside and outside Tern and inspect the stable Session IDs, tool
call/result card identity and terminal reset. `DSH_TSP_RECORD` collects actual TSP wire verbs, exact wire UTF-8
byte lengths, body byte lengths, frame/ACK sequence numbers, negotiated kinds
and features, monotonic time, the renderer revision and session/event identity.
Neither ordinary PTY keys nor user/model/tool payload bodies are serialized. Full input/output TSP payloads are captured only when
`DSH_TSP_RECORD_FULL` is explicitly set to a private path; full recordings
contain user/tool content. Use `umask 077` before enabling that mode and
never commit such recordings.

For differential OMP/Hermes recordings, replay the same input sequence using
Hermes x Tern `kvnloo/hermes-tern/frontend`, capture its SDK frames with
`TERN_TSP_RECORD`, and DSH's with `DSH_TSP_RECORD_FULL`. Keep fixture
files private, normalize timestamps and ephemeral surface epoch suffixes,
and compare semantic actions, stable call IDs, settled states, and text
ownership rather than raw escape byte order. SDK-only tests are not daemon,
SSH, multiplexing or platform acceptance evidence.

## Dev Note

Mock-SDK callback tests are insufficient on their own: use the real
`KeyDecoder` tests, keyless profile test and a private real-Tern capture.
No command result is claimed by this document; OMP must run and inspect
the relevant focused tests and runtime matrix before promotion.

## Retention and packed-consumer regression gates (TRN6)

Tern's `gone` event for a **settled child** means the native terminal
has already forgotten that subtree; any later `del`, `move`, `set` or
parent-before operation referencing it is invalid. The 0.1.0 Surface
normally retains its last sent View, so filtering DSH's Snapshot alone is
insufficient. This downstream SDK patch adds a typed `Surface.forget(ids)`
that prunes sent, latest, pending and queued **presentation** references
without emitting a delete or reopening the surface. The complete Session
event log and other settled entries remain authoritative.

A durable transcript exceeding the protocol's 24 MiB reassembled-message
limit must never be sent as one initial frame. Native rendering admits a
bounded prefix (512 KiB estimated encoded entry data per progress step,
20 MiB maximum for an individual entry), keeps durable IDs/order intact,
and advances only on actual SDK `Surface.onAck` callbacks. SDK credit
accounting and frame coalescing remain authoritative. A whole-surface
`gone` still reopens only the missing surface with its real protocol
`open` event; a child `gone` never does. Hidden surfaces defer replay
until visible, and no historical Session events are truncated.

The root pnpm `patchedDependencies` map supplies the fixed SDK to
development builds, but **does not travel into a clean npm install**.
The package-local `tsdown.config.ts` therefore bundles the patched
`@stencil-hq/tern@0.1.0` SDK inside the shipped host `lib/index.js`.
Do not treat a root-only patched install as consumer proof.

On the fleet-build MBP after admission/lock approval, from the repository
root and at the **actual checked-out branch SHA**, run:

~~~sh
pnpm install --frozen-lockfile --prefer-offline
pnpm run build:native-system
pnpm exec vitest run packages/bundle/tui-app/tests/retention.spec.ts packages/bundle/tui-app/tests/transport-conformance.spec.ts packages/bundle/tui-app/tests/native-regressions.spec.ts
pnpm run build:lib:host
node packages/bundle/tui-app/tests/fixtures/verify-packed-sdk.mjs
pnpm run test:e2e apps/cli/tests/profiles/tui/tests/keyless.e2e.ts
pnpm run hygiene
pnpm run doc-sync
~~~

The packed-consumer gate compares a real `pnpm pack` artifact against
the **unpatched npm registry 0.1.0** negative control: it asserts that
the shipped JS includes Surface forget/ACK methods rather than external
SDK imports while the registry's unmodified JS contains neither method
nor the root hello-version guard. For an offline registry control, set
`REGISTRY_TERN_TARBALL` to a previously downloaded **unpatched**
registry archive. The check never installs/publishes npm packages.

A full PTY/application ANSI late-hello witness still requires the CLI
fallback boundary (owned separately); parser-only witnesses are not proof
that a late reply after ANSI initialization stays outside readline.
Do not claim that gate or real Tern/SSH/ConPTY acceptance until the
lead's authorized isolated headless environment reproduces it. All
connector-authored changes remain **unrun** pending those checks.
