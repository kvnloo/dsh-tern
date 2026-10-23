/**
 * Ordinary PTY fallback. Readline owns line editing; this renderer never
 * requires a Tern or cell-painter implementation. Input/answers share one
 * serialized prompt owner, so approval text is never submitted to the Agent.
 */
import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { abortableAnswer, type Ask, type Terminal } from './terminal.ts'
import { safeText, type Entry, type Snapshot } from './model.ts'

export interface AnsiStreams {
  readonly stdin: Readable & { isTTY?: boolean }
  readonly stdout: Writable & { isTTY?: boolean }
}

function lineOf(entry: Entry): string {
  const role = entry.kind === 'user' ? 'you'
    : entry.kind === 'assistant' ? 'dsh'
      : entry.kind === 'error' ? 'error'
        : entry.kind
  return '[' + role + '] ' + safeText(entry.text) + '\n'
}

export class AnsiTerminal implements Terminal {
  private input: Interface | undefined
  private onLine: ((text: string) => void) | undefined
  private onInterrupt: (() => void) | undefined
  private onQuit: (() => void) | undefined
  private shown = new Map<string, string>()
  private saved: { line: string; cursor: number } | undefined
  private pending: ((text: string | null) => void) | undefined
  private lastStatus: Snapshot['status'] = 'idle'
  private lastNotice = ''

  constructor(private readonly io: AnsiStreams = { stdin: process.stdin, stdout: process.stdout }) {}

  async start(submit: (text: string) => void, interrupt: () => void, quit: () => void): Promise<void> {
    if (this.input) throw new Error('ANSI terminal already started')
    this.onLine = submit
    this.onInterrupt = interrupt
    this.onQuit = quit
    const input = createInterface({
      input: this.io.stdin, output: this.io.stdout,
      terminal: Boolean(this.io.stdin.isTTY && this.io.stdout.isTTY),
      historySize: 200,
    })
    this.input = input
    this.io.stdout.write('dsh TUI (ANSI) · /help · /quit · /stop · /session\n')
    input.on('line', line => {
      if (this.pending) this.pending(line)
      else this.onLine?.(line)
      input.setPrompt(this.pending ? 'answer> ' : 'dsh> ')
      input.prompt()
    })
    input.on('SIGINT', () => {
      if (this.pending) this.pending(null)
      else this.onInterrupt?.()
      input.prompt()
    })
    input.on('close', () => {
      if (this.pending) this.pending(null)
      this.onQuit?.()
    })
    input.setPrompt('dsh> ')
    input.prompt()
  }

  update(snapshot: Snapshot): void {
    for (const entry of snapshot.entries) {
      const previous = this.shown.get(entry.id)
      const line = lineOf(entry)
      if (previous === line) continue
      this.shown.set(entry.id, line)
      this.io.stdout.write(line)
    }
    if (this.lastStatus !== snapshot.status) {
      this.lastStatus = snapshot.status
      this.io.stdout.write(snapshot.status === 'running' ? '[dsh] Working…\n' : '[dsh] Ready\n')
    }
    if (snapshot.notice && this.lastNotice !== snapshot.notice) {
      this.lastNotice = snapshot.notice
      this.io.stdout.write('[dsh] ' + safeText(snapshot.notice) + '\n')
    }
    this.input?.prompt(true)
  }

  ask(request: Ask): Promise<string | null> {
    const input = this.input
    if (!input || this.pending) return Promise.resolve(null)
    if (request.signal?.aborted) return Promise.resolve(null)
    // Readline keeps the unsent draft in `line` and `cursor`. Taking
    // ownership of an approval must move BOTH aside before another key arrives.
    this.saved = { line: input.line, cursor: input.cursor }
    input.line = ''
    input.cursor = 0
    this.io.stdout.write('\n' + safeText(request.title) + '\n')
    if (request.detail) this.io.stdout.write(safeText(request.detail) + '\n')
    request.choices?.forEach((item, i) =>
      this.io.stdout.write('  ' + (i + 1) + ') ' + safeText(item.label) + '\n'))
    if (request.multiple) this.io.stdout.write('Select numbers separated by commas.\n')
    input.setPrompt('answer> ')
    input.prompt()
    return abortableAnswer(request.signal, done => {
      this.pending = text => {
        if (text === null) return done(null)
        if (request.multiple) return done(text)
        const choice = request.choices?.find((v, i) =>
          v.value === text || String(i + 1) === text || v.label === text)
        done(request.choices && !choice ? null : choice?.value ?? text)
      }
      return () => {
        this.pending = undefined
        const saved = this.saved
        this.saved = undefined
        if (!this.input) return
        this.input.setPrompt('dsh> ')
        if (saved) {
          this.input.line = saved.line
          this.input.cursor = saved.cursor
        }
        this.input.prompt(true)
      }
    })
  }

  async closed(): Promise<void> {
    const input = this.input
    this.input = undefined
    this.pending?.(null)
    this.pending = undefined
    input?.removeAllListeners('close')
    input?.close()
  }
}
