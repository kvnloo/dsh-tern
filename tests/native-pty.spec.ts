/**
 * Real SDK input integration for the shipping NativeTerminal. Input enters
 * through TermInput data bytes -> InputParser -> KeyDecoder -> Session iterator.
 * Synthetic editor handlers are not substituted for ordinary typing.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  connect, encodeMessage, node, type Session, type TermInput, type TermOutput,
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
}

const hello = {
  r: 'hello', v: 1, term: 'tern', ver: '0.1.0',
  kinds: ['col', 'row', 'text', 'card', 'md', 'editor', 'input', 'button'],
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
      await vi.waitFor(() => expect(f.output.text).toContain('unsent work'))
      const decision = f.terminal.ask({
        title: 'Allow once?', choices: [
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
})
