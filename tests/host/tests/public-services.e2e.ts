/**
 * RFC #6 Layer 2/3: shipped CLI + real Agent/Session/approval/questions/tools
 * over an actual PTY. Only the model and inert fixture tool are scripted.
 * No synthetic TUI runtime, fake Session event, or provider credentials.
 */
import { access, chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch, resolveExampleMode } from '@deepseek-ai/dsh-loader-smoke'

const root = fileURLToPath(new URL('../../../../../../', import.meta.url))
const cli = fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url))
const config = fileURLToPath(new URL('../fixtures/cordis.yml', import.meta.url))
const driver = fileURLToPath(new URL('../harness/pty_driver.py', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const launch = resolveExampleLaunch({
  srcBin: cli, mode: resolveExampleMode(), sourceImport: 'tsx/esm', tsconfigPath: tsconfig,
})

type Step =
  | { wait: string; timeout_sec?: number }
  | { wait_after: string; timeout_sec?: number }
  | { write: string }
  | { hex: string }
  | { event: Record<string, unknown> }
  | { action: string }
  | { answer: string }
  | { capture: string }

interface PtyResult {
  exit_code: number | null
  timed_out: boolean
  hello_sent: boolean
  acks: number
  output: string
  failure?: string
  actions_sent?: { label: string; id: string }[]
  captures?: Record<string, { byte_offset: number; frame_count: number }>
}

interface RecordEvent {
  type?: string
  id?: string
  data?: Record<string, unknown>
}
interface History {
  id: string
  events: RecordEvent[]
}

function isolatedEnv(dir: string): Record<string, string> {
  const parent = process.env
  const keys = ['PATH', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'TMPDIR', 'TZ']
  const inherited = Object.fromEntries(keys.flatMap(key =>
    parent[key] === undefined ? [] : [[key, parent[key]!]]))
  return {
    ...inherited,
    ...Object.fromEntries(Object.entries(launch.env).filter(([key, value]) =>
      key === 'TSX_TSCONFIG_PATH' && value !== undefined)),
    HOME: join(dir, 'home'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    DSH_HOME: join(dir, 'dsh'),
    DSH_AGENTS_HOME: join(dir, 'agents'),
    DSH_TUI_TEST_STORE: join(dir, 'sessions'),
    DSH_TUI_TEST_WORKSPACE: dir,
    DSH_TSP_RECORD: join(dir, 'metadata.jsonl'),
    DSH_TSP_RECORD_FULL: join(dir, 'full-wire.jsonl'),
    DSH_TELEMETRY_DISABLED: '1',
    TERN_TSP: '1',
    TERM: 'xterm-256color',
  }
}

async function workspace<T>(tag: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-public-' + tag + '-'))
  await chmod(dir, 0o700)
  let completed = false
  try {
    const result = await run(dir)
    completed = true
    return result
  } finally {
    if (completed) await rm(dir, { recursive: true, force: true })
    else process.stderr.write('STRICT RED: private PTY and Session evidence retained in ' + dir + '\n')
  }
}

async function execute(
  dir: string, label: string, mode: 'ansi' | 'native',
  steps: readonly Step[],
  options: { sessionId?: string; timeoutSec?: number } = {},
): Promise<PtyResult> {
  const env = isolatedEnv(dir)
  const argv = [
    launch.command, ...launch.args, '--profile', 'tui', '--patch', config,
    ...(mode === 'ansi' ? ['--no-native'] : []),
    ...(options.sessionId ? ['--session-id', options.sessionId] : []),
  ]
  const spec = {
    argv, cwd: root, env, mode, steps, auto_ack: true,
    output_dir: join(dir, label), timeout_sec: options.timeoutSec ?? 65,
  }
  const result = await execa('python3', [driver], {
    cwd: root, input: JSON.stringify(spec), env,
    timeout: (options.timeoutSec ?? 65) * 1000 + 10_000,
    killSignal: 'SIGKILL', reject: false,
  })
  const context = 'PTY driver ' + label + ': exit=' + result.exitCode
    + ', stderr=' + result.stderr + ', stdout=' + result.stdout
  expect(result.timedOut, context).toBe(false)
  expect(result.exitCode, context).toBe(0)
  let response: PtyResult
  try {
    response = JSON.parse(result.stdout) as PtyResult
  } catch (error) {
    throw new Error(context, { cause: error })
  }
  expect(response.failure, response.output).toBeUndefined()
  expect(response.timed_out, response.output).toBe(false)
  return response
}

async function history(dir: string): Promise<History> {
  const parent = join(dir, 'sessions')
  const candidates = (await readdir(parent, { recursive: true }))
    .filter(path => /^session(?:\.v[1-9]\d*)?\.jsonl$/.test(basename(path)))
    .sort((a, b) => {
      const version = (path: string): number =>
        Number(basename(path).match(/^session\.v(\d+)\.jsonl$/)?.[1] ?? 0)
      return version(b) - version(a)
    })
  expect(candidates.length, 'missing real persisted Session under ' + parent).toBeGreaterThan(0)
  const records = (await readFile(join(parent, candidates[0]!), 'utf8')).trim()
    .split('\n').map(line => JSON.parse(line) as RecordEvent)
  expect(records[0]).toMatchObject({ type: 'session' })
  expect(typeof records[0]?.id).toBe('string')
  return { id: records[0]!.id!, events: records.slice(1) }
}

function content(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks.flatMap(block => {
    if (!block || typeof block !== 'object') return []
    const item = block as { type?: string; text?: string }
    return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  }).join('')
}

function users(log: History): string[] {
  return log.events.flatMap(event => {
    if (event.type !== 'user/message') return []
    const source = event.data?.['source']
    if (!source || typeof source !== 'object' || (source as { kind?: string }).kind !== 'user') return []
    return [content(event.data?.['content'])]
  })
}

function committed(log: History): string[] {
  return log.events.flatMap(event => {
    if (event.type !== 'assistant/message') return []
    const message = event.data?.['message']
    return message && typeof message === 'object'
      ? [content((message as { content?: unknown }).content)] : []
  })
}

interface Pair {
  id: string
  name: string
  result: RecordEvent
}
function toolPairs(log: History): Pair[] {
  const calls = log.events.filter(event => event.type === 'tool/call')
  const results = log.events.filter(event => event.type === 'tool/result')
  return calls.map(call => {
    const id = call.data?.['callId']
    expect(typeof id, 'tool/call must carry its real identity').toBe('string')
    const matches = results.filter(result => {
      const message = result.data?.['message']
      return message && typeof message === 'object'
        && (message as { toolCallId?: unknown }).toolCallId === id
    })
    expect(matches, 'exactly one durable tool/result for call ' + String(id)).toHaveLength(1)
    return { id: id as string, name: String(call.data?.['name']), result: matches[0]! }
  })
}

function toolOutput(pair: Pair): string {
  const message = pair.result.data?.['message']
  if (!message || typeof message !== 'object') return ''
  return content((message as { content?: unknown }).content)
}

function approvalPair(log: History, expected: string): void {
  const asked = log.events.filter(event => event.type === 'approval/asked')
  const decided = log.events.filter(event => event.type === 'approval/decided')
  expect(asked).toHaveLength(1)
  expect(decided).toHaveLength(1)
  expect(asked[0]?.data?.['id']).toBe(decided[0]?.data?.['id'])
  expect(asked[0]?.data?.['callId']).toBe(toolPairs(log)[0]?.id)
  expect(asked[0]?.data?.['toolName']).toBe('tui_fixture_effect')
  expect(decided[0]?.data?.['outcome']).toBe(expected)
}

async function markerExists(dir: string): Promise<boolean> {
  try {
    await access(join(dir, 'approval-allowed.marker'))
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function frames(output: string): Record<string, unknown>[] {
  return Array.from(output.matchAll(/\x1b_tsp;f;([\s\S]*?)\x1b\\/g)).map(
    match => JSON.parse(match[1]!) as Record<string, unknown>)
}

function allAddedIds(output: string): string[] {
  const visit = (value: unknown): string[] => {
    if (!value || typeof value !== 'object') return []
    const node = value as { id?: unknown; c?: unknown }
    return [
      ...(typeof node.id === 'string' ? [node.id] : []),
      ...(Array.isArray(node.c) ? node.c.flatMap(visit) : []),
    ]
  }
  return frames(output).flatMap(frame => {
    if (!Array.isArray(frame['ops'])) return []
    return frame['ops'].flatMap(op =>
      Array.isArray(op) && op[0] === 'add' ? visit(op[4]) : [])
  })
}

function expectOneStableToolCard(run: PtyResult, callId: string): void {
  const id = 'main.tool.' + callId
  const added = allAddedIds(run.output)
  expect(added.filter(item => item === id), 're-added/orphan native tool card: ' + id)
    .toHaveLength(1)
  const wire = JSON.stringify(frames(run.output))
  expect(wire).toContain(id)
  expect(wire).toContain('Running tui_fixture_effect')
  expect(wire).toContain('Tool result: DSH_TUI_FIXTURE_OK')
  expect(wire).not.toContain('Interrupted tui_fixture_effect')
}

function expectBlockedComposer(run: PtyResult): void {
  const count = run.captures?.['blocked']?.frame_count
  expect(typeof count, 'no native prompt checkpoint').toBe('number')
  const openFrames = frames(run.output).slice(0, count)
  // This must be emitted by the real SDK on the normal composer while a
  // production service owns the prompt; a fake UI event cannot satisfy it.
  expect(JSON.stringify(openFrames)).toContain('"sendable":false')
}

const nativeDraft: Step[] = [
  { wait: '\x1b_tsp;o;' },
  { write: 'α😀' },
  { hex: '1b5b3230307e' }, { write: '\nsecondZ' }, { hex: '1b5b3230317e' },
  { wait: 'secondZ' },
  { hex: '1b5b44' }, // real SDK Left: caret immediately before Z
]
const nativeSend = (text: string): Step => ({
  event: { ev: 'send', sf: 'dsh', id: 'dock.composer.line.input', text },
})
const nativeExit: Step = { write: '/quit\r' }

describe.skipIf(process.platform !== 'linux')('RFC #6 real public-service keyless acceptance over shipped PTY', () => {
  it('renders start/output/completion from real tool execution on ANSI, distinct across consecutive calls', () =>
    workspace('ansi-tool', async dir => {
      const run = await execute(dir, 'ansi', 'ansi', [
        { wait: 'dsh TUI (ANSI)' },
        { write: '[tool]\r' },
        { wait: '[tool] Running tui_fixture_effect' },
        { wait: 'Tool result: DSH_TUI_FIXTURE_OK' },
        { write: '[tool]\r' },
        { wait_after: 'Tool result: DSH_TUI_FIXTURE_OK' },
        { write: '/quit\r' },
      ])
      expect(run.exit_code, run.output).toBe(0)
      const log = await history(dir)
      expect(users(log)).toEqual(['[tool]', '[tool]'])
      const pairs = toolPairs(log)
      expect(pairs).toHaveLength(2)
      expect(new Set(pairs.map(pair => pair.id)).size).toBe(2)
      for (const pair of pairs) {
        expect(pair.name).toBe('tui_fixture_effect')
        expect(toolOutput(pair)).toBe('DSH_TUI_FIXTURE_OK')
      }
      expect(committed(log)).toEqual(['tool settled', 'tool settled'])
      expect(run.output).not.toContain('Interrupted tui_fixture_effect')
    }), 155_000)

  it('updates exactly one native logical tool card and uses new real call IDs after process resume', () =>
    workspace('native-tool', async dir => {
      const first = await execute(dir, 'native-first', 'native', [
        { wait: '\x1b_tsp;o;' },
        nativeSend('[tool]'),
        { wait: 'Running tui_fixture_effect' },
        { wait: 'Tool result: DSH_TUI_FIXTURE_OK' },
        nativeExit,
      ])
      expect(first.exit_code, first.output).toBe(0)
      expect(first.hello_sent).toBe(true)
      expect(first.acks).toBeGreaterThan(0)
      const initial = await history(dir)
      expect(toolPairs(initial)).toHaveLength(1)
      expectOneStableToolCard(first, toolPairs(initial)[0]!.id)
      const resumed = await execute(dir, 'native-resumed', 'native', [
        { wait: '\x1b_tsp;o;' },
        nativeSend('[tool]'),
        { wait: 'Running tui_fixture_effect' },
        { wait: 'Tool result: DSH_TUI_FIXTURE_OK' },
        nativeExit,
      ], { sessionId: initial.id })
      expect(resumed.exit_code, resumed.output).toBe(0)
      const after = await history(dir)
      expect(after.id).toBe(initial.id)
      expect(users(after)).toEqual(['[tool]', '[tool]'])
      const pairs = toolPairs(after)
      expect(pairs).toHaveLength(2)
      expect(new Set(pairs.map(pair => pair.id)).size).toBe(2)
      expectOneStableToolCard(resumed, pairs[1]!.id)
      for (const pair of pairs) expect(toolOutput(pair)).toBe('DSH_TUI_FIXTURE_OK')
    }), 160_000)

  it('denies a real public approval by keyboard without executing its effect or losing a Unicode/multiline caret', () =>
    workspace('approval-deny', async dir => {
      const run = await execute(dir, 'native-denied', 'native', [
        ...nativeDraft,
        nativeSend('[approval-deny]'),
        { wait: 'Allow once: tui_fixture_effect?' },
        { capture: 'blocked' },
        { write: '2' }, // native PTY keyboard: Deny
        { wait: 'Tool result: approval rejected' },
        { write: '!' }, { hex: '0d' },
        { wait: 'echo: α' },
        nativeExit,
      ])
      expect(run.exit_code, run.output).toBe(0)
      expectBlockedComposer(run)
      const log = await history(dir)
      expect(users(log)).toEqual(['[approval-deny]', 'α😀\nsecond!Z'])
      approvalPair(log, 'rejected')
      expect(toolOutput(toolPairs(log)[0]!)).toBe('approval rejected')
      expect(await markerExists(dir)).toBe(false)
    }), 160_000)

  it('accepts a fresh real negotiated el(button) ACTION through ApprovalService, not a forged event', () =>
    workspace('approval-allow', async dir => {
      const run = await execute(dir, 'native-allowed', 'native', [
        ...nativeDraft,
        nativeSend('[approval-allow]'),
        { wait: 'Allow once: tui_fixture_effect?' },
        { capture: 'blocked' },
        { action: 'Allow once' }, // PTY driver resolves exact active SDK id from emitted doc
        { wait: 'Tool result: approval allowed' },
        { write: '!' }, { hex: '0d' },
        { wait: 'echo: α' },
        nativeExit,
      ])
      expect(run.exit_code, run.output).toBe(0)
      expectBlockedComposer(run)
      expect(run.actions_sent).toHaveLength(1)
      expect(run.actions_sent![0]!.label).toMatch(/Allow once$/)
      expect(run.actions_sent![0]!.id).toMatch(/^layer\.request\./)
      const log = await history(dir)
      expect(users(log)).toEqual(['[approval-allow]', 'α😀\nsecond!Z'])
      approvalPair(log, 'allowed-once')
      expect(toolOutput(toolPairs(log)[0]!)).toBe('approval allowed')
      expect(await readFile(join(dir, 'approval-allowed.marker'), 'utf8')).toBe('allowed-once\n')
    }), 160_000)

  it('treats explicit Escape as cancelled (strict RED if the public approval owner maps it to reject)', () =>
    workspace('approval-cancel', async dir => {
      const run = await execute(dir, 'native-cancelled', 'native', [
        ...nativeDraft,
        nativeSend('[approval-cancel]'),
        { wait: 'Allow once: tui_fixture_effect?' },
        { capture: 'blocked' },
        { hex: '1b' }, // Esc, not a fabricated abort signal
        { wait: 'Tool result: approval cancelled' },
        { write: '!' }, { hex: '0d' },
        { wait: 'echo: α' },
        nativeExit,
      ])
      expect(run.exit_code, run.output).toBe(0)
      expectBlockedComposer(run)
      const log = await history(dir)
      approvalPair(log, 'cancelled')
      expect(users(log)).toEqual(['[approval-cancel]', 'α😀\nsecond!Z'])
      expect(await markerExists(dir)).toBe(false)
    }), 160_000)

  it('uses real ANSI ask_user_question service with one durable structured choice', () =>
    workspace('ansi-question', async dir => {
      const run = await execute(dir, 'ansi-choice', 'ansi', [
        { wait: 'dsh TUI (ANSI)' },
        { write: '[question-choice]\r' },
        { wait: 'Choose a fixture option' },
        { wait: 'answer> ' },
        { write: '1\r' },
        { wait: '"selected":["Alpha"]' },
        { write: '/quit\r' },
      ])
      expect(run.exit_code, run.output).toBe(0)
      const log = await history(dir)
      expect(users(log)).toEqual(['[question-choice]'])
      const pairs = toolPairs(log)
      expect(pairs).toHaveLength(1)
      expect(pairs[0]?.name).toBe('ask_user_question')
      expect(JSON.parse(toolOutput(pairs[0]!))).toEqual({
        answers: [{ id: 'choice', selected: ['Alpha'] }],
      })
    }), 140_000)

  it('takes a native keyboard choice and an SDK-native multi/custom answer through the real question owner', () =>
    workspace('native-question', async dir => {
      const first = await execute(dir, 'native-choice', 'native', [
        { wait: '\x1b_tsp;o;' },
        nativeSend('[question-choice]'),
        { wait: 'Choose a fixture option' },
        { write: '2' },
        { wait: '"selected"' },
        nativeExit,
      ])
      expect(first.exit_code, first.output).toBe(0)
      const initial = await history(dir)
      expect(users(initial)).toEqual(['[question-choice]'])
      expect(JSON.parse(toolOutput(toolPairs(initial)[0]!))).toEqual({
        answers: [{ id: 'choice', selected: ['Beta'] }],
      })
      const second = await execute(dir, 'native-multi', 'native', [
        { wait: '\x1b_tsp;o;' },
        nativeSend('[question-multi]'),
        { wait: 'Choose features and optional other text' },
        { answer: 'Alpha, Beta, custom 😀' },
        { wait: '"custom"' },
        nativeExit,
      ], { sessionId: initial.id })
      expect(second.exit_code, second.output).toBe(0)
      expect(second.actions_sent?.[0]?.id).toMatch(/^layer\.request\./)
      const after = await history(dir)
      expect(users(after)).toEqual(['[question-choice]', '[question-multi]'])
      const pairs = toolPairs(after)
      expect(pairs).toHaveLength(2)
      expect(new Set(pairs.map(pair => pair.id)).size).toBe(2)
      expect(JSON.parse(toolOutput(pairs[1]!))).toEqual({
        answers: [{ id: 'multi', selected: ['Alpha', 'Beta'], custom: 'custom 😀' }],
      })
      expect(after.events.filter(event => event.type === 'user/message')).toHaveLength(2)
    }), 170_000)

  it('cancels a real outstanding user-question via Escape without injecting an answer as an Agent message', () =>
    workspace('question-cancel', async dir => {
      const run = await execute(dir, 'native-question-cancel', 'native', [
        { wait: '\x1b_tsp;o;' },
        nativeSend('[question-cancel]'),
        { wait: 'Choose a fixture option' },
        { hex: '1b' },
        { wait: 'user question was cancelled' },
        nativeExit,
      ])
      expect(run.exit_code, run.output).toBe(0)
      const log = await history(dir)
      expect(users(log)).toEqual(['[question-cancel]'])
      const pairs = toolPairs(log)
      expect(pairs).toHaveLength(1)
      const message = pairs[0]?.result.data?.['message']
      expect((message as { isError?: unknown } | undefined)?.isError).toBe(true)
      expect(toolOutput(pairs[0]!)).toContain('user question was cancelled')
      expect(log.events.filter(event => event.type === 'user/message')).toHaveLength(1)
      expect(await markerExists(dir)).toBe(false)
    }), 140_000)

  it('aborts an observed in-flight model stream, commits no speculative reply, and resumes normally', () =>
    workspace('model-abort', async dir => {
      const first = await execute(dir, 'native-abort', 'native', [
        { wait: '\x1b_tsp;o;' },
        nativeSend('[inflight]'),
        { wait: 'SPECULATIVE_INFLIGHT_NOT_DURABLE' },
        { hex: '03' }, // real PTY Ctrl-C while streaming
        { wait_after: 'idle' }, // new renderer idle state, not a wall-clock delay
        nativeSend('after-abort'),
        { wait: 'echo: after-abort' },
        nativeExit,
      ])
      expect(first.exit_code, first.output).toBe(0)
      const log = await history(dir)
      expect(users(log)).toEqual(['[inflight]', 'after-abort'])
      expect(committed(log)).toEqual(['echo: after-abort'])
      expect(log.events.some(event => event.type === 'turn/end')).toBe(true)
      const resumed = await execute(dir, 'ansi-resume', 'ansi', [
        { wait: 'dsh TUI (ANSI)' },
        { wait: '[you] after-abort' },
        { write: 'post-resume\r' },
        { wait: '[dsh] echo: post-resume' },
        { write: '/quit\r' },
      ], { sessionId: log.id })
      expect(resumed.exit_code, resumed.output).toBe(0)
      expect(resumed.output).not.toContain('SPECULATIVE_INFLIGHT_NOT_DURABLE')
      const after = await history(dir)
      expect(after.id).toBe(log.id)
      expect(users(after)).toEqual(['[inflight]', 'after-abort', 'post-resume'])
      expect(committed(after)).toEqual(['echo: after-abort', 'echo: post-resume'])
    }), 175_000)
})
