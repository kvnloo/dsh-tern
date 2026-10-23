import { describe, expect, it } from 'vitest'
import { ResourceStack } from '../src/lifecycle.ts'

describe('startup failure and terminal resource ownership', () => {
  it('unwinds every registered owner in reverse order after a connect failure', async () => {
    const calls: string[] = []
    const resources = new ResourceStack()
    const start = async (): Promise<void> => {
      resources.add(() => { calls.push('signal') })
      resources.add(() => { calls.push('model-listener') })
      throw new Error('Tern surface open failed')
    }
    await expect(start()).rejects.toThrow('Tern surface open failed')
    await resources.close()
    expect(calls).toEqual(['model-listener', 'signal'])
  })

  it('attempts subsequent release callbacks even when an earlier release fails', async () => {
    const resources = new ResourceStack()
    const calls: string[] = []
    resources.add(() => { calls.push('agent.dispose') })
    resources.add(async () => { calls.push('terminal.close'); throw new Error('pty closed') })
    await expect(resources.close()).rejects.toThrow('TUI resource cleanup failed')
    expect(calls).toEqual(['terminal.close', 'agent.dispose'])
    await resources.close()
    expect(calls).toHaveLength(2)
  })
})
