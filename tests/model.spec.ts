import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { Transcript, safeText, textContent } from '../src/model.ts'

function ev(seq: number, type: string, data: unknown): SessionEvent {
  return { seq: SessionSeq(seq), type, data, time: seq } as SessionEvent
}

describe('single durable projection', () => {
  it('replays a Session and de-duplicates live append events', () => {
    const transcript = new Transcript('session-test')
    const callId = ToolCallId('call-1')
    const log: SessionEvent[] = [
      { seq: SessionSeq(0), time: 0, type: 'turn/start', data: { turn: 1 } },
      {
        seq: SessionSeq(1), time: 1, type: 'user/message',
        data: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      {
        seq: SessionSeq(2), time: 2, type: 'tool/call',
        data: { name: 'bash', arguments: '{}', callId, turn: 1, step: 1 },
      },
      {
        seq: SessionSeq(3), time: 3, type: 'tool/result',
        data: {
          turn: 1, step: 1,
          message: createToolResultMessage({
            callId, content: [{ type: 'text', text: 'ok' }], isError: false,
          }),
        },
        surfaceOp: 'append',
      },
      {
        seq: SessionSeq(4), time: 4, type: 'assistant/message',
        data: {
          turn: 1, step: 2,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'done' }],
            source: { provider: 'fixture', model: 'fixture' },
          }),
          stream: [],
        },
        surfaceOp: 'append',
      },
      { seq: SessionSeq(5), time: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const session = { seq: log.length, eventAt: (index: SessionSeq) => log[index] } as Parameters<Transcript['replay']>[0]
    transcript.replay(session)
    expect(transcript.snapshot().entries.map(entry => entry.text)).toEqual([
      'hello', 'Tool result: ok', 'done',
    ])
    expect(transcript.snapshot().status).toBe('idle')
    expect(transcript.accept(log[4]!)).toBeUndefined()
    expect(transcript.snapshot().entries).toHaveLength(3)
  })

  it('retains the interrupted flag visibly after live output is committed and replayed', () => {
    const transcript = new Transcript('cancelled-session')
    const durable: SessionEvent<'assistant/message'> = {
      seq: SessionSeq(2), time: 2, type: 'assistant/message', surfaceOp: 'append',
      data: {
        turn: 4, step: 2, interrupted: true, stream: [],
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'Durable partial answer' }],
          source: { provider: 'fixture', model: 'fixture' },
        }),
      },
    }
    const events: SessionEvent[] = [
      { seq: SessionSeq(0), time: 0, type: 'turn/start', data: { turn: 4 } },
      {
        seq: SessionSeq(1), time: 1, type: 'user/message',
        data: createUserMessage({ content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }),
      },
      durable,
      { seq: SessionSeq(3), time: 3, type: 'turn/end', data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ]
    const canonicalBeforeProjection = JSON.stringify(durable)
    transcript.accept(events[0]!)
    transcript.accept(events[1]!)
    transcript.stream({ type: 'start', attemptId: 'attempt-4', revision: 1, turn: 4, step: 2 } as AssistantStreamFrame)
    transcript.stream({
      type: 'chunk', attemptId: 'attempt-4', revision: 2, time: 1, index: 0,
      chunk: { type: 'text-delta', text: 'Durable partial' },
    } as AssistantStreamFrame)
    expect(transcript.snapshot().live).toBe('Durable partial')
    expect(transcript.snapshot().entries).toHaveLength(1)

    expect(transcript.accept(durable)).toEqual({
      id: 'assistant.4.2', kind: 'assistant', text: 'Interrupted response\nDurable partial answer',
    })
    transcript.stream({
      type: 'chunk', attemptId: 'attempt-4', revision: 3, time: 3, index: 1,
      chunk: { type: 'text-delta', text: 'late, non-durable tail' },
    } as AssistantStreamFrame)
    transcript.accept(events[3]!)
    expect(transcript.snapshot().live).toBe('')
    expect(transcript.snapshot().liveId).toBeUndefined()
    expect(transcript.snapshot().status).toBe('idle')
    expect(transcript.snapshot().entries.filter(row => row.kind === 'assistant')).toEqual([
      { id: 'assistant.4.2', kind: 'assistant', text: 'Interrupted response\nDurable partial answer' },
    ])
    expect(transcript.accept(durable)).toBeUndefined()
    expect(transcript.snapshot().entries).toHaveLength(2)
    expect(JSON.stringify(durable)).toBe(canonicalBeforeProjection)

    const session = {
      seq: events.length, eventAt: (seq: SessionSeq) => events[seq],
    } as Parameters<Transcript['replay']>[0]
    const resumed = new Transcript('cancelled-session')
    resumed.replay(session)
    expect(resumed.snapshot().entries).toEqual(transcript.snapshot().entries)
    resumed.replay(session)
    expect(resumed.snapshot().entries).toHaveLength(2)
    expect(resumed.snapshot().entries.filter(row => row.id === 'assistant.4.2')).toHaveLength(1)
    expect(JSON.stringify(durable)).toBe(canonicalBeforeProjection)
  })

  it('does not annotate an ordinary completed assistant reply', () => {
    const transcript = new Transcript('completed-session')
    const completed: SessionEvent<'assistant/message'> = {
      seq: SessionSeq(0), time: 0, type: 'assistant/message', surfaceOp: 'append',
      data: {
        turn: 1, step: 1, stream: [],
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'Complete answer' }],
          source: { provider: 'fixture', model: 'fixture' },
        }),
      },
    }
    expect(transcript.accept(completed)).toEqual({
      id: 'assistant.1.1', kind: 'assistant', text: 'Complete answer',
    })
    expect(transcript.snapshot().entries).toHaveLength(1)
    expect(completed.data.interrupted).toBeUndefined()
  })

  it('marks a genuinely orphaned tool interrupted when its turn ends', () => {
    const transcript = new Transcript('orphan')
    const callId = ToolCallId('orphan-call')
    transcript.accept({ seq: SessionSeq(0), time: 0, type: 'turn/start', data: { turn: 1 } })
    transcript.accept({
      seq: SessionSeq(1), time: 1, type: 'tool/call',
      data: { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' },
    })
    transcript.accept({
      seq: SessionSeq(2), time: 2, type: 'turn/end',
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    expect(transcript.snapshot().entries).toEqual([
      { id: 'tool.orphan-call', kind: 'error', text: 'Interrupted bash' },
    ])
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

  it('reconciles a durable surface replacement instead of replaying compacted nodes', () => {
    const transcript = new Transcript('compacted')
    transcript.accept({
      seq: SessionSeq(1), time: 1, type: 'user/message', surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } }),
    })
    transcript.accept({
      seq: SessionSeq(2), time: 2, type: 'assistant/message', surfaceOp: 'append',
      data: {
        turn: 1, step: 1, stream: [],
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'older' }], source: { provider: 'fixture', model: 'fixture' },
        }),
      },
    })
    transcript.accept({
      seq: SessionSeq(3), time: 3, type: 'assistant/message',
      surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(2) },
      data: {
        turn: 1, step: 2, stream: [],
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'summary' }], source: { provider: 'fixture', model: 'fixture' },
        }),
      },
    })
    expect(transcript.snapshot().entries.map(row => row.text)).toEqual(['summary'])
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
