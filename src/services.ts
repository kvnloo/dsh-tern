/**
 * TUI read/intent adapter over DSH's public registries. Nothing here creates
 * a second Agent runtime, persists its own session log, or consumes model output.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry, SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type { ProductState } from './model.ts'

/** Registered provider/model route offered by the mounted LLM catalog. */
export interface ModelChoice {
  readonly id: string
  readonly label: string
  readonly route: ModelSelection
}
/** Root Session eligible for explicit resume in the current working directory. */
export interface SessionChoice {
  readonly id: SessionId
  readonly label: string
  readonly persisted: boolean
}

/** Rejection is explicit if a provider, session, or child capability is absent. */
export class ProductServices {
  private readonly descendants = new Map<SessionId, ProductState['children']>()
  private readonly details = new Map<SessionId, ProductState['detail']>()

  constructor(private readonly ctx: Context) {}

  /** Resolve mounted providers and their models without hard-coded catalog entries.
   * @returns Provider/model routes currently exposed by the public LLM service.
   * @throws Error when the public LLM catalog is absent.
   */
  async modelChoices(): Promise<ModelChoice[]> {
    const llm = this.ctx.get('llm')
    if (!llm) throw new Error('model selection requires the public llm service')
    const choices: ModelChoice[] = []
    for (const provider of llm.listProviders()) {
      const models = await llm.listModels(provider.id)
      for (const model of models) {
        choices.push({
          id: provider.id + '/' + model.id,
          label: provider.name + ' · ' + model.name,
          route: { provider: model.provider, model: model.id },
        })
      }
    }
    return choices
  }

  /** Validate a route against the real catalog before updating saved and live model selection.
   * @param reference - Agent-scoped model selection for subsequent steps.
   * @param requested - exact provider/model catalog id.
   * @returns Persisted provider and model selection.
   * @throws Error for an unregistered route or missing model service.
   */
  async selectModel(reference: ModelSelectionRef, requested: string): Promise<ModelSelection> {
    const candidates = await this.modelChoices()
    const choice = candidates.find(item => item.id === requested)
    if (!choice) throw new Error('model is not registered in the current public catalog: ' + requested)
    const defaults = this.ctx.get('agentDefaultModel')
    if (!defaults) throw new Error('model selection requires agentDefaultModel')
    await defaults.saveSelection(choice.route)
    reference.current = choice.route
    reference.assembled = undefined
    return choice.route
  }

  /** List current working directory's root Sessions without claiming their ownership.
   * @param cwd - exact directory recorded when the Session was opened.
   * @returns Sessions with persisted status for explicit adoption.
   */
  async rootSessions(cwd: string): Promise<SessionChoice[]> {
    const query = this.ctx.get('sessionQuery')
    if (!query) throw new Error('session switching requires sessionQuery')
    const records = await query.filterSessions([{ kind: 'cwd', values: [cwd] }])
    return records.filter(({ header }) =>
      header.cwd === cwd
      && header.origin !== 'subagent'
      && header.parentSession === undefined
      && header.agentPreset === undefined
    ).map(({ header, persisted }) => ({
      id: header.id,
      label: header.id + ' · ' + new Date(header.createdAt).toISOString(),
      persisted,
    }))
  }

  /** Refresh public descendant facts including diagnostics, without guessed progress.
   * @param parentId - owner Session to query for descendants.
   * @returns Current public child and diagnostic rows.
   */
  async refreshDescendants(parentId: SessionId): Promise<ProductState['children']> {
    const runtime = this.ctx.get('subagents')
    if (!runtime) throw new Error('subagent roster requires subagents service')
    const rows = await runtime.listDescendants(parentId)
    const children = rows.map(row => ({
      id: row.id, parentId: row.parentId, depth: row.depth,
      label: row.kind === 'child' ? row.label ?? String(row.id) : row.reason,
      mode: row.kind === 'child' ? row.mode : 'diagnostic',
      activity: row.kind === 'child' ? row.activity : row.reason,
    }))
    this.descendants.set(parentId, children)
    return children
  }

  /** Inspect a public descendant and optionally its persisted surface summary.
   * @param parent - parent Session authorizing the roster query.
   * @param childId - requested descendant Session id.
   * @returns Transient inspection details from public services.
   */
  async inspectChild(parent: SessionId, childId: string): Promise<ProductState['detail']> {
    const runtime = this.ctx.get('subagents')
    if (!runtime) throw new Error('subagent roster requires subagents service')
    const row = (await runtime.listDescendants(parent)).find(item => item.id === childId)
    if (!row) throw new Error('child is not in the public descendant roster: ' + childId)
    const facts = [
      'Session: ' + row.id,
      'Parent: ' + row.parentId,
      'Depth: ' + row.depth,
      ...(row.kind === 'child'
        ? ['Mode: ' + row.mode, 'Activity: ' + row.activity, 'Label: ' + (row.label ?? row.id)]
        : ['Diagnostic: ' + row.reason]),
    ]
    const query = this.ctx.get('sessionQuery')
    if (query) {
      const surface = await query.readSurface(row.id)
      facts.push('Observed through event: ' + String(surface.capturedThroughSeq ?? 'none'))
      facts.push('Current surface events: ' + surface.events.length)
    }
    const detail = { id: String(row.id), title: 'Subagent ' + row.id, text: facts.join('\n') }
    this.details.set(parent, detail)
    return detail
  }

  private async child(parent: SessionId, childId: string): Promise<SubagentDescendantListEntry & { kind: 'child' }> {
    const runtime = this.ctx.get('subagents')
    if (!runtime) throw new Error('subagent control requires subagents service')
    const row = (await runtime.listDescendants(parent)).find(item => item.id === childId)
    if (!row || row.kind !== 'child') throw new Error('child is not in the public descendant roster: ' + childId)
    if (row.mode !== 'continuable') throw new Error('one-shot child has no continuation control: ' + childId)
    return row
  }

  /** Deliver a user-authored instruction through the public continuable-child API.
   * @param parent - parent Session authorizing the child.
   * @param childId - descendant Session id.
   * @param text - nonempty user message content.
   * @param delivery - step-boundary steering or queued delivery.
   */
  async steerChild(parent: SessionId, childId: string, text: string, delivery: 'steer' | 'queue'): Promise<void> {
    const row = await this.child(parent, childId)
    if (!text.trim()) throw new Error('cannot send an empty child message')
    const runtime = this.ctx.get('subagents')
    if (!runtime) throw new Error('subagent control requires subagents service')
    const signal = new AbortController().signal
    await runtime.prompt({
      requestId: brandString<SubagentPromptRequestId>('tui-' + randomUUID()),
      parentSessionId: row.parentId, childSessionId: row.id, mode: 'continuable',
      delivery, content: [{ type: 'text', text }],
    }, signal)
  }

  /** Interrupt a continuable subagent, rejecting one-shot and unknown descendants.
   * @param parent - authorized parent Session.
   * @param childId - child Session to interrupt.
   */
  async stopChild(parent: SessionId, childId: string): Promise<void> {
    const row = await this.child(parent, childId)
    const runtime = this.ctx.get('subagents')
    if (!runtime) throw new Error('subagent control requires subagents service')
    runtime.interrupt(row.id, { kind: 'user', parentSessionId: row.parentId })
  }

  /** Request a job stop via its owner-scoped public registry.
   * @param owner - Session authorized to control the job.
   * @param jobId - durable registry id.
   * @returns Registry-defined stop result.
   */
  stopJob(owner: SessionId, jobId: string): string {
    const jobs = this.ctx.get('jobs')
    if (!jobs) throw new Error('job control requires jobs service')
    return jobs.kill(JobId(jobId), owner, 'TUI user stopped job')
  }

  /** Read retained job output non-destructively without advancing the model's cursor.
   * @param owner - Session authorized to read the job.
   * @param jobId - durable job identifier.
   * @returns Bounded user-facing job details.
   */
  inspectJob(owner: SessionId, jobId: string): ProductState['detail'] {
    const jobs = this.ctx.get('jobs')
    if (!jobs) throw new Error('job detail requires jobs service')
    const id = JobId(jobId)
    const view = jobs.get(id, owner)
    // Non-consuming read: never steal a model-facing output cursor.
    const output = jobs.readAt(id, view.output.earliest, owner)
    const text = [
      view.status + ' · ' + view.label,
      ...(view.progress ? [view.progress] : []),
      ...(view.detail ? [view.detail] : []),
      ...(output.lossy ? ['Earlier job output was not retained.'] : []),
      ...output.chunks.map(chunk => chunk.text),
    ].join('\n')
    const detail = { id: String(view.id), title: 'Job ' + view.id, text: text.slice(-8192) }
    this.details.set(owner, detail)
    return detail
  }

  /** Clear a transient inspection panel when changing Session ownership.
   * @param owner - Session whose inspection is dismissed.
   */
  clearDetail(owner: SessionId): void {
    this.details.delete(owner)
  }

  /** Project mounted service facts, never persisting them as Session events.
   * @param agent - public Agent whose Session scopes product queries.
   * @param selection - current Agent-owned route reference.
   * @returns Snapshot product facts from public registries and projections.
   */
  project(agent: AgentHandle['agent'], selection: ModelSelectionRef): ProductState {
    const jobs = this.ctx.get('jobs')?.list(agent.id)
    const plan = this.ctx.get('planMode')?.get(agent)
    const todos = this.ctx.get('sessionProjections')?.stateOf(agent.session, 'todos')
    const children = this.descendants.get(agent.id)
    const detail = this.details.get(agent.id)
    return {
      ...(selection.current === undefined ? {} : {
        model: { provider: selection.current.provider, model: selection.current.model },
      }),
      ...(plan ? { plan } : {}),
      ...(todos === undefined || todos === null ? {} : {
        tasks: todos.map(todo => ({
          id: 'todo.' + createHash('sha256').update(todo.content).digest('hex').slice(0,16),
          text: todo.content, status: todo.status,
        })),
      }),
      ...(jobs ? { jobs: jobs.map(job => ({
        id: String(job.id), label: job.label, status: job.status,
        ...(job.progress ? { progress: job.progress } : {}),
        ...(job.detail ? { detail: job.detail } : {}),
      })) } : {}),
      ...(children === undefined ? {} : { children }),
      ...(detail === undefined ? {} : { detail }),
    }
  }
}
