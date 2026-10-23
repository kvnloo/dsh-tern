/**
 * Durable DSH Session events are the only source of transcript history.
 * Uncommitted assistant deltas are a separate, replaceable presentation hint.
 */
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'

export type EntryKind = 'user' | 'assistant' | 'tool' | 'error' | 'notice'
export interface Entry {
  readonly id: string
  readonly kind: EntryKind
  readonly text: string
}

export interface Snapshot {
  readonly sessionId: string
  readonly entries: readonly Entry[]
  readonly live: string
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

/** One session's bounded on-screen projection. The underlying Session retains all history. */
export class Transcript {
  readonly sessionId: string
  private readonly seen = new Set<number>()
  private rows: Entry[] = []
  private attempt: string | undefined
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

  accept(event: SessionEvent): Entry | undefined {
    if (this.seen.has(event.seq)) return
    this.seen.add(event.seq)
    // Session compaction/rewrite replaces the current visible surface range;
    // replaying obsolete nodes as new history would show false duplicates.
    if (event.surfaceOp && typeof event.surfaceOp !== 'string') {
      const { startSeq, endSeq } = event.surfaceOp
      this.rows = this.rows.filter(row => {
        const seq = Number(row.id.slice('event.'.length))
        return !(seq >= startSeq && seq <= endSeq)
      })
    }
    const id = 'event.' + event.seq
    let entry: Entry | undefined
    switch (event.type) {
      case 'user/message':
        entry = { id, kind: 'user', text: textContent(event.data.content) }
        break
      case 'assistant/message':
        entry = { id, kind: 'assistant', text: textContent(event.data.message.content) }
        this.preview = ''
        this.attempt = undefined
        break
      case 'tool/call':
        entry = { id, kind: 'tool', text: 'Running ' + safeText(event.data.name) }
        break
      case 'tool/result':
        entry = {
          id, kind: event.data.message.isError ? 'error' : 'tool',
          text: 'Tool result: ' + textContent(event.data.message.content),
        }
        break
      case 'turn/start':
        this.currentStatus = 'running'
        break
      case 'turn/end':
        this.currentStatus = 'idle'
        this.attempt = undefined
        this.preview = ''
        if (event.data.reason.kind === 'error') {
          entry = { id, kind: 'error', text: safeText(event.data.reason.error.message) }
        }
        break
      default:
        break
    }
    if (entry) {
      this.rows.push(entry)
      if (this.rows.length > MAX_ENTRIES) this.rows.splice(0, this.rows.length - MAX_ENTRIES)
    }
    return entry
  }

  /** Revisions and attempt ids fence superseded live attempts. */
  stream(frame: AssistantStreamFrame): void {
    if (frame.type === 'start') {
      this.attempt = frame.attemptId
      this.preview = ''
    } else if (frame.type === 'chunk' && frame.attemptId === this.attempt) {
      if (frame.chunk.type === 'text-delta') {
        this.preview = safeText(this.preview + frame.chunk.text)
      }
    } else if (frame.type === 'end' && frame.attemptId === this.attempt) {
      this.attempt = undefined
      this.preview = ''
    }
  }

  status(value: 'idle' | 'running'): void { this.currentStatus = value }
  notice(message: string): void { this.currentNotice = safeText(message) }
  draft(text: string, cursor = text.length): void {
    this.currentDraft = text
    this.currentCursor = cursor
  }
  snapshot(): Snapshot {
    return {
      sessionId: this.sessionId,
      entries: [...this.rows],
      live: this.preview,
      status: this.currentStatus,
      draft: this.currentDraft,
      cursor: this.currentCursor,
      notice: this.currentNotice,
    }
  }
}
