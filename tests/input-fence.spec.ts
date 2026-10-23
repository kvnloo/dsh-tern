import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AnsiInputFence } from '../src/input-fence.ts'
import { AnsiTerminal } from '../src/ansi.ts'

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const utf8 = (value: string): Buffer => Buffer.from(value, 'utf8')

function fixture() {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(enabled: boolean) { this.isRaw = enabled },
  })
  const listeners = stdin.listenerCount('data')
  const fence = new AnsiInputFence(stdin)
  return { stdin, fence, listeners }
}

describe('SDK parser -> owned ANSI input, with no process stdin monkeypatch', () => {
  it('replays probe-time ordinary bytes once and fences an APC that crosses selection', async () => {
    const { stdin, fence, listeners } = fixture()
    const hello = JSON.stringify({ r: 'hello', v: 1, term: 'tern', ver: '0.1.0' })
    const packet = '\x1b_tsp;r;' + hello + '\x1b\\'
    const cut = 18
    const euro = utf8('é')
    const parts: Buffer[] = []
    try {
      stdin.write('A')
      stdin.write(euro.subarray(0, 1))
      stdin.write(packet.slice(0, cut))
      const filtered = fence.activate()
      filtered.on('data', (chunk: Buffer) => { parts.push(Buffer.from(chunk)) })
      stdin.write(packet.slice(cut))
      stdin.write(euro.subarray(1))
      stdin.write('B')
      stdin.write('\x1b_tsp;r;{"r":"hello","v":99}\x1b\\')
      stdin.write('\x1b_tsp;e;{broken-json}\x1b\\')
      stdin.write('\x1b_tsp;r;{"r":"hello","v":1,"term":"foreign"}\x1b\\')
      const osc = '\x1b]877;tsp;r;' + hello + '\x1b\\'
      stdin.write(osc.slice(0, 15))
      stdin.write(osc.slice(15))
      stdin.write('\x1b[?1;2c')
      stdin.write('\x1b[200~C\nD\x1b[201~')
      stdin.write(utf8('🌱'))
      await tick()
      expect(Buffer.concat(parts)).toEqual(utf8('AéB\x1b[200~C\nD\x1b[201~🌱'))
      expect(stdin.listenerCount('data')).toBe(listeners + 1)
      expect(stdin.destroyed).toBe(false)
    } finally {
      fence.close()
      expect(stdin.listenerCount('data')).toBe(listeners)
      expect(stdin.destroyed).toBe(false)
      stdin.destroy()
    }
  })

  it('holds a split TSP header itself across the probe-to-ANSI transition', async () => {
    const { stdin, fence } = fixture()
    const seen: Buffer[] = []
    try {
      stdin.write('P\x1b_')
      fence.activate().on('data', (chunk: Buffer) => seen.push(Buffer.from(chunk)))
      stdin.write('tsp;r;{"r":"hello","v":99}\x1b\\Q')
      await tick()
      expect(Buffer.concat(seen)).toEqual(utf8('PQ'))
    } finally {
      fence.close()
      stdin.destroy()
    }
  })

  it('retains a real lone Escape via the SDK public flush operation', async () => {
    const { stdin, fence } = fixture()
    const bytes: Buffer[] = []
    try {
      fence.activate().on('data', (chunk: Buffer) => bytes.push(Buffer.from(chunk)))
      stdin.write(utf8('\x1b'))
      await new Promise(resolve => setTimeout(resolve, 90))
      stdin.write('Z')
      await tick()
      expect(Buffer.concat(bytes)).toEqual(utf8('\x1bZ'))
    } finally {
      fence.close()
      stdin.destroy()
    }
  })

  it('does not alter native in-band input or close the real source on success', async () => {
    const { stdin, fence, listeners } = fixture()
    const received: Buffer[] = []
    const nativeListener = (chunk: Buffer): void => { received.push(Buffer.from(chunk)) }
    stdin.on('data', nativeListener)
    try {
      stdin.write('during-probe')
      fence.close()
      stdin.write('after-native')
      await tick()
      expect(Buffer.concat(received)).toEqual(utf8('during-probeafter-native'))
      expect(stdin.listenerCount('data')).toBe(listeners + 1)
      expect(stdin.destroyed).toBe(false)
    } finally {
      stdin.off('data', nativeListener)
      fence.close()
      stdin.destroy()
    }
  })

  it('lets real readline own and restore tty raw mode on the derived input', async () => {
    const { stdin, fence } = fixture()
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80 })
    const received: string[] = []
    let terminal: AnsiTerminal | undefined
    try {
      const filtered = fence.activate()
      expect(filtered.isRaw).toBe(false)
      terminal = new AnsiTerminal({ stdin: filtered, stdout })
      await terminal.start(text => received.push(text), () => {}, () => {})
      expect(stdin.isRaw).toBe(true)
      expect(filtered.isRaw).toBe(true)
      stdin.write('one\r')
      await tick()
      expect(received).toEqual(['one'])
      await terminal.closed()
      expect(stdin.isRaw).toBe(false)
      expect(filtered.isRaw).toBe(false)
      expect(stdin.destroyed).toBe(false)
    } finally {
      await terminal?.closed()
      fence.close()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('propagates source EOF without destroying the underlying input', async () => {
    const { stdin, fence } = fixture()
    const pieces: Buffer[] = []
    try {
      const ended = new Promise<void>(resolve => fence.activate().on('end', resolve)
        .on('data', (chunk: Buffer) => pieces.push(Buffer.from(chunk))))
      stdin.write('piped')
      stdin.end()
      await ended
      expect(Buffer.concat(pieces)).toEqual(utf8('piped'))
    } finally {
      fence.close()
      stdin.destroy()
    }
  })
})
