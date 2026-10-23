/**
 * Real SDK input integration for the shipping NativeTerminal. Input enters
 * through TermInput data bytes -> InputParser -> KeyDecoder -> Session iterator.
 * Synthetic editor handlers are not substituted for ordinary typing.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  connect, encodeMessage, node, type TermInput, type TermOutput,
} from '@stencil-hq/tern'
import { NativeTerminal } from '../src/native.ts'
import type { Snapshot } from '../src/model.ts'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

class Input implements TermInput {
  readonly isTTY = true
  isRaw = false
  private readonly readers = new Set<(bytes: Uint8Array | string) => void>()
  on(_event: 'data', listener: (bytes: Uint8Array | string) => void): void { this.readers.add(listener) }
  off(_event: 'data', listener: (bytes: Uint8Array | string) => void): void { this.readers.delete(listener) }
  setRawMode(value: boolean): void { this.isRaw = value }
  resume(): void {}
  pause(): void {}
  push(value: Uint8Array): void { for (const reader of this.readers) reader(value) }
}

class Output implements TermOutput {
  readonly isTTY = true
  readonly columns = 92
  private chunks: Uint8Array[] = []
  write(value: Uint8Array | string): void {
    this.chunks.push(typeof value === 'string' ? bytes(value) : value.slice())
  }
  get text(): string { return new TextDecoder().decode(Buffer.concat(this.chunks)) }
  frames(): Array<Record<string, unknown>> {
    return Array.from(this.text.matchAll(/\x1b_tsp;f;([\s\S]*?)\x1b\\/g)).map(
      match => JSON.parse(match[1]!) as Record<string, unknown>)
  }
  /** Reconstruct the public editor text ops instead of inspecting packet substrings. */
  editorText(): string {
    let value = ''
    for (const frame of this.frames()) {
      if (!Array.isArray(frame['ops'])) continue
      for (const op of frame['ops']) {
        if (!Array.isArray(op) || op[1] !== 'dock.composer.line.input') continue
        if (op[0] === 'text' && typeof op[3] === 'string') {
          value = op[2] === 'append' ? value + op[3] : op[3]
        }
      }
    }
    return value
  }

  private findId(kind: 'answer' | 'choice'): string | undefined {
    const visit = (value: unknown): string | undefined => {
      if (value === null || typeof value !== 'object') return
      const candidate = value as Record<string, unknown>
      const id = candidate['id']
      const props = candidate['p'] as Record<string, unknown> | undefined
      const isAnswer = candidate['k'] === 'editor' || candidate['k'] === 'input'
      const isChoice = candidate['k'] === 'el' && props?.['tag'] === 'button'
      if (typeof id === 'string' && id.startsWith('layer.')
        && (kind === 'answer' ? isAnswer : isChoice)) return id
      const children = candidate['c']
      if (Array.isArray(children)) {
        for (const child of children) {
          const found = visit(child)
          if (found) return found
        }
      }
      return
    }
    const frames = this.frames()
    for (let index = frames.length - 1; index >= 0; index--) {
      const ops = frames[index]!['ops']
      if (!Array.isArray(ops)) continue
      for (let offset = ops.length - 1; offset >= 0; offset--) {
        const op = ops[offset]
        if (!Array.isArray(op) || op[0] !== 'add') continue
        const found = visit(op[4])
        if (found) return found
      }
    }
    return
  }
  answerId(): string | undefined { return this.findId('answer') }
  choiceId(): string | undefined { return this.findId('choice') }

}

const hello = {
  r: 'hello', v: 1, term: 'tern', ver: '0.1.0',
  kinds: ['col', 'row', 'text', 'card', 'md', 'editor', 'input', 'el', 'overlay', 'tool'],
  features: ['edit', 'send', 'undo', 'settle'], credits: 32, apc: 8192,
  cols: 92, cell: { w: 9, h: 18 }, dark: true, reduceMotion: false,
}
const snapshot: Snapshot = {
  sessionId: 'session-test', entries: [], status: 'idle',
  live: '', notice: '', draft: '', cursor: 0,
}

function frame(event: object): Uint8Array {
  return encodeMessage('e', JSON.stringify(event))
}

async function fixture(support: readonly string[] = hello.kinds) {
  const input = new Input()
  const output = new Output()
  const pending = connect({
    app: 'dsh', input, output, env: {}, timeout: 200,
    features: ['edit', 'undo', 'send'],
    exitHooks: false, record: '', bracketedPaste: true, kittyKeyboard: true,
  })
  input.push(encodeMessage('r', JSON.stringify({ ...hello, kinds: support })))
  const session = await pending
  expect(session).not.toBeNull()
  const submitted: string[] = []
  const failures: Error[] = []
  const terminal = new NativeTerminal({ node }, session!)
  await terminal.start(text => submitted.push(text), () => {}, error => {
    if (error) failures.push(error)
  })
  terminal.update(snapshot)
  return {
    input, output, session: session!, terminal, submitted, failures,
    push(text: string) { input.push(bytes(text)) },
    event(value: object) { input.push(frame(value)) },
    async close() { await terminal.closed() },
  }
}

describe('native TUI real 0.1.0 SDK / PTY / composer', () => {
  it('preserves a multi-character raw packet and an exact split 4-byte Unicode codepoint', async () => {
    const f = await fixture()
    try {
      f.push('aBc!')
      f.push('\x1b[D')
      f.push('\x1b[3~')
      f.input.push(Uint8Array.from([0xf0, 0x9f]))
      f.input.push(Uint8Array.from([0x98, 0x80]))
      f.push('\r')
      await vi.waitFor(() => expect(f.submitted).toEqual(['aBc😀']))
    } finally {
      await f.close()
    }
  })

  it('keeps one exact bracketed multiline paste until Enter sends it once', async () => {
    const f = await fixture()
    try {
      f.push('before')
      f.input.push(bytes('\x1b[200~line one\nline two\né😀\x1b[201~'))
      f.push('\r')
      await vi.waitFor(() => expect(f.submitted).toEqual(['beforeline one\nline two\né😀']))
    } finally {
      await f.close()
    }
  })

  it('uses the real SDK event dispatch for atomic send with an empty draft', async () => {
    const f = await fixture()
    try {
      f.event({
        ev: 'send', sf: 'dsh', id: 'dock.composer.line.input',
        text: 'a\nb😀',
      })
      await vi.waitFor(() => expect(f.submitted).toEqual(['a\nb😀']))
      expect(f.output.text).toContain('dock.composer.line.input')
    } finally {
      await f.close()
    }
  })

  it('routes approval choice ahead of typed draft and preserves that draft', async () => {
    const f = await fixture()
    try {
      f.push('unsent work')
      await vi.waitFor(() => expect(f.output.editorText()).toBe('unsent work'))
      const decision = f.terminal.ask({
        id: 'test.allow-once', title: 'Allow once?', choices: [
          { label: 'Allow once', value: 'allowed-once' },
          { label: 'Deny', value: 'rejected' },
        ],
      })
      f.push('2')
      expect(await decision).toBe('rejected')
      expect(f.submitted).toEqual([])
      f.push('\r')
      await vi.waitFor(() => expect(f.submitted).toEqual(['unsent work']))
    } finally {
      await f.close()
    }
  })

  it('uses supported local kinds when editor/card/markdown are not negotiated', async () => {
    const f = await fixture(['col', 'row', 'text', 'input'])
    try {
      f.terminal.update({
        ...snapshot,
        entries: [
          { id: 'user.1', kind: 'user', text: 'sample' },
          { id: 'tool.call-one', kind: 'tool', text: 'Running bash' },
        ],
      })
      const sent = JSON.stringify(f.output.frames())
      expect(sent).toContain('"k":"input"')
      expect(sent).not.toContain('"k":"editor"')
      expect(sent).not.toContain('"k":"card"')
      expect(sent).not.toContain('"k":"md"')
    } finally {
      await f.close()
    }
  })

  it('retains one settled tool identity and defers missing-surface recovery while hidden', async () => {
    const f = await fixture()
    try {
      f.terminal.update({
        ...snapshot, entries: [{ id: 'tool.one', kind: 'tool', text: 'Tool result: ok' }],
      })
      expect(f.output.text).toContain('tool.one')
      f.event({ ev: 'visible', sf: 'dsh', visible: false })
      f.event({ ev: 'gone', sf: 'dsh', ids: ['dsh'] })
      await vi.waitFor(() => expect(f.session.surfaces).toHaveLength(0))
      const opens = f.output.text.match(/\x1b_tsp;o;/g) ?? []
      expect(opens).toHaveLength(1)
      f.event({ ev: 'visible', sf: 'dsh', visible: true })
      await vi.waitFor(() => expect(f.output.text.match(/\x1b_tsp;o;/g)).toHaveLength(2))
      expect(f.output.text).toContain('dsh.recovery.1')
    } finally {
      await f.close()
    }
  })

  it('ends with a propagated protocol failure and restores raw mode', async () => {
    const f = await fixture()
    f.event({ ev: 'error', sf: 'dsh', msg: 'fault from Tern' })
    await vi.waitFor(() =>
      expect(f.failures.map(error => error.message)).toContain('Tern rejected a surface operation: fault from Tern'))
    await f.close()
    expect(f.input.isRaw).toBe(false)
    expect(f.output.text).toContain('\x1b[?2004l')
    expect(f.output.text).toContain('\x1b[<u')
  })

  it('emits real suspend/resume operations and monotonic frame numbers', async () => {
    const f = await fixture()
    try {
      const surface = f.session.surface('dsh')!
      surface.suspend()
      surface.resume()
      const frames = f.output.frames()
      expect(frames.flatMap(item => item['ops'] as unknown[] ?? []))
        .toEqual(expect.arrayContaining([['suspend'], ['resume']]))
      expect(frames.map(item => item['s'])).toEqual(frames.map((_, index) => index + 1))
    } finally {
      await f.close()
    }
  })

  it('ignores an old visible approval send after a replacement is rendered', async () => {
    const f = await fixture(['col', 'row', 'text', 'card', 'md', 'editor', 'input', 'overlay'])
    const controller = new AbortController()
    try {
      const old = f.terminal.ask({
        id: 'approval.same-logical-call', title: 'First approval', signal: controller.signal,
        choices: [{ label: 'Allow first', value: 'allowed-once' }],
      })
      const oldId = f.output.answerId()
      if (!oldId) throw new Error('First approval editor missing from emitted document')
      controller.abort()
      expect(await old).toBeNull()

      const fresh = f.terminal.ask({
        id: 'approval.same-logical-call', title: 'Replacement approval',
        choices: [{ label: 'Allow second', value: 'allowed-once' }],
      })
      const freshId = f.output.answerId()
      if (!freshId) throw new Error('Replacement approval editor missing from emitted document')
      expect(freshId).not.toBe(oldId)
      let answered = false
      void fresh.then(() => { answered = true })

      f.event({ ev: 'send', sf: 'dsh', id: oldId, text: 'allowed-once' })
      const drained = Promise.withResolvers<void>()
      setImmediate(drained.resolve)
      await drained.promise
      expect(answered).toBe(false)

      f.event({ ev: 'send', sf: 'dsh', id: freshId, text: 'allowed-once' })
      expect(await fresh).toBe('allowed-once')
    } finally {
      await f.close()
    }
  })

  it('rejects stale edit/undo/send/focus/ACTION on same-ID reopened safety; accepts the new action', async () => {
    const f = await fixture()
    const controller = new AbortController()
    try {
      f.push('unsent draft')
      await vi.waitFor(() => expect(f.output.editorText()).toBe('unsent draft'))
      const old = f.terminal.ask({
        id: 'approval.reopen-call', title: 'First attempt',
        signal: controller.signal,
        choices: [{ label: 'Reject first', value: 'rejected' }],
      })
      const oldEditor = f.output.answerId()
      const oldChoice = f.output.choiceId()
      if (!oldEditor || !oldChoice) throw new Error('Old semantic editor/action not rendered')
      controller.abort()
      expect(await old).toBeNull()

      const fresh = f.terminal.ask({
        id: 'approval.reopen-call', title: 'Replacement attempt',
        choices: [{ label: 'Reject second', value: 'rejected' }],
      })
      const freshEditor = f.output.answerId()
      const freshChoice = f.output.choiceId()
      if (!freshEditor || !freshChoice) throw new Error('New semantic editor/action not rendered')
      expect(freshEditor).not.toBe(oldEditor)
      expect(freshChoice).not.toBe(oldChoice)
      let answered = false
      void fresh.then(() => { answered = true })

      f.event({ ev: 'edit', sf: 'dsh', id: oldEditor, from: 0, to: 0, text: 'bad', cursor: 3, len: 0 })
      f.event({ ev: 'undo', sf: 'dsh', id: oldEditor })
      f.event({ ev: 'focus', sf: 'dsh', id: oldEditor })
      f.event({ ev: 'send', sf: 'dsh', id: oldEditor, text: 'allowed-once' })
      f.event({ ev: 'action', sf: 'dsh', id: oldChoice, act: 'click' })
      const drained = Promise.withResolvers<void>()
      setImmediate(drained.resolve)
      await drained.promise
      expect(answered).toBe(false)
      expect(f.submitted).toEqual([])

      // These are real encoded TSP events through the published SDK dispatcher.
      f.event({ ev: 'action', sf: 'dsh', id: freshChoice, act: 'click' })
      expect(await fresh).toBe('rejected')
      expect(f.submitted).toEqual([])
      expect(f.output.editorText()).toBe('unsent draft')
      f.push('\r')
      await vi.waitFor(() => expect(f.submitted).toEqual(['unsent draft']))
    } finally {
      await f.close()
    }
  })
})
