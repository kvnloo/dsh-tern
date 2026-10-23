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

Outside Tern (or without the optional SDK), Node readline is a complete
line-oriented ANSI/PTY fallback. It does not require a custom cell renderer
or terminal plugin and works in ordinary terminals and SSH sessions.

Inside Tern, install the optional @stencil-hq/tern 0.1.0 peer in the runtime
environment. The public SDK negotiates TSP, owns framing, credit flow,
reconciliation and semantic editor callbacks. The startup logic chooses the
native backend only after a successful SDK connect. The --no-native option
forces ANSI.

A line of ordinary text queues a follow-up. While a turn is running,
new input queues another turn; /steer followed by text sends step-boundary
steering. /stop cancels active work. /session displays the active Session id,
/help lists commands, and /quit exits. Ctrl+C cancels active work and exits
on two presses while idle; Ctrl+D exits the native UI, EOF exits ANSI.

Human approval explicitly offers Allow once / Deny and fails closed when
unanswered. Typed user-question answers travel over the existing Cordis
waterfall. The pending answer is isolated from ordinary user messages.

## Understand the implementation

- src/index.ts owns root-Agent lifecycle, resume admission, scoped listeners,
  answerer waterfalls and application shutdown.
- src/model.ts projects the durable Session log; live model deltas are
  replaceable view hints and never added as durable transcript entries.
- src/ansi.ts renders the same state using Node readline.
- src/native.ts uses public Tern SDK connect/open/node/render/focus and
  the SDK input iterator. The editor uses UTF-16 offsets and rejects stale
  edits. A missing whole surface creates a distinct new surface epoch.
- src/terminal.ts, src/draft.ts and src/questions.ts isolate terminal,
  editing and answer normalization from model execution.

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

## Known Limitations and Deferred Work

- Native SDK packaging is currently optional for ANSI-only installs;
  distribution should pin and resolve the peer in the workspace lockfile.
- The semantic native transcript supports basic assistant, user and tool
  cards, not every Web/OMP overlay or subagent navigation. A bounded 240-entry
  on-screen window is reconstructed from the full persisted Session log.
- Recovery is limited to three missing whole-surface epochs; the real
  daemon/attach, SSH, ConPTY, multiplexer and stress matrix is outstanding.
- This profile adopts a single root Session; it refuses preset-owned,
  delegated, forked, or different-cwd sessions instead of silently
  recomposing them.
- ANSI is intentionally line-oriented (not a full-screen grid TUI);
  native Tern provides multiline semantic editing.

## Dev Note

All tests must be run in an authenticated workspace with the installed
dependency graph. Mock-SDK tests are not evidence of native terminal
negotiation. Capture a real Tern recording before promotion.
