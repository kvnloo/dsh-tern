import { describe, expect, it } from 'vitest'
import { Draft } from '../src/draft.ts'

describe('TSP native editor stale-event boundary', () => {
  it('uses UTF-16 offsets including surrogate pairs', () => {
    const draft = new Draft()
    draft.set('a😀z')
    expect(draft.edit({ from: 1, to: 3, text: 'X', cursor: 2, len: 4 })).toBe(true)
    expect(draft.text).toBe('aXz')
    expect(draft.cursor).toBe(2)
    expect(draft.undo()).toBe(true)
    expect(draft.text).toBe('a😀z')
  })

  it('does not apply events for obsolete or malformed ranges', () => {
    const draft = new Draft()
    draft.set('newer text')
    expect(draft.edit({ from: 0, to: 2, text: 'stale', cursor: 5, len: 2 })).toBe(false)
    expect(draft.edit({ from: -1, to: 2, text: 'x', cursor: 0, len: 10 })).toBe(false)
    expect(draft.edit({ from: 4, to: 2, text: 'x', cursor: 0, len: 10 })).toBe(false)
    expect(draft.text).toBe('newer text')
    expect(draft.undo()).toBe(true)
    expect(draft.text).toBe('')
    expect(draft.take()).toBe('')
    expect(draft.undo()).toBe(false)
  })

  it('clamps cursor positions after replace', () => {
    const draft = new Draft()
    draft.set('abcd')
    expect(draft.edit({ from: 1, to: 3, text: '', cursor: 999, len: 4 })).toBe(true)
    expect(draft.cursor).toBe(2)
    expect(draft.take()).toBe('ad')
  })
})
