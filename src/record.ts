/**
 * DSH-owned, opt-in, metadata-only TSP trace. Full wire payload capture is
 * deliberately separate: DSH_TSP_RECORD_FULL selects the SDK's JSONL recorder.
 */
import { appendFileSync } from 'node:fs'

export interface TspRecord {
  readonly direction: 'in' | 'out'
  readonly verb: string
  /** Serialized parser/render input length, not the encoded APC wire length. */
  readonly parsedBytes: number
  readonly surfaceId?: string
  readonly revision?: number
  readonly eventSeq?: number
  readonly caps?: {
    readonly kinds: readonly string[]
    readonly features: readonly string[]
    readonly credits?: number
    readonly apc?: number
  }
}

export class TspRecorder {
  private readonly initial = process.hrtime.bigint()
  private enabled: boolean
  constructor(
    private readonly path: string | undefined,
    private readonly sessionId: string,
  ) {
    this.enabled = Boolean(path)
  }

  write(record: TspRecord): void {
    if (!this.enabled || !this.path) return
    const line = {
      ms: Number(process.hrtime.bigint() - this.initial) / 1_000_000,
      sessionId: this.sessionId,
      ...record,
    }
    try {
      appendFileSync(this.path, JSON.stringify(line) + '\n', { flag: 'a', mode: 0o600 })
    } catch (error) {
      this.enabled = false
      process.stderr.write('dsh tui: metadata recorder disabled: ' + String(error) + '\n')
    }
  }
}
