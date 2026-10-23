/**
 * The SDK owns TSP negotiation, APC framing, credits, render reconciliation,
 * native editor dispatch, and surface focus. No private terminal escape
 * protocol is implemented here. This is the same public-SDK pattern used by
 * Hermes for Tern (kvnloo/hermes-tern frontend/src/{entry,surface,view}).
 */
import { abortableAnswer, type Ask, type Terminal } from './terminal.ts'
import { Draft, type NativeEdit } from './draft.ts'
import { safeText, type Entry, type Snapshot } from './model.ts'

export interface TernNode {
  readonly kind?: string
  readonly props?: Record<string, unknown>
}
export interface TernSurface {
  readonly closed: boolean
  render(view: { main: unknown[]; dock: unknown[]; layer: unknown[] }): void
  focus(id: string | null): void
}
export interface TernInput {
  readonly type: 'key' | 'event'
  readonly key?: { name: string; ctrl?: boolean; alt?: boolean; shift?: boolean }
  readonly event?: { ev: string; sf?: string; ids?: string[]; visible?: boolean }
}
export interface TernSession extends AsyncIterable<TernInput> {
  open(options: { id: string; mode: 'inline'; role: string; title: string }): TernSurface
  close(): Promise<void>
}
export interface TernSDK {
  connect(options: { app: string; features: string[]; version: string }): Promise<TernSession | null>
  node(kind: string, props: Record<string, unknown>, children?: unknown[]): unknown
}

/**
 * The peer is optional only so non-Tern terminals work on deployments that
 * never install the SDK. TSP is enabled by installing @stencil-hq/tern@0.1.0.
 */
export async function connectTern(): Promise<{ sdk: TernSDK; session: TernSession } | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null
  try {
    const packageName = '@stencil-hq/tern'
    const sdk = await import(packageName) as TernSDK
    const session = await sdk.connect({ app: 'dsh', features: ['edit', 'undo', 'send'], version: '0.2.1' })
    return session ? { sdk, session } : null
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error
      && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) {
      return null
    }
    throw error
  }
}

const EDITOR = 'dock.composer.line.input'

export class NativeTerminal implements Terminal {
  private surface: TernSurface
  private epoch = 0
  private draft = new Draft()
  private submit: (text: string) => void = () => {}
  private interrupt: () => void = () => {}
  private quit: () => void = () => {}
  private last: Snapshot | undefined
  private prompt: { request: Ask; answer: (text: string | null) => void } | undefined
  private running: Promise<void> | undefined
  private stopped = false

  constructor(private readonly sdk: TernSDK, private readonly session: TernSession) {
    this.surface = this.openSurface()
  }

  private openSurface(): TernSurface {
    return this.session.open({
      id: this.epoch ? 'dsh.recovery.' + this.epoch : 'dsh',
      mode: 'inline', role: 'omp.session', title: 'DeepSeek Harness',
    })
  }

  async start(submit: (text: string) => void, interrupt: () => void, quit: () => void): Promise<void> {
    this.submit = submit
    this.interrupt = interrupt
    this.quit = quit
    // Input iteration belongs to this terminal. SDK dispatches node callbacks
    // before yielding unhandled key and semantic events.
    this.running = (async () => {
      try {
        for await (const input of this.session) {
          if (this.stopped) break
          if (input.type === 'key' && input.key) {
            const key = input.key
            if (key.ctrl && key.name === 'c') this.prompt ? this.prompt.answer(null) : this.interrupt()
            else if (key.ctrl && key.name === 'd') this.quit()
            else if (key.name === 'enter' && !this.prompt && !key.shift) this.sendDraft()
          }
          if (input.type === 'event' && input.event?.ev === 'gone'
            && input.event.ids?.includes(this.epoch ? 'dsh.recovery.' + this.epoch : 'dsh')) {
            this.epoch += 1
            if (this.epoch > 3) throw new Error('Tern surface recovery limit reached')
            this.surface = this.openSurface()
            if (this.last) this.update(this.last)
          }
          if (input.type === 'event' && input.event?.ev === 'error') {
            throw new Error('Tern rejected a surface operation')
          }
        }
      } catch (error) {
        process.stderr.write('dsh Tern: ' + String(error) + '\n')
      } finally {
        if (!this.stopped) this.quit()
      }
    })()
  }

  private node(kind: string, props: Record<string, unknown>, children: unknown[] = []): unknown {
    return this.sdk.node(kind, props, children)
  }

  private renderEntry(entry: Entry): unknown {
    if (entry.kind === 'tool' || entry.kind === 'error') {
      return this.node('card', { key: entry.id, role: 'dsh.tool', tone: entry.kind === 'error' ? 'error' : 'neutral' }, [
        this.node('text', { key: 'result', text: entry.text, wrap: 'word' }),
      ])
    }
    return this.node('card', { key: entry.id, role: entry.kind === 'user' ? 'omp.user' : 'omp.assistant' }, [
      this.node('md', { key: 'body' }, [entry.text || ' ']),
    ])
  }

  private sendDraft(): void {
    const text = this.draft.take()
    if (text.trim()) this.submit(text)
    this.render()
  }

  private render(): void {
    const snapshot = this.last
    if (!snapshot || this.stopped || this.surface.closed) return
    const main = snapshot.entries.map(e => this.renderEntry(e))
    if (snapshot.live) {
      main.push(this.node('col', { key: 'live', role: 'omp.assistant' }, [
        this.node('md', { key: 'stream', stream: true }, [safeText(snapshot.live)]),
      ]))
    }
    const editor = this.node('editor', {
      key: 'input', text: this.draft.text, cursor: this.draft.cursor,
      placeholder: 'Ask dsh · /help · /session', maxLines: 18,
      sendable: !this.prompt,
      onEdit: (edit: NativeEdit) => {
        if (this.prompt) return
        if (this.draft.edit(edit)) this.render()
      },
      onUndo: () => { if (!this.prompt && this.draft.undo()) this.render() },
      onSend: (event: { text: string }) => {
        if (this.prompt) return
        // A native submit is the current editor snapshot; a stale submit is ignored.
        if (event.text === this.draft.text) this.sendDraft()
      },
    })
    const dock = [
      this.node('row', { key: 'status', role: 'dsh.status' }, [
        this.node('text', {
          key: 'label',
          spans: [{ s: 'strong', t: 'dsh' }, { s: 'dim', t: ' · ' + snapshot.sessionId + ' · ' + snapshot.status }],
        }),
      ]),
      this.node('col', { key: 'composer', role: 'omp.editor' }, [
        this.node('row', { key: 'line', role: 'omp.composer.line' }, [editor]),
      ]),
    ]
    const layer: unknown[] = []
    if (this.prompt) {
      const prompt = this.prompt
      const options = prompt.request.choices
      layer.push(this.node('card', { key: 'question', role: 'dsh.question', tone: 'neutral' }, [
        this.node('text', { key: 'title', text: prompt.request.title, wrap: 'word' }),
        ...(prompt.request.detail ? [this.node('md', { key: 'detail' }, [prompt.request.detail])] : []),
        ...(options ?? []).map((choice, i) => this.node('button', {
          key: 'choice.' + i, text: choice.label,
          onClick: () => prompt.answer(choice.value),
        })),
        ...(!options?.length ? [
          this.node('editor', {
            key: 'answer', text: this.draft.text, cursor: this.draft.cursor,
            placeholder: 'Answer', sendable: true,
            onEdit: (edit: NativeEdit) => { if (this.draft.edit(edit)) this.render() },
            onSend: (ev: { text: string }) => {
              if (ev.text !== this.draft.text) return
              prompt.answer(this.draft.take())
            },
          }),
        ] : []),
      ]))
    }
    this.surface.render({ main, dock, layer })
    this.surface.focus(this.prompt ? (this.prompt.request.choices?.length ? null : 'layer.question.answer') : EDITOR)
  }

  update(snapshot: Snapshot): void {
    this.last = snapshot
    if (!this.prompt && snapshot.draft !== this.draft.text) {
      // App/model owns the durable draft; the native editor owns in-progress edits.
      // Initial synchronization is enough; a rerender must not erase unsubmitted input.
      if (!this.draft.text && snapshot.draft) this.draft.set(snapshot.draft)
    }
    this.render()
  }

  ask(request: Ask): Promise<string | null> {
    if (this.prompt || this.stopped) return Promise.resolve(null)
    return abortableAnswer(request.signal, settle => {
      const answer = (text: string | null): void => settle(text)
      this.prompt = { request, answer }
      this.render()
      return () => { this.prompt = undefined; this.render() }
    })
  }

  async closed(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.prompt?.answer(null)
    await this.session.close()
    await this.running
  }
}
