import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { Transcript, safeText, textContent } from '../src/model.ts'

function ev(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, type, data, time: seq } as SessionEvent
}

describe('single durable projection', () => {
  it('replays a Session and de-duplicates live append events', () => {
    const transcript = new Transcript('session-test')
    const log = [
      ev(0, 'turn/start', { turn: 1 }),
      ev(1, 'user/message', { content: [{ type: 'text', text: 'hello' }] }),
      ev(2, 'tool/call', { name: 'bash', arguments: '{}', callId: 'call-1', turn: 1, step: 1 }),
      ev(3, 'assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }),
      ev(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const session = { seq: log.length, eventAt: (index: number) => log[index] } as Parameters<Transcript['replay']>[0]
    transcript.replay(session)
    expect(transcript.snapshot().entries.map(entry => entry.text)).toEqual(['hello', 'Running bash', 'done'])
    expect(transcript.snapshot().status).toBe('idle')
    expect(transcript.accept(log[3]!)).toBeUndefined()
    expect(transcript.snapshot().entries).toHaveLength(3)
  })

  it('never commits a speculative streaming attempt', () => {
    const transcript = new Transcript('test')
    transcript.stream({ type: 'start', attemptId: 'a', revision: 1, step: 1, turn: 1 } as AssistantStreamFrame)
    transcript.stream({ type: 'chunk', attemptId: 'a', revision: 2, time: 1, index: 0, chunk: { type: 'text-delta', text: 'uncommitted' } } as AssistantStreamFrame)
    expect(transcript.snapshot().live).toBe('uncommitted')
    expect(transcript.snapshot().entries).toHaveLength(0)
    transcript.stream({ type: 'start', attemptId: 'retry', revision: 3, step: 1, turn: 1 } as AssistantStreamFrame)
    transcript.stream({ type: 'chunk', attemptId: 'a', revision: 4, time: 2, index: 1, chunk: { type: 'text-delta', text: 'wrong' } } as AssistantStreamFrame)
    expect(transcript.snapshot().live).toBe('')
    transcript.accept(ev(5, 'assistant/message', { message: { content: [{ type: 'text', text: 'durable' }] } }))
    expect(transcript.snapshot().entries[0]?.text).toBe('durable')
  })

  it('bounds on-screen history and strips unsafe terminal controls', () => {
    const transcript = new Transcript('large')
    for (let i = 0; i < 300; i++) {
      transcript.accept(ev(i, 'user/message', { content: [{ type: 'text', text: String(i) }] }))
    }
    expect(transcript.snapshot().entries).toHaveLength(240)
    expect(transcript.snapshot().entries[0]?.text).toBe('60')
    expect(safeText('ok\u001b[31mX\u0000')).toBe('ok[31mX')
    expect(textContent([{ type: 'image', data: 'secret' }, { type: 'text', text: 'safe' }])).toBe('safe')
  })
})
