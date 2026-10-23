/**
 * Opt-in TSP wire evidence from the SDK's public ConnectOptions input/output
 * streams. Raw content is inspected transiently for envelope metadata only;
 * no prompt, model text, tool result, or raw body reaches the JSONL file.
 */
import { appendFileSync } from 'node:fs'
import { splitMessage } from '@stencil-hq/tern'

export interface TspRecord {
  readonly direction: 'in' | 'out'
  readonly verb: string
  /** Actual UTF-8 message body size; for chunked messages, this chunk's bytes. */
  readonly payloadBytes?: number
  /** Actual wire bytes, including APC/OSC framing and chunk headers. */
  readonly wireBytes?: number
  /** Legacy diagnostic callers only. Never use for wire evidence. */
  readonly parsedBytes?: number
  readonly surfaceId?: string
  readonly frameSeq?: number
  readonly ack?: number
  readonly chunkId?: string
  readonly revision?: number
  readonly eventSeq?: number
  readonly caps?: {
    readonly kinds: readonly string[]
    readonly features: readonly string[]
    readonly credits?: number
    readonly apc?: number
  }
}

type Direction = TspRecord['direction']
type Caps = NonNullable<TspRecord['caps']>
interface PendingChunk { readonly parts: Uint8Array[]; size: number }

const MAX_WIRE_BUFFER = 32 * 1024 * 1024
const MAX_RECONSTRUCTED_JSON = 2 * 1024 * 1024
const APC = Uint8Array.of(27, 95, 116, 115, 112, 59)
const OSC = Uint8Array.of(27, 93, 56, 55, 55, 59, 116, 115, 112, 59)
const ST = Uint8Array.of(27, 92)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesOf(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? encoder.encode(chunk) : chunk
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function at(bytes: Uint8Array, needle: Uint8Array, start: number): number {
  for (let i = start; i + needle.length <= bytes.length; i++) {
    if (needle.every((value, j) => bytes[i + j] === value)) return i
  }
  return -1
}

function startOf(bytes: Uint8Array): { pos: number; head: Uint8Array } | undefined {
  const apc = at(bytes, APC, 0)
  const osc = at(bytes, OSC, 0)
  if (apc < 0 && osc < 0) return
  return osc < 0 || (apc >= 0 && apc <= osc)
    ? { pos: apc, head: APC }
    : { pos: osc, head: OSC }
}

function envelope(value: Uint8Array): {
  readonly surfaceId?: string
  readonly frameSeq?: number
  readonly ack?: number
  readonly event?: string
} {
  try {
    const json: unknown = JSON.parse(decoder.decode(value))
    if (!json || typeof json !== 'object' || Array.isArray(json)) return {}
    const record = json as Record<string, unknown>
    return {
      ...(typeof record.sf === 'string' ? { surfaceId: record.sf } : {}),
      ...(typeof record.s === 'number' && Number.isSafeInteger(record.s) ? { frameSeq: record.s } : {}),
      ...(record.ev === 'ack' && typeof record.s === 'number' && Number.isSafeInteger(record.s)
        ? { ack: record.s } : {}),
      ...(typeof record.ev === 'string' ? { event: record.ev } : {}),
    }
  } catch {
    // An incomplete or unknown JSON body is not an input-protocol failure.
    return {}
  }
}

/** A wire-only observer. This never routes terminal input or changes SDK framing. */
export class TspRecorder {
  private readonly initial = process.hrtime.bigint()
  private enabled: boolean
  private readonly pending: Record<Direction, Uint8Array> = {
    in: new Uint8Array(), out: new Uint8Array(),
  }
  private readonly chunks: Record<Direction, Map<string, PendingChunk>> = {
    in: new Map(), out: new Map(),
  }
  private context: { revision?: number; eventSeq?: number } = {}
  private capabilities: (() => Caps | undefined) | undefined

  constructor(private readonly path: string | undefined, private sessionId: string) {
    this.enabled = Boolean(path)
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId
  }

  setContext(context: { revision?: number; eventSeq?: number }): void {
    this.context = context
  }

  setCapabilities(get: () => Caps | undefined): void {
    this.capabilities = get
  }

  /** Inspect TSP frames carried by actual SDK stream reads and writes. */
  capture(direction: Direction, chunk: string | Uint8Array): void {
    if (!this.enabled || !this.path) return
    let buffer = join(this.pending[direction], bytesOf(chunk))
    // Allow marker split across read boundaries, without retaining ordinary key text.
    for (;;) {
      const start = startOf(buffer)
      if (!start) {
        this.pending[direction] = buffer.slice(Math.max(0, buffer.length - OSC.length + 1))
        return
      }
      if (start.pos > 0) buffer = buffer.subarray(start.pos)
      const innerStart = start.head.length
      const end = at(buffer, ST, innerStart)
      const bell = start.head === OSC ? buffer.indexOf(7, innerStart) : -1
      const finish = bell >= 0 && (end < 0 || bell < end) ? bell : end
      if (finish < 0) {
        this.pending[direction] = buffer.length <= MAX_WIRE_BUFFER ? buffer.slice() : new Uint8Array()
        return
      }
      const wireBytes = finish + (finish === bell ? 1 : ST.length)
      const split = splitMessage(buffer.subarray(innerStart, finish))
      if (split) {
        const params = new Map(split.params)
        const chunkId = params.get('c')
        const more = params.get('m') === '1'
        let decoded = split.body
        if (chunkId) {
          const current = this.chunks[direction].get(chunkId) ?? { parts: [], size: 0 }
          current.size += decoded.length
          if (current.size <= MAX_RECONSTRUCTED_JSON) current.parts.push(decoded.slice())
          else current.parts.length = 0
          if (more) this.chunks[direction].set(chunkId, current)
          else {
            this.chunks[direction].delete(chunkId)
            if (current.parts.length) {
              decoded = current.parts.reduce((sum, part) => join(sum, part), new Uint8Array())
            }
          }
        }
        const parsed = !more && decoded.length <= MAX_RECONSTRUCTED_JSON ? envelope(decoded) : {}
        const caps = this.capabilities?.()
        this.write({
          direction,
          verb: parsed.event ? split.verb + '/' + parsed.event : split.verb,
          payloadBytes: split.body.byteLength,
          wireBytes,
          ...(parsed.surfaceId ? { surfaceId: parsed.surfaceId } : {}),
          ...(parsed.frameSeq === undefined ? {} : { frameSeq: parsed.frameSeq }),
          ...(parsed.ack === undefined ? {} : { ack: parsed.ack }),
          ...(chunkId ? { chunkId } : {}),
          ...this.context,
          ...(caps === undefined ? {} : { caps }),
        })
      }
      buffer = buffer.subarray(wireBytes)
    }
  }

  /** Metadata-only output; refuses to serialize payload bodies by construction. */
  write(record: TspRecord): void {
    if (!this.enabled || !this.path) return
    const line = {
      ms: Number(process.hrtime.bigint() - this.initial) / 1_000_000,
      sessionId: this.sessionId,
      direction: record.direction, verb: record.verb,
      ...(record.payloadBytes === undefined ? {} : { payloadBytes: record.payloadBytes }),
      ...(record.wireBytes === undefined ? {} : { wireBytes: record.wireBytes }),
      ...(record.parsedBytes === undefined ? {} : { parsedBytes: record.parsedBytes }),
      ...(record.surfaceId === undefined ? {} : { surfaceId: record.surfaceId }),
      ...(record.frameSeq === undefined ? {} : { frameSeq: record.frameSeq }),
      ...(record.ack === undefined ? {} : { ack: record.ack }),
      ...(record.chunkId === undefined ? {} : { chunkId: record.chunkId }),
      ...(record.revision === undefined ? {} : { revision: record.revision }),
      ...(record.eventSeq === undefined ? {} : { eventSeq: record.eventSeq }),
      ...(record.caps === undefined ? {} : { caps: record.caps }),
    }
    try {
      appendFileSync(this.path, JSON.stringify(line) + '\n', { flag: 'a', mode: 0o600 })
    } catch (error) {
      this.enabled = false
      process.stderr.write('dsh tui: metadata recorder disabled: ' + String(error) + '\n')
    }
  }
}
