/**
 * Public @stencil-hq/tern 0.1.0 handles TSP framing, hello/DA1, input decoding,
 * credits, chunking and terminal restoration. Plain typing stays on the PTY.
 */
import { connect, node, type Key, type Node, type OpenOptions, type SessionInput } from '@stencil-hq/tern'
import { abortableAnswer, type Ask, type Terminal } from './terminal.ts'
import { Draft, type NativeEdit } from './draft.ts'
import { safeText, type Entry, type Snapshot } from './model.ts'
import { TspRecorder } from './record.ts'

export interface TernSurface {
  readonly closed: boolean
  render(view: { main: Node[]; dock: Node[]; layer: Node[] }): void
  focus(id: string | null): void
  settle?(id: string): void
}
export type TernInput = SessionInput
export interface TernSession extends AsyncIterable<SessionInput> {
  open(options: OpenOptions): TernSurface
  close(): Promise<void>
  readonly caps?: { readonly kinds: readonly string[]; readonly features: readonly string[]; readonly credits?: number; readonly apc?: number }
}
export interface TernSDK {
  readonly node: typeof node
  readonly connect?: typeof connect
}

/** Import the published SDK as an ordinary shipped dependency, not a cast peer. */
export async function connectTern(): Promise<{ sdk: TernSDK; session: TernSession } | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null
  const session = await connect({ app: 'dsh', features: ['edit', 'undo', 'send'], version: '0.2.1',
    record: process.env.DSH_TSP_RECORD_FULL ?? '', exitHooks: false })
  return session ? { sdk: { node }, session } : null
}

const EDITOR = 'dock.composer.line.input'
const ANSWER = 'layer.question.answer'

export class NativeTerminal implements Terminal {
  private surface: TernSurface
  private epoch = 0
  private draft = new Draft()
  private answerDraft = new Draft()
  private submit: (text: string) => void = () => {}
  private interrupt: () => void = () => {}
  private quit: () => void = () => {}
  private last: Snapshot | undefined
  private prompt: { request: Ask; answer: (text: string | null) => void } | undefined
  private running: Promise<void> | undefined
  private stopped = false
  private readonly gone = new Set<string>()
  private readonly settled = new Set<string>()
  private revision = 0
  private recorder: TspRecorder | undefined

  constructor(private readonly sdk: TernSDK, private readonly session: TernSession) {
    this.surface = this.openSurface()
  }

  private surfaceId(): string {
    return this.epoch ? 'dsh.recovery.' + this.epoch : 'dsh'
  }

  private openSurface(): TernSurface {
    return this.session.open({
      id: this.surfaceId(), mode: 'inline', role: 'dsh.session', title: 'DeepSeek Harness',
    })
  }

  async start(submit: (text: string) => void, interrupt: () => void, quit: () => void): Promise<void> {
    if (this.running) throw new Error('Native terminal already started')
    this.submit = submit
    this.interrupt = interrupt
    this.quit = quit
    this.running = (async () => {
      try {
        for await (const input of this.session) {
          if (this.stopped) break
          this.recorder?.write({
            direction: 'in', verb: input.type === 'key' ? 'key' : input.event.ev,
            parsedBytes: JSON.stringify(input).length, surfaceId: this.surfaceId(),
            revision: this.revision,
          })
          if (input.type === 'key') this.key(input.key)
          else if (input.event.ev === 'gone') {
            if (input.event.ids.includes(this.surfaceId())) {
              this.epoch += 1
              if (this.epoch > 3) throw new Error('Tern surface recovery limit reached')
              this.gone.clear()
              this.settled.clear()
              this.surface = this.openSurface()
              this.render()
            } else {
              for (const id of input.event.ids) {
                if (this.settled.has(id)) {
                  this.gone.add(id)
                  this.settled.delete(id)
                }
              }
            }
          } else if (input.event.ev === 'resize' || input.event.ev === 'theme'
            || input.event.ev === 'motion' || (input.event.ev === 'visible' && input.event.visible)) {
            // The SDK already updates negotiated caps; rebuild from shared state.
            this.render()
          } else if (input.event.ev === 'error'
            && (!input.event.sf || input.event.sf === this.surfaceId())) {
            throw new Error('Tern rejected a surface operation: ' + input.event.msg)
          }
        }
      } catch (error) {
        if (!this.stopped) process.stderr.write('dsh Tern: ' + String(error) + '\n')
      } finally {
        if (!this.stopped) this.quit()
      }
    })()
  }

  private key(key: Key): void {
    if (key.ctrl && key.name === 'c') {
      if (this.prompt) this.prompt.answer(null)
      else this.interrupt()
      return
    }
    if (key.ctrl && key.name === 'd') {
      if (this.prompt) this.prompt.answer(null)
      else this.quit()
      return
    }
    if (this.prompt) {
      if (key.name === 'escape') { this.prompt.answer(null); return }
      if (this.prompt.request.choices?.length && !this.prompt.request.multiple
        && /^[1-9]$/.test(key.name) && !key.alt && !key.ctrl && !key.meta) {
        const option = this.prompt.request.choices[Number(key.name) - 1]
        if (option) { this.prompt.answer(option.value); return }
      }
      if (key.name === 'enter' && !key.shift && !key.alt) {
        const answer = this.answerDraft.take()
        if (answer.trim()) this.prompt.answer(answer)
        this.render()
        return
      }
      if (this.answerDraft.key(key)) this.render()
      return
    }
    if (key.name === 'enter' && !key.shift && !key.alt) {
      this.sendDraft()
      return
    }
    if (this.draft.key(key)) this.render()
  }

  private n(kind: string, props: Record<string, unknown>, children: Node[] | string[] = []): Node {
    return this.sdk.node(kind, props, children)
  }

  private supported(kind: string, fallback: string): string {
    const kinds = this.session.caps?.kinds
    return kinds && !kinds.includes(kind) ? fallback : kind
  }

  private renderEntry(entry: Entry): Node {
    const body = this.n('text', { key: 'body', text: entry.text, wrap: 'word' })
    if (entry.kind === 'tool' || entry.kind === 'error') {
      return this.n(this.supported('card', 'col'), {
        key: entry.id, role: 'dsh.tool', tone: entry.kind === 'error' ? 'error' : 'muted',
      }, [body])
    }
    const markdown = this.supported('md', 'text')
    return this.n(this.supported('card', 'col'), {
      key: entry.id, role: entry.kind === 'user' ? 'omp.user' : 'omp.assistant',
    }, [this.n(markdown, { key: 'body' }, [entry.text || ' '])])
  }

  private sendDraft(): void {
    const text = this.draft.take()
    if (text.trim()) this.submit(text)
    this.render()
  }

  /** A native send is an atomic submit, including injected text not in the editor. */
  private send(text: string): void {
    if (!text.trim()) return
    if (text === this.draft.text) this.draft.take()
    this.submit(text)
    this.render()
  }

  private render(): void {
    const snapshot = this.last
    if (!snapshot || this.stopped || this.surface.closed) return
    const main = snapshot.entries.filter(e => !this.gone.has('main.' + e.id))
      .map(e => this.renderEntry(e))
    if (snapshot.live && !snapshot.entries.some(e => e.id === snapshot.liveId)) {
      main.push(this.n('col', { key: snapshot.liveId ?? 'live', role: 'omp.assistant' }, [
        this.n(this.supported('md', 'text'), { key: 'stream', stream: true }, [safeText(snapshot.live)]),
      ]))
    }
    const editor = this.n(this.supported('editor', 'input'), {
      key: 'input', text: this.draft.text, cursor: this.draft.cursor,
      placeholder: 'Ask dsh · /help · /session', maxLines: 18,
      sendable: !this.prompt,
      onEdit: (edit: NativeEdit) => {
        if (!this.prompt && this.draft.edit(edit)) this.render()
      },
      onUndo: () => { if (!this.prompt && this.draft.undo()) this.render() },
      onSend: (event: { text: string }) => { if (!this.prompt) this.send(event.text) },
    })
    const dock = [
      this.n('row', { key: 'status', role: 'dsh.status' }, [
        this.n('text', {
          key: 'label',
          spans: [{ s: 'strong', t: 'dsh' }, { s: 'muted', t: ' · ' + snapshot.sessionId + ' · ' + snapshot.status }],
        }),
      ]),
      ...(snapshot.notice ? [this.n('text', { key: 'notice', role: 'dsh.notice', text: snapshot.notice })] : []),
      this.n('col', { key: 'composer', role: 'omp.editor' }, [
        this.n('row', { key: 'line', role: 'omp.composer.line' }, [editor]),
      ]),
    ]
    const layer: Node[] = []
    if (this.prompt) {
      const prompt = this.prompt
      const options = prompt.request.choices ?? []
      layer.push(this.n(this.supported('card', 'col'), {
        key: 'question', role: 'dsh.question', tone: 'muted',
      }, [
        this.n('text', { key: 'title', text: prompt.request.title, wrap: 'word' }),
        ...(prompt.request.detail ? [this.n(this.supported('md', 'text'), {
          key: 'detail', text: prompt.request.detail,
        })] : []),
        ...options.map((choice, i) => this.n(this.supported('button', 'text'), {
          key: 'choice.' + i, text: (i + 1) + ') ' + choice.label,
          onClick: () => {
            if (prompt.request.multiple) {
              const old = this.answerDraft.text
              this.answerDraft.set(old ? old + ', ' + choice.value : choice.value)
              this.render()
            } else prompt.answer(choice.value)
          },
        })),
        this.n(this.supported('editor', 'input'), {
          key: 'answer', text: this.answerDraft.text, cursor: this.answerDraft.cursor,
          placeholder: options.length ? (prompt.request.multiple ? 'Numbers separated by commas' : 'Option or custom answer') : 'Answer',
          sendable: true,
          onEdit: (edit: NativeEdit) => { if (this.answerDraft.edit(edit)) this.render() },
          onUndo: () => { if (this.answerDraft.undo()) this.render() },
          onSend: (ev: { text: string }) => { if (ev.text.trim()) prompt.answer(ev.text) },
        }),
      ]))
    }
    this.surface.render({ main, dock, layer })
    this.revision += 1
    this.recorder?.write({
      direction: 'out', verb: 'render', parsedBytes: JSON.stringify({
        main: main.map(node => node.toJSON()), dock: dock.map(node => node.toJSON()),
        layer: layer.map(node => node.toJSON()),
      }).length,
      surfaceId: this.surfaceId(), revision: this.revision,
      eventSeq: snapshot.latestSeq,
      ...(this.session.caps ? { caps: this.session.caps } : {}),
    })
    this.surface.focus(this.prompt ? ANSWER : EDITOR)
    if (this.session.caps?.features.includes('settle') && this.surface.settle) {
      for (const entry of snapshot.entries) {
        if (entry.kind === 'tool' && entry.text.startsWith('Running ')) continue
        const id = 'main.' + entry.id
        if (this.gone.has(id) || this.settled.has(id)) continue
        this.surface.settle(id)
        this.settled.add(id)
      }
    }
  }

  update(snapshot: Snapshot): void {
    this.last = snapshot
    this.recorder ??= new TspRecorder(process.env.DSH_TSP_RECORD, snapshot.sessionId)
    if (!this.prompt && !this.draft.text && snapshot.draft) {
      this.draft.restore(snapshot.draft, snapshot.cursor)
    }
    this.render()
  }

  ask(request: Ask): Promise<string | null> {
    if (this.prompt || this.stopped) return Promise.resolve(null)
    this.answerDraft = new Draft()
    return abortableAnswer(request.signal, settle => {
      this.prompt = { request, answer: settle }
      this.render()
      return () => { this.prompt = undefined; this.render() }
    })
  }

  async closed(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.prompt?.answer(null)
    try { await this.session.close() } finally { await this.running }
  }
}
