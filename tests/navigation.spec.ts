import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Transcript } from '../src/model.ts'

const event = (seq: number, text: string): Extract<SessionEvent, { type: 'user/message' }> => ({
  seq: SessionSeq(seq), time: seq, type: 'user/message', surfaceOp: 'append',
  data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
})

describe('durable history navigation', () => {
  it('retains every durable identity while screen snapshots stay bounded', () => {
    const transcript = new Transcript('session')
    for (let seq = 0; seq < 320; seq++) transcript.accept(event(seq, 'message ' + seq))
    expect(transcript.snapshot().entries).toHaveLength(240)
    const full = transcript.snapshot({ all: true }).entries
    expect(full).toHaveLength(320)
    expect(full[0]).toMatchObject({ id: 'event.0', text: 'message 0' })
    expect(full[319]).toMatchObject({ id: 'event.319', text: 'message 319' })
    expect(transcript.accept(event(0, 'duplicate'))).toBeUndefined()
    expect(transcript.snapshot({ all: true }).entries[0]?.text).toBe('message 0')
  })

  it('can reconcile a replacement touching an older-than-screen entry', () => {
    const transcript = new Transcript('session')
    for (let seq = 0; seq < 270; seq++) transcript.accept(event(seq, 'message ' + seq))
    transcript.accept({
      ...event(270, 'replacement'),
      surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) },
    })
    const all = transcript.snapshot({ all: true }).entries
    expect(all).toHaveLength(270)
    expect(all.some(entry => entry.id === 'event.0')).toBe(false)
    expect(all.at(-1)?.text).toBe('replacement')
  })
})
