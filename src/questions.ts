/** Convert native/ANSI answers into the core user-questions reply contract. */
import type {
  AskUserQuestionAnswer, AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions'

/** Parse one answer without substituting unrecognized text for offered labels.
 * @param question - the core service's question including offered choices and multi-select policy.
 * @param text - the terminal answer, optionally comma-separated option numbers or labels.
 * @returns The question id, deduplicated selected labels and optional free-form custom text.
 */
export function answerItem(question: AskUserQuestionItem, text: string): AskUserQuestionAnswer['answers'][number] {
  const options = question.options ?? []
  if (!options.length) return { id: question.id, selected: [], custom: text }
  const raw = question.multiSelect ? text.split(',').map(piece => piece.trim()) : [text.trim()]
  const selected: string[] = []
  const custom: string[] = []
  for (const item of raw) {
    const index = Number(item)
    const picked = Number.isSafeInteger(index) && String(index) === item && index >= 1
      ? options[index - 1] : undefined
    const option = picked ?? options.find(option => option.label === item)
    if (option) {
      if (!selected.includes(option.label)) selected.push(option.label)
    } else if (item) {
      custom.push(item)
    }
  }
  return {
    id: question.id,
    selected,
    ...(custom.length ? { custom: custom.join(', ') } : {}),
  }
}
