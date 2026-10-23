/**
 * Native/ANSI terminal profile as a normal Cordis consumer of the public
 * Agent/Session services. Web, ACP, and headless compositions are untouched.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { AnsiTerminal } from './ansi.ts'
import { ResourceStack } from './lifecycle.ts'
import { Transcript } from './model.ts'
import { connectTern, NativeTerminal } from './native.ts'
import { answerItem } from './questions.ts'
import type { Terminal } from './terminal.ts'

export const name = 'tui-app'
export const inject = ['agentDefaultModel', 'agents', 'sessions']

export interface Config {
  sessionId?: string
  native?: boolean
}
export const Config: z<Config> = z.object({
  sessionId: z.string(),
  native: z.boolean().default(true),
})

/** Read the log before resuming: the TUI does not compose preset or subagent trees. */
function assertRootSession(
  header: { cwd?: string; origin?: string; parentSession?: string; agentPreset?: string },
  events: Iterable<SessionEvent>,
  id: SessionId,
  cwd: string,
): void {
  if (header.cwd !== cwd) throw new Error('session ' + id + ' belongs to a different working directory')
  if (header.origin === 'subagent' || header.parentSession !== undefined) {
    throw new Error('session ' + id + ' is an owned or forked child and cannot be resumed as a root')
  }
  let preset = header.agentPreset
  for (const event of events) {
    const source = event as { type: string; data: { agentPreset?: unknown } }
    if (source.type !== 'agent-preset/selected') continue
    if (typeof source.data.agentPreset !== 'string' || !source.data.agentPreset) {
      throw new Error('malformed agent-preset/selected record for ' + id)
    }
    preset = source.data.agentPreset
  }
  if (preset) throw new Error('session ' + id + ' uses agent preset ' + preset + ', which this TUI does not compose')
}

function* readEvents(session: Session): Generator<SessionEvent> {
  for (let seq = 0; seq < session.seq; seq++) {
    // Existing Session history; the query above validates before write adoption.
    // oxlint-disable-next-line typescript/no-deprecated -- Durable Session replay API pending projection migration.
    const event = session.eventAt(SessionSeq(seq))
    if (!event) throw new Error('missing persisted session event ' + seq)
    yield event
  }
}

/** One interactive invocation, including startup and failure teardown. */
async function run(ctx: Context, config: Config): Promise<void> {
  await ctx.get('loader')?.await()
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const model = ctx.get('agentDefaultModel')
  if (!sessions || !agents || !model) throw new Error('TUI requires sessions, agents and agentDefaultModel')
  const id = brandString<SessionId>(config.sessionId ?? 'session-' + randomUUID())
  let handle: AgentHandle | undefined
  let terminal: Terminal | undefined
  let connected: Awaited<ReturnType<typeof connectTern>> = null
  let stopping = false
  let failed: unknown
  const release = new ResourceStack()
  const done = Promise.withResolvers<void>()
  let lastInterrupt = 0

  try {
    const selection = model.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const setup = (agentCtx: Context): void => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined } satisfies ModelSelectionRef)
    }
    const fs = ctx.get('fs')
    const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
    if (!config.sessionId) {
      handle = await agents.create({ sessionId: id, meta: { cwd }, agentOptions, setup })
    } else {
      if (!ctx.get('sessionPersistence')) throw new Error('resuming requires sessionPersistence')
      const query = ctx.get('sessionQuery')
      if (!query) throw new Error('resuming requires sessionQuery')
      if (agents.get(id)) throw new Error('session ' + id + ' is already active')
      try {
        using observed = await query.observeSession(id)
        assertRootSession(observed.header, observed.events, id, cwd)
        handle = await agents.resume({ resumeSessionId: id, agentOptions, setup })
        assertRootSession(handle.agent.session.header, readEvents(handle.agent.session), id, cwd)
      } catch (error) {
        if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
          throw new Error('session ' + id + ' does not exist')
        }
        throw error
      }
    }
    const agent = handle.agent
    const transcript = new Transcript(id)
    transcript.replay(agent.session)
    transcript.status(agent.status)

    const stopOnSignal = (): void => {
      if (agent.status === 'running') agent.cancel({ kind: 'user' })
      done.resolve()
    }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, stopOnSignal)
      release.add(() => { process.off(signal, stopOnSignal) })
    }

    connected = config.native === false ? null : await connectTern()
    terminal = connected
      ? new NativeTerminal(connected.sdk, connected.session)
      : new AnsiTerminal()
    const display = terminal
    const show = (): void => display.update(transcript.snapshot())
    const interrupt = (): void => {
      if (agent.status === 'running') {
        agent.cancel({ kind: 'user' })
        return
      }
      if (Date.now() - lastInterrupt < 1500) done.resolve()
      else lastInterrupt = Date.now()
    }
    const submit = (raw: string): void => {
      if (stopping) return
      const text = raw.trim()
      if (!text) return
      if (text === '/quit' || text === '/exit') return done.resolve()
      if (text === '/stop') return interrupt()
      if (text === '/session') {
        transcript.notice('Session: ' + id)
        return show()
      }
      if (text === '/help') {
        transcript.notice('/help · /session · /stop · /steer <text> · /quit')
        return show()
      }
      const steer = text.startsWith('/steer ')
      if (steer && !text.slice(7).trim()) return
      const message = createUserMessage({
        content: [{ type: 'text', text: steer ? text.slice(7) : raw }],
        source: { kind: 'user' },
      })
      if (steer) agent.steer(message)
      else agent.followup(message)
      show()
    }

    release.add(ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      transcript.accept(event)
      show()
    }, { global: true }))
    release.add(ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject !== agent) return
      transcript.stream(frame)
      show()
    }, { global: true }))
    release.add(ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent) return
      transcript.status(status)
      show()
    }, { global: true }))
    release.add(ctx.on('approval/request', async (request, next) => {
      if (request.agent !== agent) return next()
      const answer = await display.ask({
        title: 'Allow once: ' + request.toolName + '?',
        detail: request.displayReason?.en ?? request.reason,
        choices: [
          { label: 'Allow once', value: 'allowed-once' },
          { label: 'Deny', value: 'rejected' },
        ],
        signal: request.signal,
      })
      return answer === 'allowed-once' ? 'allowed-once' : request.signal?.aborted ? 'cancelled' : 'rejected'
    }, { global: true }))
    release.add(ctx.on('user-questions/request', async (request, next) => {
      if (request.agent !== agent) return next()
      const answers = []
      for (const question of request.questions) {
        const answer = await display.ask({
          title: question.header ? question.header + ': ' + question.question : question.question,
          detail: question.detail,
          choices: question.options?.map(option => ({
            label: option.label + (option.description ? ' — ' + option.description : ''),
            value: option.label,
          })),
          multiple: question.multiSelect,
          signal: request.signal,
        })
        if (answer === null) throw new Error('user question was cancelled')
        answers.push(answerItem(question, answer))
      }
      return { answers }
    }, { global: true }))

    await display.start(submit, interrupt, () => done.resolve())
    show()
    await done.promise
  } catch (error) {
    failed = error
    throw error
  } finally {
    stopping = true
    const cleanupErrors: unknown[] = []
    const cleanup = async (action: () => void | Promise<void>): Promise<void> => {
      try { await action() } catch (error) { cleanupErrors.push(error) }
    }
    await cleanup(() => release.close())
    if (handle?.agent.status === 'running') handle.agent.cancel({ kind: 'disposed' })
    if (terminal) await cleanup(() => terminal!.closed())
    else if (connected) await cleanup(() => connected!.session.close())
    if (handle) {
      await cleanup(() => handle!.agent.whenIdle())
      await cleanup(() => sessions.flush(handle!.agent.session))
      await cleanup(() => handle!.dispose())
    }
    if (cleanupErrors.length) {
      if (failed === undefined) throw new AggregateError(cleanupErrors, 'TUI cleanup failed')
      process.stderr.write('dsh tui: cleanup after startup failure: ' + cleanupErrors.map(String).join('; ') + '\n')
    }
  }
}

/** A self-contained profile app entry; failure is reported through launcher exit. */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (!exit) throw new Error('TUI needs the dsh appExit service')
  void run(ctx, config).then(
    () => exit(0),
    error => {
      process.stderr.write('dsh tui: ' + (error instanceof Error ? error.message : String(error)) + '\n')
      exit(1)
    },
  )
}
