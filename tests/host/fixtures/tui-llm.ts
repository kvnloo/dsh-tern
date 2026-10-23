/**
 * Keyless real-Agent fixture: only the provider is deterministic. Agent,
 * Session, tools, approvals and the public dsh tui profile remain production.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm'

class TuiFixtureAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    if (provider !== 'tui-fixture') throw new Error('unknown TUI fixture provider: ' + provider)
    return { id: provider, name: 'TUI keyless fixture' }
  }

  override listModels(provider: string) {
    if (provider !== 'tui-fixture') return Promise.resolve([])
    return Promise.resolve([{ provider, id: 'deterministic', name: 'Deterministic', inputModalities: ['text'] as const }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model, inputModalities: ['text'],
      context: { contextWindow: 8_192 },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.findLastIndex(message =>
      message.role === 'user' && message.source?.kind === 'user')
    const turn = options.messages.slice(last)
    const text = turn.filter(message => message.role === 'user' && message.source?.kind === 'user')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      .join('\n')
    if (text.includes('[failure]')) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'speculative, must not commit' }
      throw new Error('intentional keyless fixture stream failure')
    }
    if (text.includes('[tool]') && !turn.some(message => message.role === 'tool')) {
      const callId = ToolCallId('tui-fixture-tool')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta', index: 0, id: callId, name: 'bash',
        argumentsDelta: '{"command":"printf DSH_TUI_FIXTURE_OK"}',
      }
      yield {
        type: 'block-end', index: 0,
        block: { type: 'tool-call', id: callId, name: 'bash',
          arguments: '{"command":"printf DSH_TUI_FIXTURE_OK"}' },
      }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 9 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const answer = text.includes('[tool]') ? 'tool settled: DSH_TUI_FIXTURE_OK' : 'echo: ' + text
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const part of [answer.slice(0, 5), answer.slice(5)]) {
      yield { type: 'text-delta', index: 0, text: part }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'tui-fixture-llm'
export const inject = ['llm']

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['tui-fixture'], new TuiFixtureAdapter())
}
