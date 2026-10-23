/** Renderer and prompt-answer interface; both backends read one Transcript. */
import type { Snapshot } from './model.ts'

export interface Choice {
  readonly label: string
  readonly value: string
}
export interface Ask {
  readonly title: string
  readonly detail?: string
  readonly choices?: readonly Choice[]
  readonly multiple?: boolean
  readonly signal?: AbortSignal
}
export interface Terminal {
  start(submit: (text: string) => void, interrupt: () => void, quit: () => void): Promise<void>
  update(snapshot: Snapshot): void
  ask(request: Ask): Promise<string | null>
  closed(): Promise<void>
}

export function abortableAnswer(
  signal: AbortSignal | undefined,
  receive: (settle: (answer: string | null) => void) => () => void,
): Promise<string | null> {
  if (signal?.aborted) return Promise.resolve(null)
  return new Promise(resolve => {
    let settled = false
    let unregister = () => {}
    const finish = (answer: string | null): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', aborted)
      unregister()
      resolve(answer)
    }
    const aborted = (): void => finish(null)
    signal?.addEventListener('abort', aborted, { once: true })
    unregister = receive(finish)
    if (settled) unregister()
    if (signal?.aborted) finish(null)
  })
}
