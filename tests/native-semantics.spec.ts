/**
 * RFC #6 native semantics: assertion-only SDK tree witnesses.
 * Real pointer hit testing still requires the private Tern ctl witness.
 */
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { node } from '@stencil-hq/tern'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AnsiTerminal } from '../src/ansi.ts'
import { Transcript, type Entry, type Snapshot } from '../src/model.ts'
import { NativeTerminal, type TernSession, type TernSurface } from '../src/native.ts'

type Cell = {
  kind: string
  props: Record<string, unknown>
  children: readonly unknown[]
  handlers?: Record<string, (...args: never[]) => void>
}
function flatten(value: unknown): Cell[] {
  if (!value || typeof value !== 'object' || !('kind' in value)) return []
  const cell = value as Cell
  return [cell, ...(cell.children ?? []).flatMap(flatten)]
}
const base: Snapshot = {
  sessionId: 'semantic', status: 'idle', entries: [], draft: '', cursor: 0,
  live: '', notice: '',
}
function fixture(kinds: string[]) {
  const frames: Array<{ main: unknown[]; dock: unknown[]; layer: unknown[] }> = []
  const focus: Array<string | null> = []
  const settled: string[] = []
  const session: TernSession = {
    caps: { kinds, features: ['settle'] },
    open(): TernSurface {
      return {
        closed: false,
        render(view) { frames.push(view) },
        focus(id) { focus.push(id) },
        settle(id) { settled.push(id) },
      }
    },
    async close() {},
    async *[Symbol.asyncIterator]() {},
  }
  const terminal = new NativeTerminal({ node }, session)
  return {
    terminal, focus, settled, frames,
    latest: () => frames.at(-1)!,
    region: (part: 'main' | 'dock' | 'layer') => frames.at(-1)![part].flatMap(flatten),
  }
}
function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq: SessionSeq(seq), time: seq, type, data } as SessionEvent
}

describe('negotiated native question/approval hit surfaces', () => {
  it('uses a centered modal overlay, with actions inside its hit-test card', async () => {
    const f = fixture(['overlay', 'card', 'col', 'row', 'text', 'md', 'el', 'editor'])
    f.terminal.update(base)
    const pending = f.terminal.ask({
      id: 'approval:real', title: 'Allow this tool?', detail: 'Approval is required.',
      choices: [{ label: 'Allow once', value: 'allow' }, { label: 'Deny', value: 'deny' }],
    })
    const layer = f.region('layer')
    const overlay = layer.find(item => item.kind === 'overlay')!
    expect(overlay).toBeDefined()
    expect(overlay.props).toMatchObject({
      modal: true, anchor: 'center', size: 'md', head: 'Allow this tool?',
      role: 'dsh.question',
    })
    expect(f.latest().layer).toHaveLength(1)
    expect(layer.filter(item => item.kind === 'el' && item.props.tag === 'button')).toHaveLength(2)
    expect(f.region('dock').find(item => item.kind === 'editor')?.props.sendable).toBe(false)
    const choice = layer.find(item => item.kind === 'el' && item.props.text === '2) Deny')!
    expect(f.focus.at(-1)).toBe('layer.' + overlay.props.key + '.answer')
    expect(choice.handlers?.onClick).toBeTypeOf('function')
    choice.handlers!.onClick!()
    expect(await pending).toBe('deny')
    expect(f.latest().layer).toHaveLength(0)
    await f.terminal.closed()
  })

  it('uses an actionable dock prompt and correct focus if overlay is not negotiated', async () => {
    const f = fixture(['card', 'col', 'row', 'text', 'el', 'editor'])
    f.terminal.update(base)
    const pending = f.terminal.ask({
      id: 'question:real', title: 'Select a choice',
      choices: [{ label: 'Alpha', value: 'alpha' }, { label: 'Beta', value: 'beta' }],
    })
    expect(f.latest().layer).toEqual([])
    const root = f.region('dock').find(item => item.props.role === 'dsh.question')!
    expect(root).toBeDefined()
    expect(f.focus.at(-1)).toBe('dock.' + root.props.key + '.answer')
    expect(f.region('dock').find(item => item.kind === 'editor' && item.props.sendable === false)).toBeDefined()
    const button = f.region('dock').find(item => item.kind === 'el' && item.props.text === '1) Alpha')!
    button.handlers!.onClick!()
    expect(await pending).toBe('alpha')
    expect(f.region('dock').some(item => item.props.role === 'dsh.question')).toBe(false)
    await f.terminal.closed()
  })

  it('keeps negotiated no-editor fallback in dock with clickable choices and no false focus', async () => {
    const f = fixture(['col', 'text', 'rows'])
    f.terminal.update(base)
    const pending = f.terminal.ask({
      id: 'no-editor', title: 'Choose', choices: [{ label: 'No', value: 'no' }],
    })
    expect(f.latest().layer).toEqual([])
    expect(f.focus.every(id => id === null)).toBe(true)
    const choice = f.region('dock').find(item => item.props.role === 'dsh.question.choice')!
    choice.handlers!.onClick!()
    expect(await pending).toBe('no')
    await f.terminal.closed()
  })

  it('does not let prior opening callbacks answer a reopened logical request', async () => {
    const f = fixture(['overlay', 'col', 'row', 'text', 'el', 'editor'])
    f.terminal.update(base)
    const req = { id: 'same:logical-id', title: 'Again?', choices: [{ label: 'Yes', value: 'yes' }] }
    const first = f.terminal.ask(req)
    const stale = f.region('layer').find(item => item.kind === 'el')!.handlers!.onClick!
    const firstKey = f.region('layer').find(item => item.kind === 'overlay')!.props.key
    stale()
    expect(await first).toBe('yes')
    const second = f.terminal.ask(req)
    const secondKey = f.region('layer').find(item => item.kind === 'overlay')!.props.key
    expect(secondKey).not.toEqual(firstKey)
    stale()
    expect(f.region('layer').some(item => item.kind === 'overlay')).toBe(true)
    f.region('layer').find(item => item.kind === 'el')!.handlers!.onClick!()
    expect(await second).toBe('yes')
    await f.terminal.closed()
  })
})

describe('durable semantic tool presentation', () => {
  it('omits only tool-call-only empty assistant rows and replays tool facts without duplicate rows', () => {
    const id = ToolCallId('real-call')
    const callOnly = createAssistantMessage({
      source: { provider: 'fixture', model: 'fixed' },
      content: [{ type: 'tool-call', id, name: 'tui_fixture_effect', arguments: '{}' }],
    })
    const log: SessionEvent[] = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'assistant/message', { turn: 1, step: 1, message: callOnly, stream: [] }),
      event(2, 'tool/call', { turn: 1, step: 1, callId: id, name: 'tui_fixture_effect', arguments: '{}' }),
      event(3, 'tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: id, isError: false, content: [{ type: 'text', text: 'DSH_TUI_FIXTURE_OK' }],
        }),
      }),
      event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const t = new Transcript('tools')
    t.accept(log[0]!)
    expect(t.accept(log[1]!)).toBeUndefined()
    expect(t.snapshot().entries).toEqual([])
    t.accept(log[2]!)
    expect(t.snapshot().entries).toEqual([{
      id: 'tool.real-call', kind: 'tool', text: 'Running tui_fixture_effect',
      tool: { name: 'tui_fixture_effect', status: 'running' },
    }])
    t.accept(log[3]!)
    t.accept(log[4]!)
    expect(t.snapshot().entries).toEqual([{
      id: 'tool.real-call', kind: 'tool', text: 'Tool result: DSH_TUI_FIXTURE_OK',
      tool: { name: 'tui_fixture_effect', status: 'done' },
    }])
    const replay = new Transcript('tools')
    replay.replay({ seq: log.length, eventAt: (seq: SessionSeq) => log[seq] } as Parameters<Transcript['replay']>[0])
    expect(replay.snapshot().entries).toEqual(t.snapshot().entries)
    replay.replay({ seq: log.length, eventAt: (seq: SessionSeq) => log[seq] } as Parameters<Transcript['replay']>[0])
    expect(replay.snapshot().entries).toHaveLength(1)
    expect(log[1]?.data).toMatchObject({ message: callOnly }) // Canonical event unchanged.
  })

  it('preserves errors, cancellations, whitespace text, interrupted partials and diagnostics', () => {
    const t = new Transcript('exceptional')
    const history: SessionEvent[] = []
    const admit = (entry: SessionEvent): void => { history.push(entry); t.accept(entry) }
    const id = ToolCallId('failed')
    admit(event(0, 'tool/call', { turn: 1, step: 1, callId: id, name: 'browse', arguments: '{}' }))
    admit(event(1, 'tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: id, isError: true, content: [{ type: 'text', text: 'Denied' }] }),
    }))
    expect(t.snapshot().entries[0]).toMatchObject({ kind: 'error', tool: { name: 'browse', status: 'error' } })
    const abandoned = ToolCallId('abandoned')
    admit(event(2, 'tool/call', { turn: 2, step: 1, callId: abandoned, name: 'bash', arguments: '{}' }))
    admit(event(3, 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
    expect(t.snapshot().entries[1]).toMatchObject({
      id: 'tool.abandoned', kind: 'error', text: 'Interrupted bash',
      tool: { name: 'bash', status: 'cancelled' },
    })
    const message = (content: Parameters<typeof createAssistantMessage>[0]['content'], interrupted = false) =>
      event(interrupted ? 5 : 4, 'assistant/message', {
        turn: 3, step: interrupted ? 2 : 1, ...(interrupted ? { interrupted: true } : {}),
        message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixed' }, content }),
        stream: [],
      })
    admit(message([
      { type: 'text', text: ' \t ' },
      { type: 'tool-call', id: ToolCallId('unused'), name: 'bash', arguments: '{}' },
    ]))
    admit(message([
      { type: 'tool-call', id: ToolCallId('still-visible'), name: 'bash', arguments: '{}' },
    ], true))
    expect(t.snapshot().entries.slice(2).map(row => row.text)).toEqual([
      ' \t ', 'Interrupted response\n',
    ])
    const durable = {
      seq: history.length, eventAt: (seq: SessionSeq) => history[seq],
    } as Parameters<Transcript['replay']>[0]
    const resumed = new Transcript('exceptional')
    resumed.replay(durable)
    expect(resumed.snapshot().entries).toEqual(t.snapshot().entries)
    resumed.replay(durable)
    expect(resumed.snapshot().entries).toHaveLength(4)
  })

  it('uses a stable native tool node with a semantic head and terminal-owned fold', async () => {
    const f = fixture(['tool', 'card', 'col', 'row', 'text', 'editor'])
    const running: Entry = {
      id: 'tool.real-call', kind: 'tool', text: 'Running tui_fixture_effect',
      tool: { name: 'tui_fixture_effect', status: 'running' },
    }
    const done: Entry = { ...running, text: 'Tool result: DSH_TUI_FIXTURE_OK',
      tool: { name: 'tui_fixture_effect', status: 'done' } }
    f.terminal.update({ ...base, entries: [running] })
    const first = f.region('main').find(item => item.kind === 'tool')!
    expect(first.props).toMatchObject({
      key: 'tool.real-call', name: 'tui_fixture_effect', title: 'tui_fixture_effect',
      status: 'running', collapsible: true,
    })
    expect(first.props).not.toHaveProperty('collapsed')
    expect(first.props).not.toHaveProperty('age')
    expect(first.props).not.toHaveProperty('took')
    expect(first.props).not.toHaveProperty('target')
    expect(f.settled).not.toContain('main.tool.real-call')
    f.terminal.update({ ...base, entries: [done] })
    const final = f.region('main').find(item => item.kind === 'tool')!
    expect(final.props).toMatchObject({
      key: first.props.key, name: 'tui_fixture_effect', title: 'tui_fixture_effect',
      status: 'done', collapsible: true,
    })
    expect(final.props).not.toHaveProperty('collapsed')
    expect(f.region('main').filter(item => item.kind === 'tool')).toHaveLength(1)
    expect(f.settled).toContain('main.tool.real-call')
    await f.terminal.closed()
  })

  it('keeps factual identity in card/row fallbacks and counts metadata in eviction versions', async () => {
    const f = fixture(['card', 'col', 'text', 'rows'])
    const entry: Entry = {
      id: 'tool.same', kind: 'tool', text: 'out',
      tool: { name: 'read', status: 'running' },
    }
    f.terminal.update({ ...base, entries: [entry] })
    expect(f.region('main').some(item => item.kind === 'tool')).toBe(false)
    expect(f.region('main').some(item => item.props.text === 'read · running')).toBe(true)
    f.terminal.update({ ...base, entries: [{ ...entry, tool: { name: 'read', status: 'done' } }] })
    expect(f.region('main').some(item => item.props.text === 'read · done')).toBe(true)
    const version = f.terminal as unknown as { version(entry: Entry): string }
    expect(version.version(entry)).not.toBe(version.version({ ...entry, tool: { name: 'read', status: 'done' } }))
    expect(version.version(entry)).not.toBe(version.version({ ...entry, tool: { name: 'write', status: 'running' } }))
    await f.terminal.closed()
  })

  it('includes the tool name and lifecycle in ANSI output without independent state', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false })
    const stdout = Object.assign(new PassThrough(), { isTTY: false })
    let output = ''
    stdout.on('data', data => { output += String(data) })
    const terminal = new AnsiTerminal({ stdin, stdout })
    await terminal.start(() => {}, () => {}, () => {})
    const running: Entry = {
      id: 'tool.same', kind: 'tool', text: 'Running tui_fixture_effect',
      tool: { name: 'tui_fixture_effect', status: 'running' },
    }
    terminal.update({ ...base, entries: [running] })
    terminal.update({ ...base, entries: [{ ...running, text: 'Tool result: OK',
      tool: { name: 'tui_fixture_effect', status: 'done' } }] })
    expect(output).toContain('[tool tui_fixture_effect · running] Running tui_fixture_effect')
    expect(output).toContain('[tool tui_fixture_effect · done] Tool result: OK')
    await terminal.closed()
  })
})
