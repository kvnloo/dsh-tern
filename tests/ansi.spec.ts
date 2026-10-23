import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { AnsiTerminal } from '../src/ansi.ts'
import type { Snapshot } from '../src/model.ts'

const active: AnsiTerminal[] = []
afterEach(async () => { for (const terminal of active.splice(0)) await terminal.closed() })

function fixture(isTTY = false) {
  const stdin = Object.assign(new PassThrough(), { isTTY })
  const stdout = Object.assign(new PassThrough(), { isTTY, columns: 80 })
  let text = ''
  stdout.on('data', data => { text += String(data) })
  const terminal = new AnsiTerminal({ stdin, stdout })
  active.push(terminal)
  return { stdin, terminal, output: () => text }
}
const snapshot: Snapshot = {
  sessionId: 'test', status: 'idle', draft: '', cursor: 0, live: '', notice: '',
  entries: [{ id: 'event.1', kind: 'assistant', text: 'answer' }],
}

describe('ANSI fallback does not require a Tern SDK', () => {
  it('renders each durable row once and accepts multiple turns', async () => {
    const f = fixture()
    const received: string[] = []
    await f.terminal.start(value => received.push(value), () => {}, () => {})
    f.terminal.update(snapshot)
    f.terminal.update(snapshot)
    expect(f.output().split('[dsh] answer')).toHaveLength(2)
    f.stdin.write('first\n')
    f.stdin.write('second\n')
    await new Promise(resolve => setImmediate(resolve))
    expect(received).toEqual(['first', 'second'])
  })

  it('routes approval input away from ordinary user submission', async () => {
    const f = fixture()
    const received: string[] = []
    await f.terminal.start(value => received.push(value), () => {}, () => {})
    const answer = f.terminal.ask({
      title: 'Allow?', choices: [
        { label: 'Allow once', value: 'allowed-once' },
        { label: 'Deny', value: 'rejected' },
      ],
    })
    f.stdin.write('2\n')
    expect(await answer).toBe('rejected')
    expect(received).toEqual([])
    f.stdin.write('real user turn\n')
    await new Promise(resolve => setImmediate(resolve))
    expect(received).toEqual(['real user turn'])
  })

  it('isolates a midline composer from approval and restores the draft after answering', async () => {
    const f = fixture()
    const received: string[] = []
    await f.terminal.start(text => received.push(text), () => {}, () => {})
    f.stdin.write('unsent')
    await new Promise(resolve => setImmediate(resolve))
    const answer = f.terminal.ask({
      title: 'Allow?', choices: [
        { label: 'Allow once', value: 'allowed-once' },
        { label: 'Deny', value: 'rejected' },
      ],
    })
    f.stdin.write('2\n')
    expect(await answer).toBe('rejected')
    expect(received).toEqual([])
    f.stdin.write(' rest\n')
    await new Promise(resolve => setImmediate(resolve))
    expect(received).toEqual(['unsent rest'])
  })

  it('restores a TTY draft and caret through public readline writes', async () => {
    const f = fixture(true)
    const received: string[] = []
    await f.terminal.start(value => received.push(value), () => {}, () => {})
    f.stdin.write('AC')
    f.stdin.write('\x1b[D')
    await new Promise(resolve => setImmediate(resolve))
    const answer = f.terminal.ask({
      title: 'Allow?', choices: [{ label: 'Deny', value: 'rejected' }],
    })
    f.stdin.write('1\r')
    expect(await answer).toBe('rejected')
    f.stdin.write('B\r')
    await new Promise(resolve => setImmediate(resolve))
    expect(received).toEqual(['ABC'])
  })

  it('restores a piped partial draft after a cancelled question', async () => {
    const f = fixture()
    const received: string[] = []
    await f.terminal.start(value => received.push(value), () => {}, () => {})
    f.stdin.write('before')
    await new Promise(resolve => setImmediate(resolve))
    const controller = new AbortController()
    const answer = f.terminal.ask({ title: 'Approve?', signal: controller.signal })
    controller.abort()
    expect(await answer).toBeNull()
    f.stdin.write(' after\n')
    await new Promise(resolve => setImmediate(resolve))
    expect(received).toEqual(['before after'])
  })

  it('keeps split UTF-8 pending bytes owned by the ordinary piped draft', async () => {
    const f = fixture()
    const received: string[] = []
    await f.terminal.start(value => received.push(value), () => {}, () => {})
    const unicode = Buffer.from('é', 'utf8')
    f.stdin.write(unicode.subarray(0, 1))
    const answer = f.terminal.ask({
      title: 'Allow?', choices: [{ label: 'No', value: 'rejected' }],
    })
    f.stdin.write('1\n')
    expect(await answer).toBe('rejected')
    f.stdin.write(unicode.subarray(1))
    f.stdin.write(' sent\n')
    await new Promise(resolve => setImmediate(resolve))
    expect(received).toEqual(['é sent'])
  })

  it('offers every choice and accepts a multi-select comma answer', async () => {
    const f = fixture()
    await f.terminal.start(() => {}, () => {}, () => {})
    const answer = f.terminal.ask({
      title: 'Choose', multiple: true, choices: [
        { label: 'Alpha', value: 'Alpha' },
        { label: 'Beta', value: 'Beta' },
        { label: 'Gamma', value: 'Gamma' },
      ],
    })
    expect(f.output()).toContain('3) Gamma')
    f.stdin.write('1, 3\n')
    expect(await answer).toBe('1, 3')
  })

  it('abort resolves unanswered requests as null without routing input', async () => {
    const f = fixture()
    await f.terminal.start(() => { throw Error('incorrect user submission') }, () => {}, () => {})
    const controller = new AbortController()
    const answer = f.terminal.ask({ title: 'Approval?', signal: controller.signal })
    controller.abort()
    expect(await answer).toBeNull()
  })
})
