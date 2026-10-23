/**
 * Durable DSH Session events are the only source of transcript history.
 * Uncommitted assistant deltas are a separate, replaceable presentation hint.
 */
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'

export type EntryKind = 'user' | 'assistant' | 'tool' | 'error' | 'notice'
/** Provenance from public tool/call, tool/result, and turn/end events. */
export type ToolStatus = 'running' | 'done' | 'error' | 'cancelled'
export interface ToolFacts {
  readonly name: string
  readonly status: ToolStatus
}
export interface Entry {
  readonly id: string
  readonly kind: EntryKind
  readonly text: string
  /** Present only when a public tool/call establishes the tool identity. */
  readonly tool?: ToolFacts
}

/** Current public-service facts, never synthetic progress or model history. */
export interface ProductState {
  readonly model?: { readonly provider: string; readonly model: string }
  readonly plan?: { readonly active: boolean; readonly pending?: boolean }
  readonly tasks?: readonly { readonly id: string; readonly text: string; readonly status: string }[]
  readonly jobs?: readonly {
    readonly id: string; readonly label: string; readonly status: string
    readonly progress?: string; readonly detail?: string
  }[]
  readonly children?: readonly {
    readonly id: string; readonly parentId: string; readonly depth: number
    readonly label: string; readonly mode: string; readonly activity: string
  }[]
  readonly detail?: { readonly id: string; readonly title: string; readonly text: string }
}

export interface Snapshot {
  readonly sessionId: string
  readonly product?: ProductState
  readonly entries: readonly Entry[]
  readonly live: string
  readonly liveId?: string
  readonly latestSeq?: number
  readonly status: 'idle' | 'running'
  readonly draft: string
  readonly cursor: number
  readonly notice: string
}

const MAX_ENTRIES = 240
const MAX_TEXT = 64 * 1024

/** Remove terminal controls from untrusted tool/model text without dropping newlines. */
export function safeText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').slice(0, MAX_TEXT)
}

/** Message content includes non-text blocks; show text without leaking binary payloads. */
export function textContent(content: readonly unknown[]): string {
  return safeText(content.map(block => {
    if (block === null || typeof block !== 'object') return ''
    const value = block as { type?: unknown; text?: unknown }
    return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
  }).join(''))
}

/** One session's current durable projection. Only ordinary snapshots are windowed. */
export class Transcript {
  readonly sessionId: string
  private lastSequence = -1
  private readonly seen = new Set<number>()
  private readonly rowSequence = new Map<string, number>()
  private readonly runningTools = new Map<string, { turn: number; name: string }>()
  private rows: Entry[] = []
  private attempt: string | undefined
  private previewId: string | undefined
  private preview = ''
  private currentStatus: 'idle' | 'running' = 'idle'
  private currentDraft = ''
  private currentCursor = 0
  private currentNotice = ''

  constructor(sessionId: string) { this.sessionId = sessionId }

  replay(session: Session): void {
    const length = session.seq
    for (let seq = 0; seq < length; seq++) {
      // Existing Session history read; the store is the durable authority.
      // oxlint-disable-next-line typescript/no-deprecated -- Durable Session replay API pending projection migration.
      const event = session.eventAt(SessionSeq(seq))
      if (!event) throw new Error('TUI transcript missing Session event ' + seq)
      this.accept(event)
    }
  }

  private upsert(entry: Entry, seq: number): void {
    const at = this.rows.findIndex(row => row.id === entry.id)
    if (at < 0) this.rows.push(entry)
    else this.rows[at] = entry
    this.rowSequence.set(entry.id, seq)
    // Only an acknowledged renderer eviction can release presentation caches.
    // Never discard durable identities merely because the viewport is long.

  }

  accept(event: SessionEvent): Entry | undefined {
    if (this.seen.has(event.seq)) return
    this.seen.add(event.seq)
    this.lastSequence = event.seq
    if (event.surfaceOp && typeof event.surfaceOp !== 'string') {
      const { startSeq, endSeq } = event.surfaceOp
      this.rows = this.rows.filter(row => {
        const seq = this.rowSequence.get(row.id)
        if (seq === undefined || seq < startSeq || seq > endSeq) return true
        this.rowSequence.delete(row.id)
        this.runningTools.delete(row.id)
        return false
      })
    }
    const id = 'event.' + event.seq
    let entry: Entry | undefined
    switch (event.type) {
      case 'user/message':
        entry = { id, kind: 'user', text: textContent(event.data.content) }
        break
      case 'assistant/message': {
        const blocks = event.data.message.content
        // The assistant's durable call-only event is retained in Session, but
        // has no assistant text to display beside its canonical tool row.
        // Keep whitespace, reasoning/other blocks, and interrupted partials.
        const callOnly = !event.data.interrupted
          && blocks.some(block => block.type === 'tool-call')
          && blocks.every(block => block.type === 'tool-call'
            || (block.type === 'text' && block.text === ''))
        if (!callOnly) {
          entry = {
            id: 'assistant.' + event.data.turn + '.' + event.data.step,
            kind: 'assistant',
            // Cancellation can durably commit a partial answer; only display text is annotated.
            text: (event.data.interrupted ? 'Interrupted response\n' : '')
              + textContent(blocks),
          }
        }
        this.preview = ''
        this.previewId = undefined
        this.attempt = undefined
        break
      }
      case 'tool/call': {
        const toolId = 'tool.' + event.data.callId
        const name = safeText(event.data.name)
        entry = { id: toolId, kind: 'tool', text: 'Running ' + name,
          tool: { name, status: 'running' } }
        this.runningTools.set(toolId, { turn: event.data.turn, name })
        break
      }
      case 'tool/result': {
        const toolId = 'tool.' + event.data.message.toolCallId
        const name = this.runningTools.get(toolId)?.name
          ?? this.rows.find(row => row.id === toolId)?.tool?.name
        entry = {
          id: toolId,
          kind: event.data.message.isError ? 'error' : 'tool',
          text: 'Tool result: ' + textContent(event.data.message.content),
          ...(name === undefined ? {} : {
            tool: { name, status: event.data.message.isError ? 'error' : 'done' },
          }),
        }
        this.runningTools.delete(toolId)
        break
      }
      case 'turn/start':
        this.currentStatus = 'running'
        break
      case 'turn/end':
        this.currentStatus = 'idle'
        this.attempt = undefined
        this.preview = ''
        this.previewId = undefined
        for (const [toolId, tool] of this.runningTools) {
          if (tool.turn !== event.data.turn) continue
          this.runningTools.delete(toolId)
          const status: ToolStatus = ['aborted', 'interrupted', 'forked'].includes(event.data.reason.kind)
            ? 'cancelled' : 'error'
          this.upsert({ id: toolId, kind: 'error', text: 'Interrupted ' + tool.name,
            tool: { name: tool.name, status } }, event.seq)
        }
        if (event.data.reason.kind === 'error') {
          entry = { id, kind: 'error', text: safeText(event.data.reason.error.message) }
        }
        break
      default:
        break
    }
    if (entry) this.upsert(entry, event.seq)
    return entry
  }

  /** Revisions and attempt ids fence superseded live attempts. */
  stream(frame: AssistantStreamFrame): void {
    if (frame.type === 'start') {
      this.attempt = frame.attemptId
      this.preview = ''
      this.previewId = 'assistant.' + frame.turn + '.' + frame.step
    } else if (frame.type === 'chunk' && frame.attemptId === this.attempt) {
      if (frame.chunk.type === 'text-delta') {
        this.preview = safeText(this.preview + frame.chunk.text)
      }
    } else if (frame.type === 'end' && frame.attemptId === this.attempt) {
      this.attempt = undefined
      this.preview = ''
      this.previewId = undefined
    }
  }

  status(value: 'idle' | 'running'): void { this.currentStatus = value }
  notice(message: string): void { this.currentNotice = safeText(message) }
  draft(text: string, cursor = text.length): void {
    this.currentDraft = text
    this.currentCursor = cursor
  }
  /**
   * Ordinary snapshots cap screen work; the interactive renderer requests the
   * complete durable projection so history is never silently erased.
   */
  snapshot(options: { all?: boolean; product?: ProductState } = {}): Snapshot {
    return {
      sessionId: this.sessionId,
      ...(options.product === undefined ? {} : { product: options.product }),
      entries: options.all ? [...this.rows] : this.rows.slice(-MAX_ENTRIES),
      live: this.preview,
      ...(this.previewId ? { liveId: this.previewId } : {}),
      ...(this.lastSequence >= 0 ? { latestSeq: this.lastSequence } : {}),
      status: this.currentStatus,
      draft: this.currentDraft,
      cursor: this.currentCursor,
      notice: this.currentNotice,
    }
  }
}
