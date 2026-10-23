/**
 * Ordinary PTY fallback. Readline owns line editing; this renderer never
 * requires a Tern or cell-painter implementation. Input/answers share one
 * serialized prompt owner, so approval text is never submitted to the Agent.
 */
import { createInterface, type Interface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
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
  private started = false
  private readonly decoder = new StringDecoder('utf8')
  private answerDecoder: StringDecoder | undefined
  private pipeDraft = ''
  private pipeSawCR = false
  private pipeReader: ((chunk: Uint8Array | string) => void) | undefined
  private pipeEnd: (() => void) | undefined
  private pending: ((text: string | null) => void) | undefined
  private lastStatus: Snapshot['status'] = 'idle'
  private lastNotice = ''
  private lastSession = ''
  private readonly shownFacts = new Map<string, string>()

  constructor(private readonly io: AnsiStreams = { stdin: process.stdin, stdout: process.stdout }) {}

  /** Each TTY prompt gets a new public readline parser, not an inherited buffer. */
  private openInput(prompt: string, restore?: { line: string; cursor: number }): void {
    const previous = this.input
    if (previous) {
      previous.removeAllListeners('line')
      previous.removeAllListeners('SIGINT')
      previous.removeAllListeners('close')
      previous.close()
    }
    const input = createInterface({
      input: this.io.stdin, output: this.io.stdout,
      terminal: true, historySize: 200,
    })
    this.input = input
    input.on('line', line => {
      if (this.pending) this.pending(line)
      else this.onLine?.(line)
      if (this.input === input) {
        input.setPrompt('dsh> ')
        input.prompt()
      }
    })
    input.on('SIGINT', () => {
      if (this.pending) this.pending(null)
      else this.onInterrupt?.()
      if (this.input === input) input.prompt()
    })
    input.on('close', () => {
      if (this.input !== input) return
      this.pending?.(null)
      this.onQuit?.()
    })
    input.setPrompt(prompt)
    input.prompt()
    if (!restore) return
    // Readline exposes a UTF-16 cursor. Left is not a grapheme step for ZWJ.
    // Insert the suffix, move Home, then the prefix at its original caret.
    input.write(restore.line.slice(restore.cursor))
    input.write(null, { ctrl: true, name: 'a' })
    input.write(restore.line.slice(0, restore.cursor))
  }

  /** Piped input owns incomplete UTF-8 lines independently of readline. */
  private pipe(chunk: Uint8Array | string): void {
    const decoder = this.pending ? this.answerDecoder ?? this.decoder : this.decoder
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    for (const char of text) {
      if (char === '\n' && this.pipeSawCR) {
        this.pipeSawCR = false
        continue
      }
      this.pipeSawCR = false
      if (char === '\n' || char === '\r') {
        const line = this.pipeDraft
        this.pipeDraft = ''
        this.pipeSawCR = char === '\r'
        if (this.pending) this.pending(line)
        else this.onLine?.(line)
      } else this.pipeDraft += char
    }
  }

  async start(submit: (text: string) => void, interrupt: () => void, quit: () => void): Promise<void> {
    if (this.started) throw new Error('ANSI terminal already started')
    this.started = true
    this.onLine = submit
    this.onInterrupt = interrupt
    this.onQuit = quit
    this.io.stdout.write('dsh TUI (ANSI) · /help · /quit · /stop · /session\n')
    if (this.io.stdin.isTTY && this.io.stdout.isTTY) {
      this.openInput('dsh> ')
      return
    }
    const reader = (chunk: Uint8Array | string): void => { this.pipe(chunk) }
    const end = (): void => {
      this.pending?.(null)
      this.onQuit?.()
    }
    this.pipeReader = reader
    this.pipeEnd = end
    this.io.stdin.on('data', reader)
    this.io.stdin.once('end', end)
    this.io.stdin.resume()
    this.io.stdout.write('dsh> ')
  }

  update(snapshot: Snapshot): void {
    if (this.lastSession !== snapshot.sessionId) {
      this.lastSession = snapshot.sessionId
      this.shown.clear()
      this.shownFacts.clear()
      this.lastNotice = ''
      this.lastStatus = 'idle'
    }
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
    const facts: Array<[string, string]> = []
    const product = snapshot.product
    if (product?.model) facts.push(['model', 'Model: ' + product.model.provider + '/' + product.model.model])
    if (product?.plan) facts.push(['plan', 'Plan: ' + (product.plan.active ? 'active' : 'inactive')
      + (product.plan.pending === undefined ? '' : ' · pending ' + product.plan.pending)])
    for (const task of product?.tasks ?? []) {
      facts.push(['task.' + task.id, 'Task [' + task.status + '] ' + task.id + ': ' + task.text])
    }
    for (const job of product?.jobs ?? []) {
      facts.push(['job.' + job.id, 'Job ' + job.id + ' [' + job.status + '] ' + job.label
        + (job.progress ? ' · ' + job.progress : '') + (job.detail ? ' · ' + job.detail : '')])
    }
    for (const child of product?.children ?? []) {
      facts.push(['child.' + child.id, 'Child ' + child.id + ' [' + child.activity + '] '
        + child.mode + ' · ' + child.label])
    }
    if (product?.detail) {
      facts.push(['detail.' + product.detail.id, product.detail.title + '\n' + product.detail.text])
    }
    for (const [id, text] of facts) {
      const line = '[dsh] ' + safeText(text) + '\n'
      if (this.shownFacts.get(id) === line) continue
      this.shownFacts.set(id, line)
      this.io.stdout.write(line)
    }
    const present = new Set(facts.map(([id]) => id))
    for (const id of this.shownFacts.keys()) {
      if (!present.has(id)) this.shownFacts.delete(id)
    }
    this.input?.prompt(true)
  }

  restoreDraft(text: string): void {
    if (!this.started || this.pending) return
    if (this.input) this.openInput('dsh> ', { line: text, cursor: text.length })
    else this.pipeDraft = text
  }

  ask(request: Ask): Promise<string | null> {
    if (!this.started || this.pending) return Promise.resolve(null)
    if (request.signal?.aborted) return Promise.resolve(null)
    this.saved = this.input
      ? { line: this.input.line, cursor: this.input.cursor }
      : { line: this.pipeDraft, cursor: this.pipeDraft.length }
    if (!this.input) {
      this.pipeDraft = ''
      this.answerDecoder = new StringDecoder('utf8')
    }
    this.io.stdout.write('\n' + safeText(request.title) + '\n')
    if (request.detail) this.io.stdout.write(safeText(request.detail) + '\n')
    request.choices?.forEach((item, i) =>
      this.io.stdout.write('  ' + (i + 1) + ') ' + safeText(item.label) + '\n'))
    if (request.multiple) this.io.stdout.write('Select numbers separated by commas.\n')
    if (this.input) this.openInput('answer> ')
    else this.io.stdout.write('answer> ')
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
        this.answerDecoder = undefined
        const saved = this.saved
        this.saved = undefined
        if (!this.started) return
        if (this.input) this.openInput('dsh> ', saved)
        else {
          if (saved) this.pipeDraft = saved.line + this.pipeDraft
          this.io.stdout.write('dsh> ')
        }
      }
    })
  }

  async closed(): Promise<void> {
    const input = this.input
    this.input = undefined
    this.pending?.(null)
    this.pending = undefined
    input?.removeAllListeners('line')
    input?.removeAllListeners('SIGINT')
    input?.removeAllListeners('close')
    input?.close()
    if (this.pipeReader) this.io.stdin.off('data', this.pipeReader)
    if (this.pipeEnd) this.io.stdin.off('end', this.pipeEnd)
    this.pipeReader = undefined
    this.pipeEnd = undefined
    this.pipeDraft = ''
    this.answerDecoder = undefined
    this.saved = undefined
    this.started = false
  }
}
