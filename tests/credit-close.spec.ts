/**
 * RFC #6: closing a surface is not an exemption from negotiated frame credits.
 * The public Tern 0.1.0 SDK used to flush a third frame without an ACK when
 * closing, even though a detached/hidden terminal cannot grant more credits.
 * This is a real Session/Surface wire witness, not a substitute DSH transport.
 */
import { describe, expect, it } from 'vitest'
import {
  connect, encodeMessage, node, type Session, type TermInput, type TermOutput,
} from '@stencil-hq/tern'
import { NativeTerminal } from '../src/native.ts'
import type { Snapshot } from '../src/model.ts'

class PtyInput implements TermInput {
  readonly isTTY = true
  isRaw = false
  private readonly listeners = new Set<(chunk: Uint8Array | string) => void>()
  on(_event: 'data', listener: (chunk: Uint8Array | string) => void): void {
    this.listeners.add(listener)
  }
  off(_event: 'data', listener: (chunk: Uint8Array | string) => void): void {
    this.listeners.delete(listener)
  }
  setRawMode(value: boolean): void { this.isRaw = value }
  resume(): void {}
  pause(): void {}
  send(event: object): void {
    const bytes = encodeMessage('e', JSON.stringify(event))
    for (const listener of this.listeners) listener(bytes)
  }
  hello(credits = 2): void {
    const bytes = encodeMessage('r', JSON.stringify({
      r: 'hello', v: 1, term: 'tern', ver: '0.9.5',
      kinds: ['text', 'col', 'row', 'md', 'card', 'editor', 'input', 'el'],
      features: ['edit', 'undo', 'send', 'settle'], credits, apc: 65536,
      cols: 80, cell: { w: 8, h: 16 }, dark: true, reduceMotion: false,
    }))
    for (const listener of this.listeners) listener(bytes)
  }
}

type Message = { verb: string; body: Record<string, unknown> }
class PtyOutput implements TermOutput {
  readonly isTTY = true
  readonly columns = 80
  private readonly writes: string[] = []
  write(bytes: Uint8Array | string): void {
    this.writes.push(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))
  }
  messages(): Message[] {
    const bytes = this.writes.join('')
    return Array.from(bytes.matchAll(/\x1b_tsp;([a-z]);([\s\S]*?)\x1b\\/g), m => ({
      verb: m[1]!, body: JSON.parse(m[2]!) as Record<string, unknown>,
    }))
  }
  frames(): Record<string, unknown>[] {
    return this.messages().filter(m => m.verb === 'f').map(m => m.body)
  }
}

async function connected(): Promise<{ input: PtyInput; output: PtyOutput; session: Session }> {
  const input = new PtyInput()
  const output = new PtyOutput()
  const pending = connect({ input, output, env: {}, timeout: 50, exitHooks: false })
  input.hello()
  const session = await pending
  expect(session).not.toBeNull()
  return { input, output, session: session! }
}

const view = (text: string) => ({
  main: [node('text', { key: 'answer', text })],
})

describe('real Tern SDK credit-safe close (RFC #6)', () => {
  it('closes once without a third frame or invented ACK when two credits are exhausted', async () => {
    const { input, output, session } = await connected()
    try {
      const surface = session.open({ id: 'dsh', mode: 'inline' })
      surface.render(view('sent one'))
      surface.render(view('sent two'))
      expect(output.frames().map(f => f['s'])).toEqual([1, 2])
      surface.render(view('unsent newest'))
      surface.send([['scroll', 'main.answer', 'end']])
      expect(surface.blocked).toBe(true)
      expect(output.frames()).toHaveLength(2)

      // Detached/hidden panes have no drawing window and may never ACK.
      input.send({ ev: 'visible', sf: 'dsh', visible: false })
      await surface.close()
      const sealed = output.messages().filter(m => m.verb === 'f' || m.verb === 'x')
      expect(sealed.map(m => m.verb)).toEqual(['f', 'f', 'x'])
      expect(sealed.at(-1)?.body).toEqual({ id: 'dsh', keep: true })
      expect(surface.closed).toBe(true)
      expect(output.frames().map(f => f['s'])).toEqual([1, 2])
      expect(JSON.stringify(output.frames())).not.toContain('unsent newest')
      expect(JSON.stringify(output.frames())).not.toContain('scroll')

      // A stale window's cumulative ACK must not resurrect pending work.
      input.send({ ev: 'ack', sf: 'dsh', s: 2 })
      input.send({ ev: 'ack', sf: 'dsh', s: 200 })
      surface.acknowledge(200)
      surface.render(view('resurrected'))
      surface.send([['focus', null]])
      await surface.close()
      await surface[Symbol.asyncDispose]()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(output.messages().filter(m => m.verb === 'f' || m.verb === 'x')).toEqual(sealed)

      // Adopt retains only the last SENT main tree, not unsent latest/pending.
      const adopted = session.open({ id: 'dsh', mode: 'inline', adopt: true })
      adopted.render(view('sent two'))
      expect(output.frames()).toHaveLength(2)
      adopted.render(view('post-adoption'))
      expect(output.frames().map(f => f['s'])).toEqual([1, 2, 3])
      await adopted.close()
      expect(output.messages().filter(m => m.verb === 'x')).toHaveLength(2)
    } finally {
      await session.close()
    }
    expect(input.isRaw).toBe(false)
  })

  it('honors a cumulative ACK as one released credit before normal close', async () => {
    const { input, output, session } = await connected()
    try {
      const surface = session.open({ id: 'dsh' })
      surface.render(view('one'))
      surface.render(view('two'))
      surface.render(view('skipped intermediate'))
      surface.render(view('coalesced three'))
      input.send({ ev: 'ack', sf: 'dsh', s: 1 })
      expect(output.frames().map(f => f['s'])).toEqual([1, 2, 3])
      expect(JSON.stringify(output.frames()[2]?.['ops'])).toContain('coalesced three')
      expect(JSON.stringify(output.frames()[2]?.['ops'])).not.toContain('skipped intermediate')
      surface.render(view('unsent four'))
      await session.close()
      expect(output.frames().map(f => f['s'])).toEqual([1, 2, 3])
      expect(output.messages().filter(m => m.verb === 'x')).toHaveLength(1)
    } finally { await session.close() }
  })

  it('closes with credit available, preserves the final sent view and is idempotent', async () => {
    const { input, output, session } = await connected()
    try {
      const surface = session.open({ id: 'dsh', mode: 'inline' })
      surface.render(view('final sent'))
      await surface.close()
      await surface.close()
      await surface[Symbol.asyncDispose]()
      expect(output.frames()).toHaveLength(1)
      expect(output.messages().filter(m => m.verb === 'x')).toHaveLength(1)
      expect(output.messages().filter(m => m.verb === 'f' || m.verb === 'x')
        .map(m => m.verb)).toEqual(['f', 'x'])
    } finally { await session.close() }
    expect(input.isRaw).toBe(false)
  })

  it('does not impose window credits on explicitly non-listening surfaces', async () => {
    const { output, session } = await connected()
    try {
      const surface = session.open({ id: 'one-shot', mode: 'flow', listen: false })
      surface.render(view('one'))
      surface.render(view('two'))
      surface.render(view('three'))
      expect(surface.blocked).toBe(false)
      await surface.close({ keep: false })
      expect(output.frames().map(f => f['s'])).toEqual([1, 2, 3])
      expect(output.messages().filter(m => m.verb === 'x').map(m => m.body))
        .toEqual([{ id: 'one-shot', keep: false }])
    } finally { await session.close() }
  })

  it('normal NativeTerminal teardown does not flush queued composer drafts over credit', async () => {
    const { input, output, session } = await connected()
    const renderer = new NativeTerminal({ node }, session)
    const initial: Snapshot = {
      sessionId: 'credit-close', status: 'idle', entries: [], live: '',
      notice: '', draft: '', cursor: 0,
    }
    try {
      await renderer.start(() => {}, () => {}, () => {})
      renderer.update(initial)
      renderer.restoreDraft('first draft')
      renderer.restoreDraft('second draft')
      renderer.restoreDraft('last unsent draft')
      expect(output.frames()).toHaveLength(2)
      await renderer.closed()
      expect(input.isRaw).toBe(false)
      expect(output.frames()).toHaveLength(2)
      expect(output.messages().filter(m => m.verb === 'x')).toHaveLength(1)
      expect(output.messages().filter(m => m.verb === 'f' || m.verb === 'x')
        .map(m => m.verb)).toEqual(['f', 'f', 'x'])
      expect(JSON.stringify(output.frames())).not.toContain('last unsent draft')
      await renderer.closed()
      expect(output.messages().filter(m => m.verb === 'x')).toHaveLength(1)
    } finally { await renderer.closed() }
  })
})
