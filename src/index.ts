/**
 * Native/ANSI terminal profile as a normal Cordis consumer of the public
 * Agent/Session services. Web, ACP, and headless compositions are untouched.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  installModelSelection, type AgentHandle, type ModelSelection, type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
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
import { AnsiInputFence } from './input-fence.ts'
import { ResourceStack } from './lifecycle.ts'
import { Transcript } from './model.ts'
import { connectTern, NativeTerminal } from './native.ts'
import { answerItem } from './questions.ts'
import { ProductServices } from './services.ts'
import type { Terminal } from './terminal.ts'

export const name = 'tui-app'
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** TUI plugin options supplied by the profile-owned command provider. */
export interface Config {
  /** Exact persisted root Session to resume; absent starts a new Session. */
  sessionId?: string
  /** Probe Tern when true (default); false forces the ANSI fallback. */
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
  let inputFence: AnsiInputFence | undefined
  let connected: Awaited<ReturnType<typeof connectTern>> = null
  let stopping = false
  let failed: unknown
  const release = new ResourceStack()
  const done = Promise.withResolvers<void>()
  let lastInterrupt = 0
  const ownedHandles = new Set<AgentHandle>()
  const products = new ProductServices(ctx)
  const trackListener = (remove: () => unknown): void => {
    release.add(() => { remove() })
  }

  try {
    let selectionRef: ModelSelectionRef = { current: model.currentSelection(), assembled: undefined }
    const initialRef = selectionRef
    const selection = initialRef.current!
    const agentOptions = { provider: selection.provider, model: selection.model }
    const setup = (agentCtx: Context): void => {
      installModelSelection(agentCtx, initialRef)
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
    ownedHandles.add(handle)
    let agent = handle.agent
    let transcript = new Transcript(id)
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

    // Tap before the SDK probe, so ordinary keys consumed during handshake and
    // any partially received TSP frame keep their ownership on ANSI fallback.
    inputFence = new AnsiInputFence()
    connected = config.native === false ? null : await connectTern(id)
    if (connected) {
      // Native keeps the SDK's original in-band key stream; never replay a tap.
      inputFence.close()
      inputFence = undefined
    }
    terminal = connected
      ? new NativeTerminal(connected.sdk, connected.session, connected.recorder)
      : new AnsiTerminal({ stdin: inputFence!.activate(), stdout: process.stdout })
    const display = terminal
    let switching = false
    const show = (): void => display.update(transcript.snapshot({
      all: true, product: products.project(agent, selectionRef),
    }))
    const interrupt = (): void => {
      if (agent.status === 'running') {
        agent.cancel({ kind: 'user' })
        return
      }
      if (Date.now() - lastInterrupt < 1500) done.resolve()
      else lastInterrupt = Date.now()
    }
    const warn = (error: unknown): void => {
      transcript.notice(error instanceof Error ? error.message : String(error))
      show()
    }
    const report = (message: string): void => { transcript.notice(message); show() }

    const switchSession = async (target: SessionId, fresh: boolean): Promise<void> => {
      if (switching) throw new Error('a session switch is already in flight')
      if (agent.status === 'running') throw new Error('finish or stop the current turn before switching sessions')
      if (!fresh && target === agent.id) return report('Already in session ' + target)
      if (agents.get(target)) throw new Error('session ' + target + ' is already owned by a live Agent')
      switching = true
      let nextHandle: AgentHandle | undefined
      try {
        await agent.whenIdle()
        await sessions.flush(agent.session)
        let nextRoute: ModelSelection = model.currentSelection()
        if (!fresh) {
          const query = ctx.get('sessionQuery')
          if (!query || !ctx.get('sessionPersistence')) {
            throw new Error('resuming requires both sessionQuery and sessionPersistence')
          }
          using observation = await query.observeSession(target)
          assertRootSession(observation.header, observation.events, target, cwd)
          // A resumed session retains its last durable request route; a global
          // default changed meanwhile must not silently select another model.
          for (const event of observation.events) {
            if (event.type !== 'request/header') continue
            const route = event.data.header.config
            nextRoute = {
              provider: route.provider, model: route.model,
              ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
            }
          }
        }
        const nextRef: ModelSelectionRef = { current: nextRoute, assembled: undefined }
        const agentOptions = { provider: nextRoute.provider, model: nextRoute.model }
        const setup = (agentCtx: Context): void => { installModelSelection(agentCtx, nextRef) }
        nextHandle = fresh
          ? await agents.create({ sessionId: target, meta: { cwd }, agentOptions, setup })
          : await agents.resume({ resumeSessionId: target, agentOptions, setup })
        if (!fresh) assertRootSession(nextHandle.agent.session.header, readEvents(nextHandle.agent.session), target, cwd)
        const nextTranscript = new Transcript(target)
        nextTranscript.replay(nextHandle.agent.session)
        nextTranscript.status(nextHandle.agent.status)
        const previous = handle!
        const previousId = agent.id
        ownedHandles.add(nextHandle)
        handle = nextHandle
        agent = nextHandle.agent
        selectionRef = nextRef
        transcript = nextTranscript
        products.clearDetail(previousId)
        report('Session: ' + target)
        await previous.dispose()
        ownedHandles.delete(previous)
      } catch (error) {
        if (nextHandle && nextHandle !== handle) await nextHandle.dispose()
        throw error
      } finally {
        switching = false
      }
    }

    const choose = async (
      id: string, title: string, choices: readonly { label: string; value: string }[],
    ): Promise<string | null> => {
      if (choices.length === 0) throw new Error(title + ': no candidates from the owning service')
      return display.ask({ id, title, choices: [...choices] })
    }
    const commands = async (raw: string): Promise<void> => {
      const text = raw.trim()
      if (!text || stopping) return
      if (switching) {
        display.restoreDraft(raw)
        report('Switch in progress; draft retained. Submit after adoption.')
        return
      }
      if (text === '/quit' || text === '/exit') { done.resolve(); return }
      if (text === '/stop') { interrupt(); return }
      if (text === '/session') return report('Session: ' + agent.id)
      if (text === '/help') {
        return report('/model · /models · /sessions · /new · /resume ID · /plan · /tasks · '
          + '/jobs · /job ID · /job-stop ID · /agents · /agent ID · /agent-steer ID TEXT · '
          + '/agent-stop ID · /steer TEXT · /stop · /quit')
      }
      if (text === '/model' || text === '/models') {
        const options = await products.modelChoices()
        const chosen = await choose('picker.model', 'Choose a model', options.map(option => ({
          label: option.label, value: option.id,
        })))
        if (!chosen) return
        const selected = await products.selectModel(selectionRef, chosen)
        return report('Model: ' + selected.provider + '/' + selected.model)
      }
      if (text.startsWith('/model ')) {
        const selected = await products.selectModel(selectionRef, text.slice(7).trim())
        return report('Model: ' + selected.provider + '/' + selected.model)
      }
      if (text === '/sessions') {
        const options = (await products.rootSessions(cwd))
          .filter(choice => choice.persisted && choice.id !== agent.id)
        const chosen = await choose('picker.session', 'Resume an existing root session', options.map(choice => ({
          label: choice.label, value: String(choice.id),
        })))
        if (chosen) await switchSession(brandString<SessionId>(chosen), false)
        return
      }
      if (text === '/new') {
        await switchSession(brandString<SessionId>('session-' + randomUUID()), true)
        return
      }
      if (text.startsWith('/resume ')) {
        await switchSession(brandString<SessionId>(text.slice(8).trim()), false)
        return
      }
      if (text === '/plan') {
        const plan = products.project(agent, selectionRef).plan
        return report(plan ? 'Plan: ' + (plan.active ? 'active' : 'inactive')
          + (plan.pending === undefined ? '' : ' · pending ' + String(plan.pending))
          : 'Plan mode service is not configured')
      }
      if (text === '/tasks') {
        const tasks = products.project(agent, selectionRef).tasks
        return report(tasks ? 'Task list: ' + tasks.length + ' logged items' : 'No current durable task list')
      }
      if (text === '/jobs') {
        const jobs = products.project(agent, selectionRef).jobs
        return report(jobs ? 'Jobs: ' + jobs.length + ' visible' : 'Job registry is not configured')
      }
      if (text.startsWith('/job ')) {
        products.inspectJob(agent.id, text.slice(5).trim())
        return show()
      }
      if (text.startsWith('/job-stop ')) {
        const result = products.stopJob(agent.id, text.slice(10).trim())
        return report('Job stop: ' + result)
      }
      if (text === '/agents') {
        const target = agent.id
        const children = await products.refreshDescendants(target)
        if (target === agent.id) report('Subagents: ' + (children?.length ?? 0) + ' durable descendants')
        return
      }
      if (text.startsWith('/agent ')) {
        await products.inspectChild(agent.id, text.slice(7).trim())
        return show()
      }
      if (text.startsWith('/agent-stop ')) {
        await products.stopChild(agent.id, text.slice(12).trim())
        return report('Subagent stop requested')
      }
      if (text.startsWith('/agent-steer ')) {
        const match = /^\/agent-steer\s+(\S+)\s+([\s\S]+)$/.exec(raw)
        if (!match) throw new Error('Usage: /agent-steer CHILD_ID MESSAGE')
        await products.steerChild(agent.id, match[1]!, match[2]!, 'steer')
        return report('Subagent steer accepted')
      }
      const steer = text.startsWith('/steer ')
      if (text.startsWith('/') && !steer) return report('Unknown command; use /help')
      const message = createUserMessage({
        content: [{ type: 'text', text: steer ? raw.slice(7) : raw }],
        source: { kind: 'user' },
      })
      if (steer) agent.steer(message)
      else agent.followup(message)
      show()
    }
    const submit = (raw: string): void => {
      void commands(raw).catch(warn)
    }

    trackListener(ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      transcript.accept(event)
      show()
    }, { global: true }))
    trackListener(ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject !== agent) return
      transcript.stream(frame)
      show()
    }, { global: true }))
    trackListener(ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent) return
      transcript.status(status)
      show()
    }, { global: true }))
    trackListener(ctx.on('approval/request', async (request, next) => {
      if (request.agent !== agent) return next()
      const detail = request.displayReason?.en ?? request.reason
      const answer = await display.ask({
        // ApprovalRequestEvent exposes callId, not the audit ApprovalRequestId.
        id: 'approval:' + String(request.callId ?? randomUUID()),
        title: 'Allow once: ' + request.toolName + '?',
        ...(detail === undefined ? {} : { detail }),
        choices: [
          { label: 'Allow once', value: 'allowed-once' },
          { label: 'Deny', value: 'rejected' },
        ],
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      return answer === 'allowed-once' ? 'allowed-once' : request.signal?.aborted ? 'cancelled' : 'rejected'
    }, { global: true }))
    trackListener(ctx.on('user-questions/request', async (request, next) => {
      if (request.agent !== agent) return next()
      const answers = []
      for (const question of request.questions) {
        const answer = await display.ask({
          id: 'question:' + String(request.wait?.callId ?? 'untimed') + ':' + question.id,
          title: question.header ? question.header + ': ' + question.question : question.question,
          ...(question.detail === undefined ? {} : { detail: question.detail }),
          ...(question.options === undefined ? {} : { choices: question.options.map(option => ({
            label: option.label + (option.description ? ' — ' + option.description : ''),
            value: option.label,
          })) }),
          ...(question.multiSelect === undefined ? {} : { multiple: question.multiSelect }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
        if (answer === null) throw new Error('user question was cancelled')
        answers.push(answerItem(question, answer))
      }
      return { answers }
    }, { global: true }))

    await display.start(submit, interrupt, error => {
      if (error) done.reject(error)
      else done.resolve()
    })
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
    if (inputFence) await cleanup(() => inputFence!.close())
    if (handle) {
      await cleanup(() => handle!.agent.whenIdle())
      await cleanup(async () => { await sessions.flush(handle!.agent.session) })
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
