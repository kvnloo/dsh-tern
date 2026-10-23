/**
 * RFC #6 transport witnesses using the shipped Tern SDK, not a DSH parser
 * imitation. The in-memory PTY is the remote terminal; the SDK is the SUT.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  connect, encodeMessage, InputParser, KeyDecoder, node, splitMessage,
  type Session, type TermInput, type TermOutput,
} from '@stencil-hq/tern'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const asText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

class PtyInput implements TermInput {
  readonly isTTY = true
  isRaw = false
  private readonly listeners = new Set<(chunk: Uint8Array | string) => void>()
  on(_event: 'data', listener: (chunk: Uint8Array | string) => void): void { this.listeners.add(listener) }
  off(_event: 'data', listener: (chunk: Uint8Array | string) => void): void { this.listeners.delete(listener) }
  setRawMode(enabled: boolean): void { this.isRaw = enabled }
  resume(): void {}
  pause(): void {}
  send(bytes: Uint8Array | string): void {
    for (const listener of this.listeners) listener(bytes)
  }
}

class PtyOutput implements TermOutput {
  readonly isTTY = true
  readonly columns = 100
  private readonly chunks: Uint8Array[] = []
  write(chunk: Uint8Array | string): void {
    this.chunks.push(typeof chunk === 'string' ? utf8(chunk) : chunk.slice())
  }
  get text(): string { return this.chunks.map(asText).join('') }
}

const hello = {
  r: 'hello', v: 1, term: 'tern', ver: '0.1.0',
  kinds: ['text', 'col', 'row', 'card', 'md', 'editor', 'input', 'button'],
  features: ['edit', 'send', 'undo', 'settle'],
  credits: 1, apc: 4096, cols: 100, cell: { w: 8, h: 16 },
  dark: true, reduceMotion: false,
}

function inbound(verb: 'r' | 'e', body: object): Uint8Array {
  return encodeMessage(verb, JSON.stringify(body))
}

function outbound(out: PtyOutput, verb: string): Array<Record<string, unknown>> {
  const messages = Array.from(out.text.matchAll(/\x1b_tsp;([^;]+);([\s\S]*?)\x1b\\/g))
  return messages.filter(match => match[1] === verb).map(match =>
    JSON.parse(match[2] ?? '{}') as Record<string, unknown>)
}

async function negotiate(
  response: Uint8Array | null = inbound('r', hello),
  options: { firstDa1?: boolean; timeout?: number; env?: Readonly<Record<string, string>> } = {},
): Promise<{ input: PtyInput; output: PtyOutput; session: Session | null }> {
  const input = new PtyInput()
  const output = new PtyOutput()
  const attempt = connect({
    input, output, env: options.env ?? {}, timeout: options.timeout ?? 35,
    exitHooks: false, bracketedPaste: true, kittyKeyboard: true,
  })
  if (options.firstDa1) input.send('\x1b[?1;2c')
  if (response) input.send(response)
  return { input, output, session: await attempt }
}

describe('Tern 0.1.0 PTY handshake and parser compatibility', () => {
  it('requires a valid hello before DA1 and restores raw mode for DA1-first or timeout', async () => {
    const accepted = await negotiate()
    expect(accepted.session).not.toBeNull()
    expect(accepted.input.isRaw).toBe(true)
    expect(accepted.output.text).toContain('\x1b[c')
    await accepted.session!.close()
    expect(accepted.input.isRaw).toBe(false)
    expect(accepted.output.text).toContain('\x1b[?2004l')
    expect(accepted.output.text).toContain('\x1b[<u')

    const early = await negotiate(inbound('r', hello), { firstDa1: true })
    expect(early.session).toBeNull()
    expect(early.input.isRaw).toBe(false)

    const none = await negotiate(null, { timeout: 5 })
    expect(none.session).toBeNull()
    expect(none.input.isRaw).toBe(false)
  })

  it('rejects unsupported protocol version rather than activating a native surface', async () => {
    const trial = await negotiate(inbound('r', { ...hello, v: 99 }))
    try {
      expect(trial.session).toBeNull()
      expect(trial.input.isRaw).toBe(false)
    } finally {
      await trial.session?.close()
    }
  })

  it('detects TSP opt-out and unsupported multiplexer before any probe', async () => {
    for (const env of [{ TERN_TSP: '0' }, { STY: 'screen.1234' }, { ZELLIJ: '1' }]) {
      const result = await negotiate(undefined, { env })
      expect(result.session).toBeNull()
      expect(result.output.text).toBe('')
      expect(result.input.isRaw).toBe(false)
    }
  })

  it('routes APC and OSC 877 events before key decoding, even across splits', () => {
    const parser = new InputParser()
    const decoder = new KeyDecoder()
    const actual: string[] = []
    const events: string[] = []
    const frames = [
      inbound('e', { ev: 'theme', dark: false }),
      utf8('\x1b]877;tsp;e;' + JSON.stringify({ ev: 'motion', reduce: true }) + '\x1b\\'),
      inbound('e', { ev: 'visible', sf: 'dsh', visible: false }),
    ]
    const all = Buffer.concat([
      utf8('ab'), frames[0]!, utf8('ç'), frames[1]!, utf8('x'),
      frames[2]!, utf8('z'),
    ])
    for (let at = 0; at < all.length;) {
      const width = 1 + (at % 7)
      for (const part of parser.feed(all.subarray(at, at + width))) {
        if (part.type === 'event') events.push(part.event.ev)
        if (part.type === 'keys') {
          actual.push(...decoder.feed(part.bytes).flatMap(key => key.text ? [key.text] : []))
        }
      }
      at += width
    }
    expect(events).toEqual(['theme', 'motion', 'visible'])
    expect(actual.join('')).toBe('abçxz')
  })

  it('never delivers split malformed or foreign TSP frames as composer keys', () => {
    const parser = new InputParser()
    const keys = new KeyDecoder()
    const actual: string[] = []
    const invalid = [
      '\x1b_tsp;e;{"ev":"send","id":"dock.composer.line.input","text":"injected"}\x1b\\',
      '\x1b_tsp;e;{invalid-json}\x1b\\',
      '\x1b_tsp;r;[]\x1b\\',
      '\x1b_foreign;pass=not-a-key\x1b\\',
      '\x1b]877;tsp;e;{"ev":42}\x1b\\',
    ]
    const data = utf8('a' + invalid.join('') + 'b')
    for (let i = 0; i < data.length; i += 3) {
      for (const item of parser.feed(data.subarray(i, i + 3))) {
        if (item.type === 'keys') {
          actual.push(...keys.feed(item.bytes).flatMap(key => key.text ? [key.text] : []))
        }
      }
    }
    expect(actual.join('')).toBe('ab')
  })

  it('preserves typed Unicode and input ordering across reproducible stream fragmentation', () => {
    const message = utf8('aé👨‍👩‍👧z')
    const event = inbound('e', { ev: 'resize', sf: 'dsh', cols: 61, visible: true })
    const source = Buffer.concat([message.subarray(0, 3), event, message.subarray(3)])
    for (let seed = 1; seed <= 80; seed++) {
      const parser = new InputParser()
      const decoder = new KeyDecoder()
      const typed: string[] = []
      const events: string[] = []
      let at = 0
      let state = seed
      while (at < source.length) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        const width = 1 + (state % 13)
        for (const item of parser.feed(source.subarray(at, at + width))) {
          if (item.type === 'event') events.push(item.event.ev)
          if (item.type === 'keys') {
            typed.push(...decoder.feed(item.bytes).flatMap(key => key.text ? [key.text] : []))
          }
        }
        at += width
      }
      typed.push(...decoder.flush().flatMap(key => key.text ? [key.text] : []))
      expect(events, 'seed=' + seed).toEqual(['resize'])
      expect(typed.join(''), 'seed=' + seed).toBe('aé👨‍👩‍👧z')
    }
  })

  it('enforces encoded UTF-8 APC chunks and reassembles a message without trimming data', () => {
    const text = '😀éf'.repeat(100)
    const frame = encodeMessage('f', JSON.stringify({ text }), { limit: 49, chunk: () => 'limit-case' })
    const packets = Array.from(asText(frame).matchAll(/\x1b_tsp;f;([\s\S]*?)\x1b\\/g))
    expect(packets.length).toBeGreaterThan(1)
    const parts = packets.map(packet => splitMessage(utf8('f;' + packet[1]!)))
    expect(parts.every(part => part !== null)).toBe(true)
    expect(parts.every(part => (part?.body.length ?? Infinity) <= 49)).toBe(true)
    const merged = Buffer.concat(parts.map(part => part!.body))
    expect(JSON.parse(asText(merged))).toEqual({ text })
    expect(parts[0]?.params).toContainEqual(['c', 'limit-case'])
    expect(parts.at(-1)?.params).not.toContainEqual(['m', '1'])
  })
})

describe('real Tern session credit and control events', () => {
  it('coalesces multiple renders under one credit and advances frame/ACK sequences', async () => {
    const { input, output, session } = await negotiate()
    expect(session).not.toBeNull()
    try {
      const surface = session!.open({ id: 'dsh', mode: 'inline' })
      const draw = (text: string): void => {
        surface.render({ main: [node('text', { key: 'one', text })] })
      }
      draw('first')
      expect(outbound(output, 'f')).toHaveLength(1)
      draw('second')
      draw('third')
      expect(surface.blocked).toBe(true)
      expect(outbound(output, 'f')).toHaveLength(1)
      input.send(inbound('e', { ev: 'ack', sf: 'dsh', s: 1 }))
      await vi.waitFor(() => expect(outbound(output, 'f')).toHaveLength(2))
      const frames = outbound(output, 'f')
      expect(frames.map(frame => frame['s'])).toEqual([1, 2])
      expect(JSON.stringify(frames[1]?.['ops'])).toContain('third')
      expect(JSON.stringify(frames[1]?.['ops'])).not.toContain('second')
      input.send(inbound('e', { ev: 'ack', sf: 'dsh', s: 1 }))
      await Promise.resolve()
      expect(outbound(output, 'f')).toHaveLength(2)
      input.send(inbound('e', { ev: 'ack', sf: 'dsh', s: 2 }))
      await vi.waitFor(() => expect(surface.blocked).toBe(false))
    } finally {
      await session?.close()
    }
  })

  it('propagates visibility, resized cells, appearance, motion and Tern errors', async () => {
    const { input, session } = await negotiate()
    expect(session).not.toBeNull()
    try {
      const events = [
        { ev: 'visible', sf: 'dsh', visible: false },
        { ev: 'resize', sf: 'dsh', cols: 72, cell: { w: 9, h: 18 }, visible: true },
        { ev: 'theme', dark: false },
        { ev: 'motion', reduce: true },
        { ev: 'error', sf: 'dsh', msg: 'invalid operation' },
      ]
      for (const event of events) input.send(inbound('e', event))
      for (const event of events) {
        const received = await session!.next()
        expect(received?.type).toBe('event')
        if (received?.type === 'event') expect(received.event.ev).toBe(event.ev)
      }
      expect(session!.caps.cols).toBe(72)
      expect(session!.caps.cell).toEqual({ w: 9, h: 18 })
      expect(session!.caps.dark).toBe(false)
      expect(session!.caps.reduceMotion).toBe(true)
    } finally {
      await session?.close()
    }
  })
})
