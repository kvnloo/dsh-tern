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
line-oriented ANSI/PTY fallback. It does not require a custom cell renderer
or terminal plugin and works in ordinary terminals and SSH sessions.

The shipped package directly pins @stencil-hq/tern 0.1.0 with a frozen-lockfile
entry; no manual SDK install is needed. Its public connect negotiates TSP,
decodes PTY typing/paste, and owns framing, credits, chunking, reconciliation,
surface focus and raw-mode restoration. Ordinary typing does NOT arrive as
semantic editor edit events. The --no-native option always forces readline.

A line of ordinary text queues a follow-up. While a turn is running,
new input queues another turn; /steer followed by text sends step-boundary
steering. /stop cancels active work. /session displays the active Session id,
/help lists commands, and /quit exits. Ctrl+C cancels active work and exits
on two presses while idle; Ctrl+D exits the native UI, EOF exits ANSI.

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
- src/ansi.ts renders the same state using Node readline.
- src/native.ts uses public Tern SDK connect/open/node/render/focus/settle,
  real PTY keys and native edit/send/undo handlers. The editor uses UTF-16
  offsets, rejects stale edits, and submits supplied native send text
  atomically. A missing whole surface creates a distinct new surface epoch.
- src/terminal.ts, src/draft.ts, src/questions.ts, src/lifecycle.ts and
  src/record.ts own decision routing, resource teardown and opt-in metadata
  capture independently of model execution.

References: Tern by Stencil Labs; the public Hermes for Tern frontend at
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
call/result card identity and terminal reset. `DSH_TSP_RECORD` collects
only event kinds, serialized lengths, capability metadata and revision
numbers. Full input/output TSP payloads are captured only when
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
