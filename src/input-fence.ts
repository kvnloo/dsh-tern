/**
 * Owns the bytes seen while Tern probes and after ANSI takes over.
 *
 * InputParser is the published SDK's streaming APC/OSC 877/DA1 splitter;
 * no local framing grammar, stdin mutation, or separate native key decoder.
 * Undecided bytes survive probe -> fallback. Only SDK 'keys' parts reach
 * a derived ANSI stream, never TSP replies/events.
 */
import { PassThrough, type Readable } from 'node:stream'
import { InputParser, type InputItem } from '@stencil-hq/tern'

type Stdin = Readable & {
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  setRawMode?(enabled: boolean): void
}

type AnsiStdin = PassThrough & {
  readonly isTTY: boolean
  readonly isRaw: boolean
  setRawMode(enabled: boolean): void
}

/** A passive tap during negotiation, with one owned fallback input stream. */
export class AnsiInputFence {
  private readonly parser = new InputParser()
  private readonly stream: AnsiStdin
  private queued: Buffer[] = []
  private active = false
  private ended = false
  private disposed = false
  private backpressured = false
  private lastByte: number | undefined
  private idle: ReturnType<typeof setTimeout> | undefined

  private readonly onData = (chunk: Uint8Array | string): void => {
    if (this.disposed || this.ended) return
    this.cancelIdle()
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    this.lastByte = bytes.at(-1)
    this.forward(this.parser.feed(bytes))
    this.scheduleIdle()
  }

  private readonly onEnd = (): void => {
    if (this.disposed || this.ended) return
    this.ended = true
    this.cancelIdle()
    // EOF cannot make an unfinished TSP header become user text.
    if (this.lastByte === 0x1b) this.forward(this.parser.flush())
    if (this.active) this.stream.end()
  }

  private readonly onDrain = (): void => {
    this.backpressured = false
    if (!this.disposed && this.active && !this.ended) this.source.resume()
  }

  constructor(private readonly source: Stdin = process.stdin) {
    // Readline's public terminal mode stays on the derived stream; only
    // readline changes the underlying tty raw mode once ANSI is selected.
    const stream = Object.assign(new PassThrough(), {
      isTTY: source.isTTY === true,
      setRawMode: (enabled: boolean): void => { source.setRawMode?.(enabled) },
    })
    // Readline saves its caller's previous raw mode from input.isRaw.
    Object.defineProperty(stream, 'isRaw', { get: () => source.isRaw === true })
    this.stream = stream as AnsiStdin
    this.stream.on('drain', this.onDrain)
    this.source.on('data', this.onData)
    this.source.once('end', this.onEnd)
  }

  private cancelIdle(): void {
    if (this.idle !== undefined) clearTimeout(this.idle)
    this.idle = undefined
  }

  private scheduleIdle(): void {
    // The public SDK exposes pending but not the held-prefix classification.
    // Only release an idle candidate ending in ESC. Flushing a split ESC_
    // or OSC prefix would otherwise expose a partial TSP frame to readline.
    if (!this.active || !this.parser.pending || this.disposed || this.ended
      || this.lastByte !== 0x1b) return
    this.idle = setTimeout(() => {
      this.idle = undefined
      if (this.disposed || this.ended) return
      this.forward(this.parser.flush())
    }, 30)
    this.idle.unref?.()
  }

  private forward(items: readonly InputItem[]): void {
    for (const item of items) {
      if (item.type !== 'keys' || item.bytes.length === 0) continue
      const bytes = Buffer.from(item.bytes)
      if (!this.active) {
        this.queued.push(bytes)
      } else if (!this.stream.write(bytes)) {
        this.backpressured = true
        this.source.pause()
      }
    }
  }

  /** Begin fallback; replay only SDK-classified key bytes exactly once and continue filtering late protocol frames.
   * @returns A derived ANSI input stream; the caller owns its readline lifecycle, not the original stdin.
   * @throws Error when an active or closed fence is activated again.
   */
  activate(): AnsiStdin {
    if (this.disposed || this.active) throw new Error('ANSI input fence is not available')
    this.active = true
    const buffered = this.queued
    this.queued = []
    for (const chunk of buffered) {
      if (!this.stream.write(chunk)) this.backpressured = true
    }
    if (this.ended) this.stream.end()
    else {
      if (this.backpressured) this.source.pause()
      else this.source.resume() // Failed SDK handshake pauses the real tty.
      this.scheduleIdle()
    }
    return this.stream
  }

  /**
   * Release active ANSI flow ownership after readline has restored raw mode.
   * A passive probe must never pause the SDK's original native input.
   */
  close(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelIdle()
    this.source.off('data', this.onData)
    this.source.off('end', this.onEnd)
    this.stream.off('drain', this.onDrain)
    this.queued = []
    this.stream.end()

    if (!this.active) return
    // Removing our data listener alone leaves a flowing TTY read handle alive.
    // Only stop it when no other data/readable consumer is still attached.
    const hasOtherReaders = this.source.listenerCount('data') > 0
      || this.source.listenerCount('readable') > 0
    if (!hasOtherReaders) this.source.pause()
    // Our backpressure may have paused another reader; relinquish that pause.
    else if (this.backpressured && !this.ended) this.source.resume()
  }
}
