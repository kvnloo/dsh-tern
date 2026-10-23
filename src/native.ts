/**
 * Public @stencil-hq/tern 0.1.0 handles TSP framing, hello/DA1, input decoding,
 * credits, chunking and terminal restoration. Plain typing stays on the PTY.
 */
import { createHash } from 'node:crypto'
import {
  connect, node, type Key, type Node, type OpenOptions, type SessionInput,
  type TermInput, type TermOutput,
} from '@stencil-hq/tern'
import { abortableAnswer, type Ask, type Choice, type Terminal } from './terminal.ts'
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
export async function connectTern(
  sessionId: string,
): Promise<{ sdk: TernSDK; session: TernSession; recorder: TspRecorder } | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null
  const recorder = new TspRecorder(process.env.DSH_TSP_RECORD, sessionId)
  const readers = new Map<(chunk: Uint8Array | string) => void, (chunk: Uint8Array | string) => void>()
  const input: TermInput = {
    get isTTY() { return process.stdin.isTTY },
    get isRaw() { return process.stdin.isRaw },
    setRawMode(mode) { process.stdin.setRawMode(mode) },
    resume() { process.stdin.resume() },
    pause() { process.stdin.pause() },
    on(event, listener) {
      const observed = (chunk: Uint8Array | string): void => {
        recorder.capture('in', chunk)
        listener(chunk)
      }
      readers.set(listener, observed)
      process.stdin.on(event, observed)
    },
    off(event, listener) {
      const observed = readers.get(listener)
      if (observed) process.stdin.off(event, observed)
      readers.delete(listener)
    },
  }
  const output: TermOutput = {
    get isTTY() { return process.stdout.isTTY },
    get columns() { return process.stdout.columns },
    write(data) {
      recorder.capture('out', data)
      return process.stdout.write(data)
    },
  }
  const session = await connect({
    app: 'dsh', features: ['edit', 'undo', 'send'], version: '0.2.1',
    input, output, record: process.env.DSH_TSP_RECORD_FULL ?? '', exitHooks: false,
  })
  if (!session) return null
  recorder.setCapabilities(() => session.caps)
  return { sdk: { node }, session, recorder }
}

type ActivePrompt = {
  readonly request: Ask
  readonly root: string
  readonly answer: (text: string | null) => void
}

export class NativeTerminal implements Terminal {
  private surface: TernSurface
  private epoch = 0
  private draft = new Draft()
  private answerDraft = new Draft()
  private submit: (text: string) => void = () => {}
  private interrupt: () => void = () => {}
  private quit: (error?: Error) => void = () => {}
  private last: Snapshot | undefined
  private prompt: ActivePrompt | undefined
  private promptOpenings = 0
  private running: Promise<void> | undefined
  private stopped = false
  private readonly gone = new Map<string, string>()
  private readonly settled = new Map<string, string>()
  private visible = true
  private pendingRecovery = false
  private revision = 0
  constructor(
    private readonly sdk: TernSDK,
    private readonly session: TernSession,
    private recorder?: TspRecorder,
  ) {
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

  /** Surface lifetime is presentation-only: never reissue Agent intents on reconnect. */
  private recover(): void {
    this.pendingRecovery = false
    this.epoch += 1
    if (this.epoch > 3) throw new Error('Tern surface recovery limit reached')
    this.gone.clear()
    this.settled.clear()
    this.surface = this.openSurface()
    this.render()
  }

  async start(submit: (text: string) => void, interrupt: () => void, quit: (error?: Error) => void): Promise<void> {
    if (this.running) throw new Error('Native terminal already started')
    this.submit = submit
    this.interrupt = interrupt
    this.quit = quit
    this.running = (async () => {
      let failure: Error | undefined
      try {
        for await (const input of this.session) {
          if (this.stopped) break
          if (input.type === 'key') this.key(input.key)
          else if (input.event.ev === 'gone') {
            if (input.event.ids.includes(this.surfaceId())) {
              if (this.visible) this.recover()
              else this.pendingRecovery = true
            } else {
              for (const id of input.event.ids) {
                const version = this.settled.get(id)
                if (version) {
                  this.gone.set(id, version)
                  this.settled.delete(id)
                }
              }
              if (this.visible) this.render()
            }
          } else if (input.event.ev === 'visible'
            && (!input.event.sf || input.event.sf === this.surfaceId())) {
            this.visible = input.event.visible
            if (this.visible) {
              if (this.pendingRecovery) this.recover()
              else this.render()
            }
          } else if (input.event.ev === 'resize') {
            if (typeof input.event.visible === 'boolean') this.visible = input.event.visible
            if (this.visible) {
              if (this.pendingRecovery) this.recover()
              else this.render()
            }
          } else if (input.event.ev === 'theme' || input.event.ev === 'motion') {
            if (this.visible) this.render()
          } else if (input.event.ev === 'error'
            && (!input.event.sf || input.event.sf === this.surfaceId())) {
            throw new Error('Tern rejected a surface operation: ' + input.event.msg)
          }
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
      } finally {
        if (!this.stopped) this.quit(failure)
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
    const prompt = this.prompt
    if (prompt) {
      if (key.name === 'escape') { prompt.answer(null); return }
      if (prompt.request.choices?.length
        && /^[1-9]$/.test(key.name) && !key.alt && !key.ctrl && !key.meta) {
        const option = prompt.request.choices[Number(key.name) - 1]
        if (option) { this.choose(prompt, option); return }
      }
      if (key.name === 'enter' && !key.shift && !key.alt) {
        const answer = this.answerDraft.take()
        if (answer.trim()) prompt.answer(answer)
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

  /** PTY keys and native actions use one request-instance-guarded decision. */
  private choose(prompt: ActivePrompt, choice: Choice): void {
    if (this.prompt !== prompt) return
    if (prompt.request.multiple) {
      const old = this.answerDraft.text
      this.answerDraft.set(old ? old + ', ' + choice.value : choice.value)
      this.render()
    } else {
      prompt.answer(choice.value)
    }
  }

  private n(kind: string, props: Record<string, unknown>, children: Node[] | string[] = []): Node {
    return this.sdk.node(kind, props, children)
  }

  /** A fallback must itself be negotiated; rows is a non-editable PTY display. */
  private supported(...kinds: string[]): string | undefined {
    const negotiated = this.session.caps?.kinds
    return kinds.find(kind => !negotiated || negotiated.includes(kind))
  }

  private textNode(key: string, text: string, markdown = false): Node {
    const kind = this.supported(...(markdown ? ['md', 'text', 'rows'] : ['text', 'rows']))
    if (!kind) throw new Error('Tern lacks both text and rows presentation kinds')
    return kind === 'rows'
      ? this.n('rows', { key, lines: text.split('\n') })
      : this.n(kind, { key, text, ...(kind === 'text' ? { wrap: 'word' } : {}) })
  }

  private wrap(key: string, role: string, children: Node[], props: Record<string, unknown> = {}): Node {
    const kind = this.supported('card', 'col', 'row')
    if (!kind) {
      // The terminal has only leaves; one rows/text leaf can still represent the entry.
      const leaf = children[0]
      if (!leaf) throw new Error('cannot render an empty Tern node')
      return leaf
    }
    return this.n(kind, { key, role, ...props }, children)
  }

  private version(entry: Entry): string {
    return createHash('sha256').update(entry.kind).update('\0').update(entry.text).digest('hex')
  }

  private renderEntry(entry: Entry): Node {
    const role = entry.kind === 'tool' || entry.kind === 'error'
      ? 'dsh.tool' : entry.kind === 'user' ? 'dsh.user' : 'dsh.assistant'
    const markdown = entry.kind === 'assistant' || entry.kind === 'user'
    if (!this.supported('card', 'col', 'row')) return this.textNode(entry.id, entry.text, markdown)
    return this.wrap(entry.id, role, [
      this.textNode('body', entry.text, markdown),
    ], entry.kind === 'error' ? { tone: 'error' } : {})
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
    if (!snapshot || this.stopped || !this.visible || this.surface.closed) return
    const main: Node[] = []
    for (const entry of snapshot.entries) {
      const id = 'main.' + entry.id
      const version = this.version(entry)
      if (this.gone.get(id) === version) continue
      this.gone.delete(id)
      main.push(this.renderEntry(entry))
    }
    if (snapshot.live && !snapshot.entries.some(e => e.id === snapshot.liveId)) {
      const id = snapshot.liveId ?? 'live'
      main.push(this.supported('card', 'col', 'row')
        ? this.wrap(id, 'dsh.assistant', [this.textNode('stream', safeText(snapshot.live), true)])
        : this.textNode(id, safeText(snapshot.live), true))
    }
    // Public plan, task, job and child facts use durable identities and source
    // lifecycle labels. The renderer does not synthesize completion percentages.
    const product = snapshot.product
    if (product?.model) main.push(this.wrap('state.model', 'dsh.model', [
      this.textNode('route', 'Model · ' + product.model.provider + '/' + product.model.model),
    ]))
    if (product?.plan) main.push(this.wrap('state.plan', 'dsh.plan', [
      this.textNode('mode', 'Plan · ' + (product.plan.active ? 'active' : 'inactive')
        + (product.plan.pending === undefined ? '' : ' · pending ' + String(product.plan.pending))),
    ]))
    for (const task of product?.tasks ?? []) {
      main.push(this.wrap('state.' + task.id, 'dsh.task', [
        this.textNode('status', task.status + ' · ' + task.text),
      ]))
    }
    for (const job of product?.jobs ?? []) {
      main.push(this.wrap('state.job.' + job.id, 'dsh.job', [
        this.textNode('status', job.id + ' · ' + job.status + ' · ' + job.label
          + (job.progress ? ' · ' + job.progress : '') + (job.detail ? ' · ' + job.detail : '')),
      ]))
    }
    for (const child of product?.children ?? []) {
      main.push(this.wrap('state.child.' + child.id, 'dsh.subagent', [
        this.textNode('status', child.id + ' · ' + child.mode + ' · '
          + child.activity + ' · ' + child.label),
      ]))
    }
    if (product?.detail) {
      main.push(this.wrap('detail.' + product.detail.id, 'dsh.detail', [
        this.textNode('title', product.detail.title),
        this.textNode('body', product.detail.text, true),
      ]))
    }
    const editorKind = this.supported('editor', 'input')
    const status = this.textNode(Boolean(this.supported('row', 'col')) ? 'label' : 'status',
      'dsh · ' + snapshot.sessionId + ' · ' + snapshot.status)
    const rowKind = this.supported('row', 'col')
    const colKind = this.supported('col', 'row', 'card')
    const dock: Node[] = [
      rowKind ? this.n(rowKind, { key: 'status', role: 'dsh.status' }, [status]) : status,
      ...(snapshot.notice ? [this.textNode('notice', snapshot.notice)] : []),
    ]
    if (editorKind) {
      const editor = this.n(editorKind, {
        key: 'input', text: this.draft.text, cursor: this.draft.cursor,
        placeholder: 'Ask dsh · /help · /session', maxLines: 18,
        sendable: !this.prompt,
        onEdit: (edit: NativeEdit) => {
          if (!this.prompt && this.draft.edit(edit)) this.render()
        },
        onUndo: () => { if (!this.prompt && this.draft.undo()) this.render() },
        onSend: (event: { text: string }) => { if (!this.prompt) this.send(event.text) },
      })
      const line = rowKind
        ? this.n(rowKind, { key: 'line', role: 'dsh.composer.line' }, [editor]) : editor
      dock.push(colKind ? this.n(colKind, { key: 'composer', role: 'dsh.editor' }, [line]) : line)
    } else {
      // No native editor/input: the SDK's PTY keys still edit this canonical draft.
      // A text/rows view gives the user its state; Enter submits through key().
      const draft = this.textNode('draft', this.draft.text || 'Ask dsh · Enter sends')
      dock.push(colKind ? this.n(colKind, { key: 'composer', role: 'dsh.editor' }, [draft]) : draft)
    }
    const layer: Node[] = []
    const prompt = this.prompt
    const answerKind = this.supported('editor', 'input')
    if (prompt) {
      // Root identity belongs to this opening. Reusing a logical approval ID
      // cannot retarget old wire events through the SDK's newest handler map.
      const group = this.supported('card', 'col', 'row')
      const scopedKey = (part: string): string => group ? part : prompt.root + '.' + part
      const options = prompt.request.choices ?? []
      const children: Node[] = [this.textNode(scopedKey('title'), prompt.request.title)]
      if (prompt.request.detail) {
        children.push(this.textNode(scopedKey('detail'), prompt.request.detail, true))
      }
      const choiceKind = this.supported('el', 'row', 'text', 'rows')
      for (const [i, choice] of options.entries()) {
        const label = (i + 1) + ') ' + choice.label
        const key = scopedKey('choice.' + i)
        const onClick = (): void => { this.choose(prompt, choice) }
        // "button" is not a TSP kind. Native el has a real button tag;
        // negotiated row/text/rows also support pointer actions.
        if (choiceKind === 'el') {
          children.push(this.n('el', {
            key, tag: 'button', text: label, role: 'dsh.question.choice', onClick,
          }))
        } else if (choiceKind === 'row') {
          children.push(this.n('row', {
            key, role: 'dsh.question.choice', onClick,
          }, [this.textNode('label', label)]))
        } else if (choiceKind === 'text') {
          children.push(this.n('text', {
            key, text: label, wrap: 'word', role: 'dsh.question.choice', onClick,
          }))
        } else if (choiceKind === 'rows') {
          children.push(this.n('rows', {
            key, lines: [label], role: 'dsh.question.choice', onClick,
          }))
        } else {
          throw new Error('Tern cannot render an approval choice')
        }
      }
      if (answerKind) {
        children.push(this.n(answerKind, {
          key: scopedKey('answer'), text: this.answerDraft.text, cursor: this.answerDraft.cursor,
          placeholder: options.length ? (prompt.request.multiple ? 'Numbers separated by commas' : 'Option or custom answer') : 'Answer',
          sendable: true,
          onEdit: (edit: NativeEdit) => {
            if (this.prompt === prompt && this.answerDraft.edit(edit)) this.render()
          },
          onUndo: () => {
            if (this.prompt === prompt && this.answerDraft.undo()) this.render()
          },
          onSend: (ev: { text: string }) => {
            if (this.prompt === prompt && ev.text.trim()) prompt.answer(ev.text)
          },
        }))
      } else {
        children.push(this.textNode(scopedKey('answer'), this.answerDraft.text || 'Type answer; Enter confirms'))
      }
      if (group) {
        layer.push(this.n(group, { key: prompt.root, role: 'dsh.question' }, children))
      } else {
        layer.push(...children)
      }
    }
    this.recorder?.setContext({
      revision: this.revision + 1,
      ...(snapshot.latestSeq === undefined ? {} : { eventSeq: snapshot.latestSeq }),
    })
    this.surface.render({ main, dock, layer })
    this.revision += 1
    // Focus only an actual editor/input node. Never issue focus to rows/text.
    if (prompt && answerKind) {
      this.surface.focus('layer.' + prompt.root + '.answer')
    } else if (!prompt && editorKind) {
      const path = ['dock', colKind ? 'composer' : '', rowKind ? 'line' : '', 'input']
        .filter(Boolean).join('.')
      this.surface.focus(path)
    }
    if (this.session.caps?.features.includes('settle') && this.surface.settle) {
      for (const entry of snapshot.entries) {
        if (entry.kind === 'tool' && entry.text.startsWith('Running ')) continue
        const id = 'main.' + entry.id
        const version = this.version(entry)
        if (this.gone.get(id) === version || this.settled.get(id) === version) continue
        this.surface.settle(id)
        this.settled.set(id, version)
      }
    }
  }

  restoreDraft(text: string): void {
    if (this.prompt) return
    this.draft.restore(text, text.length)
    this.render()
  }

  update(snapshot: Snapshot): void {
    this.last = snapshot
    this.recorder?.setSessionId(snapshot.sessionId)
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
      const root = 'request.'
        + createHash('sha256').update(request.id).digest('hex').slice(0, 12)
        + '.' + (++this.promptOpenings)
      const opened: ActivePrompt = { request, root, answer: settle }
      this.prompt = opened
      this.render()
      return () => {
        if (this.prompt !== opened) return
        this.prompt = undefined
        this.render()
      }
    })
  }

  async closed(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.prompt?.answer(null)
    try { await this.session.close() } finally { await this.running }
  }
}
