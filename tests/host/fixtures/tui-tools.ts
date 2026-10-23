/**
 * Test-only public tool provider. The real tools registry and ApprovalService
 * own dispatch and decisions; this provider performs no shell execution.
 */
import { existsSync, watch } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'

/**
 * Explicit, test-only handoff: the real tool is already running, but the
 * approval has not yet taken composer ownership. No timeouts or polling.
 * The private PTY driver atomically creates a release file after real keys
 * have populated the draft and moved its caret.
 */
async function approvalBarrier(workspace: string, signal: AbortSignal): Promise<void> {
  const release = join(workspace, 'approval-release.barrier')
  await writeFile(join(workspace, 'approval-waiting.barrier'), 'waiting\n', {
    mode: 0o600, flag: 'wx',
  })
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const watcher = watch(workspace, () => {
      if (existsSync(release)) finish()
    })
    const abort = (): void => { finish(new Error('fixture approval barrier aborted')) }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      watcher.close()
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else if (existsSync(release)) finish()
  })
}

export const name = 'tui-fixture-tools'
export const inject = ['tools', 'approval']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'tui_fixture_effect',
    description: 'Exercise a keyless, workspace-local fixture effect with real approval.',
    parameters: {
      action: { type: 'string', required: true, enum: ['echo', 'approval'] },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          output: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.output }],
    },
    async execute(args, exec) {
      if (args.action === 'echo') {
        return { status: 'complete', output: 'DSH_TUI_FIXTURE_OK' }
      }
      if (!exec.agent) throw new Error('fixture approval requires the real calling Agent')
      const workspace = process.env.DSH_TUI_TEST_WORKSPACE
      if (!workspace || !isAbsolute(workspace)) {
        throw new Error('fixture effect requires an absolute isolated DSH_TUI_TEST_WORKSPACE')
      }
      if (process.env.DSH_TUI_APPROVAL_BARRIER === '1') {
        await approvalBarrier(workspace, exec.signal)
      }
      const result = await ctx.approval.request({
        agent: exec.agent,
        callId: exec.callId,
        toolName: 'tui_fixture_effect',
        reason: 'Write a harmless marker in the isolated fixture workspace',
        signal: exec.signal,
      })
      if (result !== 'allowed-once' || exec.signal.aborted) {
        const outcome = exec.signal.aborted ? 'cancelled' : result
        return { status: outcome, output: 'approval ' + outcome }
      }
      // No path from the model or external workspace is accepted.
      // An existing marker fails closed rather than being overwritten.
      await writeFile(join(workspace, 'approval-allowed.marker'), 'allowed-once\n', {
        mode: 0o600, flag: 'wx',
      })
      return { status: 'allowed', output: 'approval allowed' }
    },
  }))
}
