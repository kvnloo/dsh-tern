import { describe, expect, it } from 'vitest'
import { KeyDecoder, node, type Node, type SessionInput } from '@stencil-hq/tern'
import { Draft } from '../src/draft.ts'
import { Transcript } from '../src/model.ts'
import { NativeTerminal, type TernSDK, type TernSession, type TernSurface } from '../src/native.ts'
import type { Snapshot } from '../src/model.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const keys = (value: string): SessionInput[] =>
  new KeyDecoder().feed(bytes(value)).map(key => ({ type: 'key', key }))

function terminalFixture() {
  const queue: SessionInput[] = []
  let wake: (() => void) | undefined
  let ended = false
  const frames: Array<{ main: unknown[]; dock: unknown[]; layer: unknown[] }> = []
  const surfaces: TernSurface[] = []
  const settled: string[] = []
  const session: TernSession = {
    caps: { kinds: ['card', 'md', 'editor', 'input', 'text', 'row', 'col', 'button'], features: ['settle'] },
    open(): TernSurface {
      const surface: TernSurface = {
        closed: false,
        render(view) { frames.push(view) },
        focus() {},
        settle(id) { settled.push(id) },
      }
      surfaces.push(surface)
      return surface
    },
    async close() { ended = true; wake?.() },
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        if (!queue.length) await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
        while (queue.length) yield queue.shift()!
      }
    },
  }
  const sdk: TernSDK = { connect: async () => null, node }
  const term = new NativeTerminal(sdk, session)
  return {
    term, frames, surfaces, settled,
    push(input: SessionInput) { queue.push(input); wake?.() },
    async drain() { await new Promise(resolve => setImmediate(resolve)) },
  }
}
const empty: Snapshot = {
  sessionId: 'test', status: 'idle', entries: [], live: '', notice: '', draft: '', cursor: 0,
}
function findEditor(frames: ReturnType<typeof terminalFixture>['frames']): Node {
  function visit(value: unknown): Node | undefined {
    if (!value || typeof value !== 'object') return
    const item = value as { kind?: string; children?: readonly unknown[] }
    if (item.kind === 'editor') return value as Node
    for (const child of item.children ?? []) {
      const found = visit(child)
      if (found) return found
    }
  }
  for (const part of frames.at(-1)!.dock) {
    const found = visit(part)
    if (found) return found
  }
  throw new Error('missing editor')
}

describe('native-profile RED behavioral witnesses against the real SDK decoder', () => {
  it('retains plain typed characters, cursor moves, deletion, and bracketed multiline paste', () => {
    const draft = new Draft()
    const decoded = [
      ...keys('abc'),
      ...keys('\x1b[D'),
      ...keys('\x7f'),
      ...keys('\x1b[200~\nline 2\x1b[201~'),
    ]
    for (const input of decoded) if (input.type === 'key') draft.key(input.key)
    expect(draft.text).toBe('a\nline 2c')
    expect(draft.cursor).toBe('a\nline 2'.length)
  })

  it('accepts keys from the SDK iterator rather than waiting for native edit events', async () => {
    const f = terminalFixture()
    const sent: string[] = []
    await f.term.start(text => sent.push(text), () => {}, () => {})
    f.term.update(empty)
    for (const input of keys('hello\x1b[200~\nthere\x1b[201~\r')) f.push(input)
    await f.drain()
    expect(sent).toEqual(['hello\nthere'])
    await f.term.closed()
  })

  it('accepts an externally supplied multiline send with an empty ready draft exactly once', async () => {
    const f = terminalFixture()
    const sent: string[] = []
    await f.term.start(text => sent.push(text), () => {}, () => {})
    f.term.update(empty)
    findEditor(f.frames).handlers?.onSend?.({
      ev: 'send', sf: 'dsh', id: 'dock.composer.line.input', text: 'first\nsecond', raw: {},
    })
    expect(sent).toEqual(['first\nsecond'])
    await f.term.closed()
  })

  it('updates one semantic tool identity from call through result and error', () => {
    const history = new Transcript('session')
    const event = (seq: number, type: string, data: unknown): SessionEvent =>
      ({ seq, type, data, time: seq }) as SessionEvent
    history.accept(event(0, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' }))
    expect(history.snapshot().entries).toHaveLength(1)
    history.accept(event(1, 'tool/result', { turn: 1, step: 1, message: {
      toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'ok' }],
    } }))
    expect(history.snapshot().entries).toHaveLength(1)
    expect(history.snapshot().entries[0]).toMatchObject({ id: 'tool.call-1', text: 'Tool result: ok' })
    history.accept(event(2, 'tool/call', { turn: 1, step: 2, callId: 'call-2', name: 'other', arguments: '{}' }))
    history.accept(event(3, 'tool/result', { turn: 1, step: 2, message: {
      toolCallId: 'call-2', isError: true, content: [{ type: 'text', text: 'failed' }],
    } }))
    expect(history.snapshot().entries.at(-1)).toMatchObject({ id: 'tool.call-2', kind: 'error' })
  })

  it('settles only durable tool results and recovers a gone native surface', async () => {
    const f = terminalFixture()
    await f.term.start(() => {}, () => {}, () => {})
    f.term.update({ ...empty, entries: [{ id: 'tool.one', kind: 'tool', text: 'Running bash' }] })
    expect(f.settled).not.toContain('main.tool.one')
    f.term.update({ ...empty, entries: [{ id: 'tool.one', kind: 'tool', text: 'Tool result: done' }] })
    expect(f.settled).toContain('main.tool.one')
    f.push({ type: 'event', event: { ev: 'gone', sf: 'dsh', ids: ['dsh'], raw: {} } })
    await f.drain()
    expect(f.surfaces).toHaveLength(2)
    await f.term.closed()
  })

  it('reports native protocol failures to the owning lifecycle instead of silently exiting zero', async () => {
    const f = terminalFixture()
    let failure: Error | undefined
    await f.term.start(() => {}, () => {}, error => { failure = error })
    f.term.update(empty)
    f.push({ type: 'event', event: {
      ev: 'error', sf: 'dsh', msg: 'invalid frame', raw: {},
    } })
    await f.drain()
    expect(failure?.message).toContain('invalid frame')
    await f.term.closed()
  })

  it('does not leave a cancelled outstanding tool marked running', () => {
    const history = new Transcript('session')
    history.accept({ seq: 0, type: 'tool/call', time: 0, data: {
      callId: 'abandoned', name: 'bash', arguments: '{}', turn: 1, step: 1,
    } } as SessionEvent)
    history.accept({ seq: 1, type: 'turn/end', time: 1, data: {
      turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } },
    } } as SessionEvent)
    expect(history.snapshot().entries[0]?.text).toContain('Interrupted')
  })
})
