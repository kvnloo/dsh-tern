/** Renderer and prompt-answer interface; both backends read one Transcript. */
import type { Snapshot } from './model.ts'

/** Presented label and canonical answer value for one approval, question or picker choice. */
export interface Choice {
  /** Text shown to the human. */
  readonly label: string
  /** Value passed back to the owning Cordis request. */
  readonly value: string
}
/** Exclusive terminal prompt that temporarily owns user input until answered or cancelled. */
export interface Ask {
  /** Logical owner from the public approval/tool-call, question or picker request. */
  readonly id: string
  /** Visible question heading. */
  readonly title: string
  /** Additional user-facing context supplied by the owning service. */
  readonly detail?: string
  /** Offered choices; absent permits a free-form answer. */
  readonly choices?: readonly Choice[]
  /** Whether comma-separated multiple answers are supported. */
  readonly multiple?: boolean
  /** Request cancellation; abort must settle with null. */
  readonly signal?: AbortSignal
}
/** Shared renderer boundary: ANSI and Tern consume the same durable Snapshot and return human decisions. */
export interface Terminal {
  /** Claim terminal input and install the canonical intent callbacks.
   * @param submit - normal composer submission; never an approval answer.
   * @param interrupt - user-requested Agent cancellation.
   * @param quit - terminal termination with optional failure.
   * @returns When input listeners have been installed.
   */
  start(submit: (text: string) => void, interrupt: () => void, quit: (error?: Error) => void): Promise<void>
  /** Display the latest projection without mutating durable Session state.
   * @param snapshot - durable transcript plus replaceable live and product hints.
   */
  update(snapshot: Snapshot): void
  /** Restore the canonical unsent composer value after a transient navigation.
   * @param text - complete user draft, not a model request.
   */
  restoreDraft(text: string): void
  /** Exclusively present a safety or choice request and await its decision.
   * @param request - current request identity, choices and cancellation signal.
   * @returns Selected value or null on denial-by-cancellation/closed input.
   */
  ask(request: Ask): Promise<string | null>
  /** Release input and restore terminal ownership; idempotent after teardown.
   * @returns Once owned readers and resources are released.
   */
  closed(): Promise<void>
}

/** Settle a pending human decision once, unregistering its owned handlers on answer or cancellation.
 * @param signal - optional cancellation signal; an already-aborted signal yields null.
 * @param receive - registers a completion callback and returns its unsubscriber.
 * @returns The answer, or null after cancellation; repeated completion is ignored.
 */
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
