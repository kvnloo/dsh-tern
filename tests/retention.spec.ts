/**
 * RFC #6 terminal-state oracle: genuine @stencil-hq/tern Session/Surface wire,
 * strict TSP node lifetime, and ACK only after a frame has been applied.
 */
import { describe, expect, it, vi } from 'vitest'
import { connect, encodeMessage, node, splitMessage, type TermInput, type TermOutput } from '@stencil-hq/tern'
import { NativeTerminal } from '../src/native.ts'
import type { Entry, Snapshot } from '../src/model.ts'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const string = (value: Uint8Array): string => new TextDecoder().decode(value)
const reply = (value: object): Uint8Array => encodeMessage('e', JSON.stringify(value))
const hello = {
  r: 'hello', v: 1, term: 'tern', ver: '0.1.0',
  kinds: ['card', 'col', 'row', 'md', 'text', 'editor', 'input', 'el'],
  features: ['settle', 'edit', 'send'], credits: 1, apc: 65536, cols: 80,
  cell: { w: 8, h: 16 }, dark: true, reduceMotion: false,
}
const snapshot = (entries: Entry[]): Snapshot => ({
  sessionId: 'durable', status: 'idle', entries, live: '', notice: '', draft: '', cursor: 0,
})

class Input implements TermInput {
  readonly isTTY = true
  isRaw = false
  private listeners = new Set<(chunk: Uint8Array | string) => void>()
  on(_event: 'data', listener: (chunk: Uint8Array | string) => void): void { this.listeners.add(listener) }
  off(_event: 'data', listener: (chunk: Uint8Array | string) => void): void { this.listeners.delete(listener) }
  setRawMode(mode: boolean): void { this.isRaw = mode }
  resume(): void {}
  pause(): void {}
  send(data: string | Uint8Array): void { for (const listener of this.listeners) listener(data) }
}

type WireNode = { id: string; k: string; p?: Record<string, unknown>; c?: WireNode[] }
type Frame = { sf: string; s: number; ops: unknown[][] }

/** A terminal that rejects every reference to an evicted or never-created id. */
class Oracle {
  readonly nodes = new Map<string, WireNode>()
  readonly children = new Map<string, string[]>()
  readonly settled = new Set<string>()
  readonly evicted = new Set<string>()
  readonly frames: Frame[] = []
  readonly opens: string[] = []
  private check(id: string): void {
    if (!this.nodes.has(id)) throw new Error('operation on unknown/gone TSP id: ' + id)
  }
  private insert(parent: string, before: string | null, wire: WireNode): void {
    if (this.nodes.has(wire.id) || this.evicted.has(wire.id))
      throw new Error('duplicate/recreated gone TSP id: ' + wire.id)
    if (parent !== 'dsh') this.check(parent)
    if (before !== null) this.check(before)
    const siblings = this.children.get(parent) ?? []
    const at = before === null ? siblings.length : siblings.indexOf(before)
    if (at < 0) throw new Error('unknown next sibling: ' + before)
    siblings.splice(at, 0, wire.id)
    this.children.set(parent, siblings)
    this.nodes.set(wire.id, { ...wire, p: { ...wire.p } })
    for (const child of wire.c ?? []) this.insert(wire.id, null, child)
  }
  private remove(id: string, retainGone: boolean): void {
    this.check(id)
    for (const child of [...(this.children.get(id) ?? [])]) this.remove(child, retainGone)
    for (const siblings of this.children.values()) {
      const at = siblings.indexOf(id)
      if (at >= 0) siblings.splice(at, 1)
    }
    this.children.delete(id)
    this.nodes.delete(id)
    this.settled.delete(id)
    if (retainGone) this.evicted.add(id)
  }
  evict(id: string): void {
    if (!this.settled.has(id)) throw new Error('eviction requires settled top-level child: ' + id)
    this.remove(id, true)
  }
  apply(frame: Frame): void {
    if (frame.sf !== 'dsh') throw new Error('unexpected recovery surface')
    if (this.frames.length && frame.s !== this.frames.at(-1)!.s + 1)
      throw new Error('invalid frame sequence')
    for (const op of frame.ops) {
      const tag = op[0]
      const id = op[1] as string
      if (tag === 'add') this.insert(op[2] as string, op[3] as string | null, op[4] as WireNode)
      else if (tag === 'del') this.remove(id, false)
      else if (tag === 'settle') { this.check(id); this.settled.add(id) }
      else if (tag === 'text') {
        this.check(id)
        const item = this.nodes.get(id)!
        const value = op[3] as string
        const old = item.p?.['text']
        item.p!['text'] = op[2] === 'append' ? String(old ?? '') + value : value
      } else if (tag === 'set') {
        this.check(id)
        Object.assign(this.nodes.get(id)!.p!, op[2])
      } else if (tag === 'focus' || tag === 'reveal' || tag === 'scroll') {
        if (id !== null) this.check(id)
      } else if (tag === 'move') {
        this.check(id)
        this.check(op[2] as string)
        if (op[3] !== null) this.check(op[3] as string)
        for (const siblings of this.children.values()) {
          const at = siblings.indexOf(id)
          if (at >= 0) siblings.splice(at, 1)
        }
        const siblings = this.children.get(op[2] as string) ?? []
        const at = op[3] === null ? siblings.length : siblings.indexOf(op[3] as string)
        if (at < 0) throw new Error('unknown move sibling')
        siblings.splice(at, 0, id)
        this.children.set(op[2] as string, siblings)
      } else if (tag !== 'suspend' && tag !== 'resume') throw new Error('unsupported oracle op: ' + tag)
    }
    this.frames.push(frame)
  }
  text(id: string): string { this.check(id); return String(this.nodes.get(id)?.p?.['text'] ?? '') }
}

class Output implements TermOutput {
  readonly isTTY = true
  readonly columns = 80
  readonly chunks = new Map<string, Uint8Array[]>()
  readonly packetBytes: number[] = []
  readonly reassembledBytes: number[] = []
  constructor(readonly input: Input, readonly oracle: Oracle) {}
  write(data: string | Uint8Array): void {
    const wire = typeof data === 'string' ? data : string(data)
    for (const match of wire.matchAll(/\x1b_tsp;([\s\S]*?)\x1b\\/g)) {
      const part = splitMessage(bytes(match[1]!))
      if (!part) throw new Error('invalid SDK wire message')
      this.packetBytes.push(part.body.byteLength)
      if (part.body.byteLength > hello.apc) throw new Error('negotiated APC limit exceeded')
      const params = new Map(part.params)
      const token = params.get('c')
      if (token) {
        const parts = this.chunks.get(token) ?? []
        parts.push(part.body)
        if (params.get('m') === '1') { this.chunks.set(token, parts); continue }
        this.chunks.delete(token)
        this.handle(part.verb, Buffer.concat(parts))
      } else this.handle(part.verb, part.body)
    }
  }
  private handle(verb: string, body: Uint8Array): void {
    if (verb !== 'f' && verb !== 'o') return
    if (body.byteLength > 24 * 1024 * 1024) {
      throw new Error('TSP reassembled-message ceiling exceeded')
    }
    if (verb === 'f') this.reassembledBytes.push(body.byteLength)
    const json = JSON.parse(string(body)) as Record<string, unknown>
    if (verb === 'o') { this.oracle.opens.push(json['id'] as string); return }
    const frame = json as Frame
    this.oracle.apply(frame)
    // An ACK represents a strictly validated, applied and drawn terminal frame.
    queueMicrotask(() => this.input.send(reply({ ev: 'ack', sf: frame.sf, s: frame.s })))
  }
}

async function connected() {
  const input = new Input()
  const oracle = new Oracle()
  const output = new Output(input, oracle)
  const attempt = connect({ input, output, env: {}, exitHooks: false, timeout: 100 })
  input.send(encodeMessage('r', JSON.stringify(hello)))
  const session = await attempt
  if (!session) throw new Error('expected actual SDK session')
  const terminal = new NativeTerminal({ node }, session)
  await terminal.start(() => {}, () => {}, error => { if (error) throw error })
  return { input, oracle, terminal, output }
}

describe('RFC #6 real-SDK settled history retention', () => {
  it('forgets a settled/gone child from the SDK sent View without removing other durable entries', async () => {
    const { input, oracle, terminal } = await connected()
    const first: Entry = { id: 'one', kind: 'user', text: 'durable first' }
    const second: Entry = { id: 'two', kind: 'assistant', text: 'durable second' }
    try {
      terminal.update(snapshot([first, second]))
      await vi.waitFor(() => expect(oracle.settled.has('main.one') && oracle.settled.has('main.two')).toBe(true))
      oracle.evict('main.one')
      input.send(reply({ ev: 'gone', sf: 'dsh', ids: ['main.one'] }))
      await new Promise(resolve => setImmediate(resolve))
      expect(oracle.evicted.has('main.one')).toBe(true)
      terminal.update(snapshot([first, { ...second, text: 'updated second' }]))
      await vi.waitFor(() => expect(oracle.text('main.two.body')).toBe('updated second'))
      expect(oracle.opens).toEqual(['dsh'])
      expect(oracle.nodes.has('main.one')).toBe(false)
      expect(oracle.children.get('main')).toEqual(['main.two'])
    } finally { await terminal.closed() }
  })

  it('keeps durable siblings while hidden, then resumes after child gone without reopening', async () => {
    const { input, oracle, terminal } = await connected()
    const first: Entry = { id: 'hidden.first', kind: 'user', text: 'retained first' }
    const second: Entry = { id: 'hidden.second', kind: 'assistant', text: 'retained second' }
    try {
      terminal.update(snapshot([first, second]))
      await vi.waitFor(() => expect(oracle.settled.has('main.hidden.first')).toBe(true))
      input.send(reply({ ev: 'visible', sf: 'dsh', visible: false }))
      await new Promise(resolve => setImmediate(resolve))
      oracle.evict('main.hidden.first')
      input.send(reply({ ev: 'gone', sf: 'dsh', ids: ['main.hidden.first'] }))
      await new Promise(resolve => setImmediate(resolve))
      const whenHidden = oracle.frames.length
      terminal.update(snapshot([first, { ...second, text: 'visible again' }]))
      expect(oracle.frames).toHaveLength(whenHidden)
      input.send(reply({ ev: 'visible', sf: 'dsh', visible: true }))
      await vi.waitFor(() => expect(oracle.text('main.hidden.second.body')).toBe('visible again'))
      expect(oracle.opens).toEqual(['dsh'])
      expect(oracle.nodes.has('main.hidden.first')).toBe(false)
    } finally { await terminal.closed() }
  })

  it('replays more than 24 MiB of intact durable history in ACK-bounded frames, in order', async () => {
    const { oracle, terminal, output } = await connected()
    const entries: Entry[] = Array.from({ length: 1080 }, (_, i) => ({
      id: 'event.' + i.toString().padStart(4, '0'), kind: i % 2 ? 'assistant' : 'user',
      text: '[' + i + ']' + '🚀 payload '.repeat(2000),
    }))
    expect(Buffer.byteLength(entries.map(e => e.text).join(''), 'utf8')).toBeGreaterThan(24 * 1024 * 1024)
    try {
      terminal.update(snapshot(entries))
      await vi.waitFor(() => {
        expect(oracle.children.get('main')).toHaveLength(entries.length)
      }, { timeout: 120_000, interval: 20 })
      expect(oracle.opens).toEqual(['dsh'])
      expect(oracle.frames.length).toBeGreaterThan(10)
      expect(output.packetBytes.every(size => size <= hello.apc)).toBe(true)
      expect(output.reassembledBytes.every(size => size <= 24 * 1024 * 1024)).toBe(true)
      expect(oracle.children.get('main')).toEqual(entries.map(e => 'main.' + e.id))
      for (const entry of entries) expect(oracle.text('main.' + entry.id + '.body')).toBe(entry.text)
    } finally { await terminal.closed() }
  }, 130_000)
})
