import { describe, expect, it } from 'vitest'
import { node } from '@stencil-hq/tern'
import {
  NativeTerminal, type TernInput, type TernSDK, type TernSession, type TernSurface,
} from '../src/native.ts'
import type { Snapshot } from '../src/model.ts'

interface Node {
  kind: string
  props: Record<string, unknown>
  children: unknown[]
  handlers?: Record<string, unknown>
}
function collect(value: unknown, kind: string): Node[] {
  if (value === null || typeof value !== 'object' || !('kind' in value)) return []
  const node = value as Node
  return [...(node.kind === kind ? [node] : []), ...node.children.flatMap(child => collect(child, kind))]
}
function fixture() {
  const frames: Array<{ main: unknown[]; dock: unknown[]; layer: unknown[] }> = []
  const opens: string[] = []
  let finish = () => {}
  let closed = false
  const idle = new Promise<void>(resolve => { finish = resolve })
  const sdk: TernSDK = {
    connect: async () => null,
    node,
  }
  const session: TernSession = {
    open(options): TernSurface {
      opens.push(options.id)
      return { closed: false, render: frame => { frames.push(frame) }, focus() {} }
    },
    async close() { closed = true; finish() },
    async *[Symbol.asyncIterator](): AsyncIterableIterator<TernInput> {
      await idle
    },
  }
  const terminal = new NativeTerminal(sdk, session)
  return { frames, opens, terminal, isClosed: () => closed }
}
const snapshot: Snapshot = {
  sessionId: 'test', status: 'idle', draft: '', cursor: 0, live: '', notice: '',
  entries: [{ id: 'event.1', kind: 'assistant', text: 'committed answer' }],
}

describe('native inline Tern UI public SDK', () => {
  it('renders one semantic surface and a native editor', async () => {
    const f = fixture()
    await f.terminal.start(() => {}, () => {}, () => {})
    f.terminal.update(snapshot)
    const latest = f.frames.at(-1)!
    expect(f.opens).toEqual(['dsh'])
    expect(latest.main.flatMap(node => collect(node, 'md'))[0]?.props.text).toBe('committed answer')
    const editors = latest.dock.flatMap(node => collect(node, 'editor'))
    expect(editors).toHaveLength(1)
    expect(editors[0]?.props).toMatchObject({ sendable: true, text: '' })
    await f.terminal.closed()
    expect(f.isClosed()).toBe(true)
  })

  it('accepts native edits and treats send as an atomic supplied value', async () => {
    const f = fixture()
    const submitted: string[] = []
    await f.terminal.start(text => submitted.push(text), () => {}, () => {})
    f.terminal.update(snapshot)
    const editor = f.frames.at(-1)!.dock.flatMap(node => collect(node, 'editor'))[0]!
    const onEdit = editor.handlers?.onEdit as (e: unknown) => void
    onEdit({ from: 0, to: 0, text: 'hello', cursor: 5, len: 0 })
    const current = f.frames.at(-1)!.dock.flatMap(node => collect(node, 'editor'))[0]!
    const onSend = current.handlers?.onSend as (e: { text: string }) => void
    onSend({ text: 'stale' })
    expect(submitted).toEqual(['stale'])
    onSend({ text: 'hello' })
    expect(submitted).toEqual(['stale', 'hello'])
    await f.terminal.closed()
  })

  it('keeps the unsent composer while a free-text modal is answered', async () => {
    const f = fixture()
    await f.terminal.start(() => {}, () => {}, () => {})
    f.terminal.update(snapshot)
    const editor = f.frames.at(-1)!.dock.flatMap(node => collect(node, 'editor'))[0]!
    const write = editor.props.onEdit as (e: unknown) => void
    write({ from: 0, to: 0, text: 'unsent draft', cursor: 12, len: 0 })
    const answer = f.terminal.ask({ title: 'Describe' })
    const input = f.frames.at(-1)!.layer.flatMap(node => collect(node, 'editor'))[0]!
    const onEdit = input.handlers?.onEdit as (e: unknown) => void
    onEdit({ from: 0, to: 0, text: 'response', cursor: 8, len: 0 })
    const current = f.frames.at(-1)!.layer.flatMap(node => collect(node, 'editor'))[0]!
    const onSend = current.props.onSend as (e: { text: string }) => void
    onSend({ text: 'response' })
    expect(await answer).toBe('response')
    const resumed = f.frames.at(-1)!.dock.flatMap(node => collect(node, 'editor'))[0]!
    expect(resumed.props.text).toBe('unsent draft')
    await f.terminal.closed()
  })
  it('buttons deliver modal choices without sending a normal prompt', async () => {
    const f = fixture()
    await f.terminal.start(() => { throw Error('wrong user submission') }, () => {}, () => {})
    f.terminal.update(snapshot)
    const answer = f.terminal.ask({ title: 'Authorize?', choices: [
      { label: 'Allow once', value: 'allowed-once' },
      { label: 'Deny', value: 'rejected' },
    ] })
    const buttons = f.frames.at(-1)!.layer.flatMap(node => collect(node, 'button'))
    expect(buttons).toHaveLength(2)
    const onClick = buttons[1]?.handlers?.onClick as () => void
    onClick()
    expect(await answer).toBe('rejected')
    expect(f.frames.at(-1)!.layer).toHaveLength(0)
    await f.terminal.closed()
  })
})
