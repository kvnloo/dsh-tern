---
description: "Interactive DeepSeek Harness terminal profile with Tern Surface Protocol and ANSI fallback."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

## Summary

The TUI is a named DeepSeek Harness application bundle layered over [dsh-base](../base/README.md). It creates or resumes a root Agent through public services, projects durable Session events into one transcript, and presents the same state through native Tern Surface Protocol (TSP) or ordinary ANSI. It has no separate Agent runtime, and other application profiles remain independent.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Launch and input modes

From an installed workspace checkout with generated source aliases, launch the profile through the supported dsh CLI rather than executing the package directly:

~~~sh
pnpm dsh tui
pnpm dsh tui --session-id session-existing
pnpm dsh tui --no-native
~~~

The native path uses the pinned, bundled `@stencil-hq/tern@0.1.0` SDK for hello/DA1 negotiation, PTY key decoding, in-band framing, chunking, credits, input focus and terminal restoration. A terminal without negotiated native support falls back to Node readline; `--no-native` forces that line-oriented ANSI mode even inside Tern. No separate Tern plugin or manual SDK installation is required.

ANSI preserves unsent text and readline cursor position across approval prompts. Piped input retains partial UTF-8 lines separately from the approval buffer. The SDK-based input fence buffers keys received during probing and filters late APC/OSC replies before readline; on close it releases only its own derived input and listeners, without destroying the process input stream. A passive probe does not pause the successfully connected SDK input.

### Commands, sessions and human decisions

Ordinary input sends a follow-up, including a queued turn while the Agent runs. `/steer TEXT` requests step-boundary steering; `/stop` cancels active work, `/quit` exits, and `/help` lists commands. Ctrl+C cancels a running turn and exits on a second idle press; Ctrl+D exits native mode and EOF closes ANSI.

Use `/models` or `/model` for the live provider catalog picker; `/model PROVIDER/MODEL` validates a route through `llm.listProviders` and `llm.listModels`, saves it through `agentDefaultModel`, and changes the Agent-scoped selection for subsequent steps. `/sessions` enumerates resumable root Sessions in the same working directory; `/resume ID` and `/new` change ownership only after the active Agent becomes idle. Resume refuses missing persistence, an already-owned Agent, a foreign working directory, or a preset/subagent Session.

`/plan`, `/tasks`, `/jobs`, `/job ID` and `/job-stop ID` read or control public plan, todo and job services; job detail reads retained output without consuming a model-facing cursor. `/agents`, `/agent ID`, `/agent-steer ID TEXT` and `/agent-stop ID` use the public descendant registry and continuable-child controls. Both renderers show source lifecycle labels and stable ids without inventing completion percentages; `/session` reports the active identity.

Approval offers Allow once or Deny; unanswered or aborted approval fails closed. Questions support offered options, free-form answers and multiple selections. Both renderers give the question exclusive input ownership and preserve the normal unsent composer instead of treating it as an answer or model prompt.

### Keyless profile and private Tern reproduction

The test-only `apps/cli/tests/profiles/tui/fixtures/tui-llm.ts` supplies a deterministic LLM adapter through the real profile; it does not replace the Agent, Session, tools or approvals, and requires no provider key. After installing dependencies and preparing the source/build artifacts, an isolated Tern session can launch the fixture with private storage:

~~~sh
mkdir -p /tmp/dsh-tui-private
chmod 700 /tmp/dsh-tui-private
DSH_TUI_TEST_STORE=/tmp/dsh-tui-private/sessions \
DSH_TSP_RECORD=/tmp/dsh-tui-private/metadata.jsonl \
pnpm dsh --profile tui --patch apps/cli/tests/profiles/tui/fixtures/cordis.yml
~~~

Enter `first`, paste multiline text, then exercise `[tool]`, `[failure]`, `/stop`, `/session` and `/quit` inside and outside Tern. Compare durable Session identity, stable tool call/result cards, approval input routing and terminal cleanup. `DSH_TSP_RECORD` stores wire direction, operation, actual UTF-8 body/wire byte lengths, chunk and frame/ACK facts, negotiated capabilities, revision and event sequence, without saving prompt, model, tool or ordinary key contents. `DSH_TSP_RECORD_FULL` instead captures sensitive full SDK payloads: use `umask 077`, a privately owned path, and never publish or commit those recordings.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Session authority and presentation

- `src/index.ts` owns root Agent creation/adoption, listeners, approval/question waterfalls and shutdown; `src/services.ts` reads public model, session, job, plan, todo and subagent capabilities without Agent internals.
- `src/model.ts` derives stable user, assistant and tool rows from committed Session events. Live assistant deltas only replace a temporary preview; interruption can retain a durable partial assistant message marked interrupted, and complete durable history is never truncated by a display window.
- `src/ansi.ts` presents shared state through readline. `src/draft.ts` owns unsent native text, undo and UTF-16 caret/edit offsets; stale editor edits cannot overwrite a newer draft. PTY typing and paste are ordinary SDK key events, not TSP edit events.
- `src/native.ts` reconciles that state into negotiated semantic nodes, with stable tool-call identities, a native composer, bounded replay and modal question ownership. Unsupported semantic kinds use supported local presentation primitives; native send submits supplied text atomically through the same Agent callback.
- `src/input-fence.ts`, `src/terminal.ts`, `src/questions.ts` and `src/lifecycle.ts` isolate input decisions and reverse-order cleanup. `src/record.ts` observes opt-in transport metadata, not message bodies or Agent persistence.

### Retention, credits and packaged SDK

Tern owns native scrollback, focus, resizing and rendered node state; DSH owns every durable Session event. A `gone` notification for a settled child only removes corresponding SDK presentation references through the downstream `Surface.forget(ids)` extension; it never deletes the Session log or reopens an unrelated surface. A whole-surface `gone` may create a new bounded recovery epoch, while hidden surfaces wait until visible to recover. Theme and resize events reconcile the existing snapshot.

Durable replay admits a bounded prefix, estimates no more than 512 KiB of serialized entry data per progress step, rejects an individual entry beyond 20 MiB and advances only on actual SDK `onAck` callbacks; this keeps complete Session identities while respecting the protocol reassembled-message limit of 24 MiB. Native close is credit-bounded: a hidden or detached terminal may leave pending frames unacknowledged, so the SDK sends at most its close and discards unsent presentation work rather than blocking shutdown. A sent frame is not proof of a terminal ACK.

The root pnpm patch to `@stencil-hq/tern@0.1.0` supplies the required strict hello, child-forget, ACK replay and guarded-close contract to development. A root `patchedDependencies` map does not accompany an npm consumer, so package-local `tsdown.config.ts` bundles that patched SDK into the shipped host `lib/index.js`. `pnpm pack` must verify bundled bytes against an unpatched public-registry tarball as a negative control; no registry publish or real model key is needed. Publishing files include the complete host entries, patch YAML and generated declaration tree; runtime chunks must remain bundled or otherwise included by the build.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-base](../base/README.md) — shared application composition, services and persistence.
- [TUI RFC #6](https://github.com/kvnloo/deepseek-harness/issues/6) — the full protocol and acceptance contract.
- [Hermes x Tern frontend](https://github.com/kvnloo/hermes-tern) — comparative native-surface implementation; credit to Can Bölük / Stencil Labs for Tern and its protocol.
- [Hermes TSP groundwork](https://github.com/kvnloo/hermes-agent/pull/431) — comparative prior work, not a separate DSH runtime.
- [Bilingual documentation contract](../../../docs/i18n/README.md) — how this README pair stays consistent.

-----

<a id="model-experience"></a>
## Model Experience

None. The profile adds no model-facing tools, system prompt, token instruction or alternate Agent path: user requests enter the standard follow-up/steering APIs.

#### KV Cache effect

None beyond ordinary Agent requests. Terminal frames, pending drafts, live previews and metadata capture never enter the model context prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Native support is negotiated** — unsupported terminals use the ANSI fallback. Real Tern/SSH/tmux/ConPTY and detach/reattach acceptance are not established merely by SDK unit tests.
- **Public service boundaries apply** — model selection requires mounted LLM and default-model services; Session adoption requires persistence and a compatible root Session; one-shot subagents have no continuation control.
- **Terminal retention is not Session retention** — native settled children can disappear from Tern scrollback while persisted history remains; very large single entries exceed the safe native-message budget rather than being silently dropped.
- **Shutdown does not promise final ACK** — hidden or detached native terminals can prevent a final acknowledgement; teardown abandons unsent presentation without losing Session persistence.
- **RFC acceptance remains open** — keyless shipped-profile PTY and real Tern evidence must still cover approval/multiselect, true native pointer actions, credits/APC/chunking/parser fuzz, resize/theme/visibility, gone/settle, differential Hermes/OMP recordings, SSH/multiplexers/ConPTY, cancellation and fault recovery. No synthetic harness output substitutes for those checks.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The public Tern SDK and the patched consumer must be tested at an exact checked-out Git head with a real `.git` directory. Do not suppress environment failures caused by a detached source archive. Generate source aliases before a source profile launch; the fixture uses the default-model dependency declared by the CLI manifest. Generator-written config, Cordis API and plugin catalogs and the section-keyed translation record must be refreshed canonically after JSDoc or README edits; never hand-maintain their pointers. Large V8 doc-graph heap aborts require a separate environment diagnosis, not automatic gate relaxation.

Run these commands on the authorized checkout; listing them is not a claim they passed:

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

For the packed-consumer negative control, `REGISTRY_TERN_TARBALL` may point to a previously downloaded *unpatched* registry tarball. The packed fixture verifies the SDK methods and byte identity without publishing packages. Differential recording uses private `DSH_TSP_RECORD_FULL` and Hermes `TERN_TSP_RECORD` paths with timestamps and ephemeral surface epochs normalized; compare stable semantic ids, input ownership and settle behavior, not escape-byte order. GUI runs belong only in an isolated private headless compositor, never the host desktop or user daemon.

</details>

