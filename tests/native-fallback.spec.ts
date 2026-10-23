import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KeyDecoder, encodeJson, encodeMessage, node, type SessionInput } from '@stencil-hq/tern'
import { NativeTerminal, type TernSession, type TernSurface } from '../src/native.ts'
import { TspRecorder } from '../src/record.ts'
import type { Snapshot } from '../src/model.ts'

const snapshot: Snapshot = {
  sessionId: 'test', status: 'idle', entries: [
    { kind: 'assistant', id: 'answer', text: 'A reply' },
    { kind: 'tool', id: 'tool-1', text: 'Tool result: ok' },
  ], draft: '', cursor: 0, live: '', notice: '',
}

type Rendered = { main: readonly unknown[]; dock: readonly unknown[]; layer: readonly unknown[] }
type Cell = { kind: string; props: Record<string, unknown>; children: readonly unknown[]; handlers?: Record<string, unknown> }
function flatten(node: unknown): Cell[] {
  if (!node || typeof node !== 'object' || !('kind' in node)) return []
  const cell = node as Cell
  return [cell, ...(cell.children ?? []).flatMap(flatten)]
}
function fixture(kinds: string[]) {
  const frames: Rendered[] = []
  const focus: string[] = []
  const session: TernSession = {
    caps: { kinds, features: ['settle'] },
    open(): TernSurface {
      return {
        closed: false,
        render(view) { frames.push(view) },
        focus(id) { if (id) focus.push(id) },
        settle() {},
      }
    },
    async close() {},
    async *[Symbol.asyncIterator](): AsyncGenerator<SessionInput> {},
  }
  const term = new NativeTerminal({ node }, session)
  return { frames, focus, term, latest: () => frames.at(-1)! }
}

describe('native capability fallback and input isolation', () => {
  it('never emits unsupported kinds and omits focus without an editor or input', () => {
    const f = fixture(['text', 'rows', 'col'])
    f.term.update(snapshot)
    const all = [...f.latest().main, ...f.latest().dock, ...f.latest().layer].flatMap(flatten)
    expect(all.length).toBeGreaterThan(3)
    expect(all.every(item => ['text', 'rows', 'col'].includes(item.kind))).toBe(true)
    expect(all.some(item => item.props.text === 'A reply')).toBe(true)
    expect(f.focus).toEqual([])
  })

  it('supports rows-only negotiated surfaces without editor/input focus', () => {
    const f = fixture(['rows'])
    f.term.update(snapshot)
    const all = [...f.latest().main, ...f.latest().dock].flatMap(flatten)
    expect(all.length).toBeGreaterThan(0)
    expect(all.every(item => item.kind === 'rows')).toBe(true)
    expect(f.focus).toEqual([])
  })

  it('rejects queued previous-question handler callbacks by request instance', async () => {
    const f = fixture(['card', 'text', 'button', 'input', 'row', 'col'])
    const old = f.term.ask({ title: 'First?', choices: [{ label: 'No', value: 'no' }] })
    const first = f.latest().layer.flatMap(flatten).find(item => item.kind === 'button')
    const stale = first?.handlers?.onClick as (() => void) | undefined
    expect(stale).toBeTypeOf('function')
    stale?.()
    expect(await old).toBe('no')
    const fresh = f.term.ask({ title: 'Second?', choices: [{ label: 'Yes', value: 'yes' }] })
    stale?.()
    const second = f.latest().layer.flatMap(flatten).find(item => item.kind === 'button')
    expect(f.latest().layer.length).toBeGreaterThan(0)
    ;(second?.handlers?.onClick as () => void)()
    expect(await fresh).toBe('yes')
  })

  it('records real encoded UTF-8 wire bytes and ACK, never payload content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wire-'))
    try {
      const path = join(dir, 'wire.jsonl')
      const recorder = new TspRecorder(path, 'session-1')
      recorder.setContext({ revision: 9, eventSeq: 42 })
      recorder.setCapabilities(() => ({ kinds: ['text'], features: ['settle'], credits: 2, apc: 65536 }))
      const frame = encodeJson({
        verb: 'f', body: { sf: 'dsh', s: 7,
          ops: [['text', 'main.turn', 'replace', 'secret🙂']] },
      })
      recorder.capture('out', frame)
      const ack = encodeMessage('e', JSON.stringify({ ev: 'ack', sf: 'dsh', s: 7 }))
      recorder.capture('in', ack.subarray(0, 4))
      recorder.capture('in', ack.subarray(4))
      const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatchObject({
        verb: 'f', direction: 'out', wireBytes: frame.length, frameSeq: 7,
        surfaceId: 'dsh', revision: 9, eventSeq: 42,
      })
      expect(lines[1]).toMatchObject({ verb: 'e/ack', direction: 'in', ack: 7, wireBytes: ack.length })
      expect(readFileSync(path, 'utf8')).not.toContain('secret')
      expect(readFileSync(path, 'utf8')).not.toContain('🙂')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps multibyte and bracketed multiline paste with SDK decoder', () => {
    const decoder = new KeyDecoder()
    const draft: string[] = []
    const chunks = ['é🙂', '\x1b[200~line 1\nline 2\x1b[201~']
    for (const chunk of chunks) {
      for (const key of decoder.feed(new TextEncoder().encode(chunk))) {
        if (key.text) draft.push(key.text)
      }
    }
    expect(draft.join('')).toBe('é🙂line 1\nline 2')
  })
})
