import { describe, expect, it } from 'vitest'
import { answerItem } from '../src/questions.ts'

const q = {
  id: 'q1', question: 'Choose',
  options: [{ label: 'Alpha' }, { label: 'Beta' }],
}
describe('typed user-question answer adapter', () => {
  it('selects offered option by label or index', () => {
    expect(answerItem(q, '2')).toEqual({ id: 'q1', selected: ['Beta'] })
    expect(answerItem(q, 'Alpha')).toEqual({ id: 'q1', selected: ['Alpha'] })
  })
  it('accepts multiple choices once and optional custom text', () => {
    expect(answerItem({ ...q, multiSelect: true }, '1, 2, 1, custom')).toEqual({
      id: 'q1', selected: ['Alpha', 'Beta'], custom: 'custom',
    })
  })
  it('accepts free text when no choices exist', () => {
    expect(answerItem({ id: 'free', question: 'Why?' }, 'because')).toEqual({
      id: 'free', selected: [], custom: 'because',
    })
  })
})
