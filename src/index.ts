/**
 * Native/ANSI terminal profile as a normal Cordis consumer of the public
 * Agent/Session services. Web, ACP, and headless compositions are untouched.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
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

/** One interactive invocation. Terminal callbacks only send through Agent APIs. */
async function run(ctx: Context, config: Config): Promise<void> {
  await ctx.get('loader')?.await()
  const sessions = ctx.get('sessions')
  if (!sessions || !ctx.get('agents') || !ctx.get('agentDefaultModel')) return
  const id = brandString<SessionId>(config.sessionId ?? 'session-' + randomUUID())
  // The startup provider is injected through the patch. A direct test of the
  // runner can still supply config without re-parsing the launcher's args.
  const agent = await (async () => {
    const model = ctx.get('agentDefaultModel')
    const selection = model!.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const setup = (agentCtx: Context): void => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined } satisfies ModelSelectionRef)
    }
    const fs = ctx.get('fs')
    const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
    if (!config.sessionId) {
      return (await ctx.get('agents')!.create({ sessionId: id, meta: { cwd }, agentOptions, setup })).agent
    }
    if (!ctx.get('sessionPersistence')) throw new Error('resuming requires sessionPersistence')
    const query = ctx.get('sessionQuery')
    if (!query) throw new Error('resuming requires sessionQuery')
    if (ctx.get('agents')!.get(id)) throw new Error('session ' + id + ' is already active')
    try {
      using observed = await query.observeSession(id)
      assertRootSession(observed.header, observed.events, id, cwd)
      const { agent } = await ctx.get('agents')!.resume({ resumeSessionId: id, agentOptions, setup })
      assertRootSession(agent.session.header, readEvents(agent.session), id, cwd)
      return agent
    } catch (error) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new Error('session ' + id + ' does not exist')
      }
      throw error
    }
  })()
  const transcript = new Transcript(id)
  transcript.replay(agent.session)
  transcript.status(agent.status)

  const connected = config.native === false ? null : await connectTern()
  const terminal: Terminal = connected
    ? new NativeTerminal(connected.sdk, connected.session)
    : new AnsiTerminal()

  const done = Promise.withResolvers<void>()
  let stopping = false
  let lastInterrupt = 0
  const show = (): void => terminal.update(transcript.snapshot())
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

  // Watchers are owner-local. The live stream is a view hint only; the durable
  // append is the only event that becomes a transcript row.
  const offSession = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    transcript.accept(event)
    show()
  }, { global: true })
  const offStream = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return
    transcript.stream(frame)
    show()
  }, { global: true })
  const offStatus = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject !== agent) return
    transcript.status(status)
    show()
  }, { global: true })
  const offApproval = ctx.on('approval/request', async (request, next) => {
    if (request.agent !== agent) return next()
    const answer = await terminal.ask({
      title: 'Allow once: ' + request.toolName + '?',
      detail: request.displayReason?.en ?? request.reason,
      choices: [
        { label: 'Allow once', value: 'allowed-once' },
        { label: 'Deny', value: 'rejected' },
      ],
      signal: request.signal,
    })
    return answer === 'allowed-once' ? 'allowed-once' : request.signal?.aborted ? 'cancelled' : 'rejected'
  }, { global: true })
  const offQuestions = ctx.on('user-questions/request', async (request, next) => {
    if (request.agent !== agent) return next()
    const answers = []
    for (const question of request.questions) {
      const choices = question.multiSelect ? undefined : question.options?.map(option => ({
        label: option.label, value: option.label,
      }))
      const answer = await terminal.ask({
        title: question.header ? question.header + ': ' + question.question : question.question,
        detail: question.detail,
        choices,
        signal: request.signal,
      })
      if (answer === null) throw new Error('user question was cancelled')
      answers.push(answerItem(question, answer))
    }
    return { answers }
  }, { global: true })

  try {
    await terminal.start(submit, interrupt, () => done.resolve())
    show()
    await done.promise
  } finally {
    stopping = true
    offQuestions()
    offApproval()
    offStatus()
    offStream()
    offSession()
    if (agent.status === 'running') agent.cancel({ kind: 'disposed' })
    await terminal.closed()
    await agent.whenIdle()
    await sessions.flush(agent.session)
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
