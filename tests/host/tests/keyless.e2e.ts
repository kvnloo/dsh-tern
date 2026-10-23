/**
 * Real published CLI / Loader / Agent / Session keyless conformance.
 * The only synthetic participant is a model adapter and, in native tests,
 * a terminal peer that sends real PTY bytes into @stencil-hq/tern.
 */
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch, resolveExampleMode } from '@deepseek-ai/dsh-loader-smoke'

const root = fileURLToPath(new URL('../../../../../../', import.meta.url))
const cli = fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url))
const config = fileURLToPath(new URL('../fixtures/cordis.yml', import.meta.url))
const ptyDriver = fileURLToPath(new URL('../harness/pty_driver.py', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))

const launch = resolveExampleLaunch({
  srcBin: cli, mode: resolveExampleMode(), sourceImport: 'tsx/esm', tsconfigPath: tsconfig,
})

type Step =
  | { wait: string; timeout_sec?: number }
  | { write: string }
  | { hex: string }
  | { event: Record<string, unknown> }
  | { osc877: Record<string, unknown> }
  | { sleep_ms: number }
  | { resize: [number, number] }
  | { signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' }

interface PtyResult {
  readonly exit_code: number | null
  readonly timed_out: boolean
  readonly hello_sent: boolean
  readonly acks: number
  readonly output: string
  readonly failure?: string
}

interface DurableRecord {
  readonly type?: string
  readonly id?: string
  readonly data?: Record<string, unknown>
}

interface Durable {
  readonly id: string
  readonly events: readonly DurableRecord[]
}

function testEnvironment(privateDir: string): Record<string, string> {
  const inherited = process.env
  const keys = ['PATH', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'TMPDIR', 'TZ']
  const preserved = Object.fromEntries(keys.flatMap(key =>
    inherited[key] === undefined ? [] : [[key, inherited[key]!]]))
  return {
    ...preserved,
    ...Object.fromEntries(Object.entries(launch.env).filter(([key, value]) =>
      value !== undefined && (key === 'TSX_TSCONFIG_PATH'))),
    HOME: join(privateDir, 'home'),
    XDG_CONFIG_HOME: join(privateDir, 'config'),
    XDG_CACHE_HOME: join(privateDir, 'cache'),
    DSH_HOME: join(privateDir, 'dsh'),
    DSH_AGENTS_HOME: join(privateDir, 'agents'),
    DSH_TUI_TEST_STORE: join(privateDir, 'sessions'),
    DSH_TSP_RECORD: join(privateDir, 'metadata.jsonl'),
    DSH_TSP_RECORD_FULL: join(privateDir, 'full-wire.jsonl'),
    DSH_TELEMETRY_DISABLED: '1',
    TERN_TSP: '1',
    TERM: 'xterm-256color',
  }
}

async function execute(
  privateDir: string,
  label: string,
  mode: 'ansi' | 'native' | 'osc-hello' | 'da1' | 'late-hello',
  steps: readonly Step[],
  options: { shorthand?: boolean; sessionId?: string; timeoutSec?: number; nativeDisabled?: boolean } = {},
): Promise<PtyResult> {
  const args = options.shorthand ? ['tui'] : ['--profile', 'tui']
  const command = [
    ...launch.args, ...args, '--patch', config,
    ...(options.nativeDisabled ? ['--no-native'] : []),
    ...(options.sessionId ? ['--session-id', options.sessionId] : []),
  ]
  const specification = {
    argv: [launch.command, ...command],
    cwd: root,
    env: testEnvironment(privateDir),
    mode,
    steps,
    timeout_sec: options.timeoutSec ?? 65,
    output_dir: join(privateDir, label),
    auto_ack: true,
  }
  const result = await execa('python3', [ptyDriver], {
    cwd: root,
    input: JSON.stringify(specification),
    env: testEnvironment(privateDir),
    timeout: (options.timeoutSec ?? 65) * 1000 + 10_000,
    killSignal: 'SIGKILL',
    reject: false,
  })
  const failureContext = 'PTY driver ' + label + ' exited ' + String(result.exitCode)
    + '; stderr=' + result.stderr + '; stdout=' + result.stdout
  expect(result.timedOut, failureContext).toBe(false)
  expect(result.exitCode, failureContext).toBe(0)
  let response: PtyResult
  try {
    response = JSON.parse(result.stdout) as PtyResult
  } catch (error) {
    throw new Error(failureContext, { cause: error })
  }
  expect(response.failure, response.output).toBeUndefined()
  expect(response.timed_out, response.output).toBe(false)
  return response
}

async function durable(privateDir: string): Promise<Durable> {
  const parent = join(privateDir, 'sessions')
  const candidates = (await readdir(parent, { recursive: true }))
    .filter(path => /^session(?:\.v[1-9]\d*)?\.jsonl$/.test(basename(path)))
    .sort((a, b) => {
      const version = (path: string): number =>
        Number(basename(path).match(/^session\.v(\d+)\.jsonl$/)?.[1] ?? 0)
      return version(b) - version(a)
    })
  expect(candidates.length, 'no physical JSONL Session log in ' + parent).toBeGreaterThan(0)
  const lines = (await readFile(join(parent, candidates[0]!), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line) as DurableRecord)
  expect(lines[0]).toMatchObject({ type: 'session' })
  const id = lines[0]?.id
  expect(typeof id).toBe('string')
  return { id: id!, events: lines.slice(1) }
}

function content(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks.flatMap(block => {
    if (block === null || typeof block !== 'object') return []
    const value = block as { type?: string; text?: string }
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('')
}

function users(log: Durable): string[] {
  return log.events.flatMap(event => {
    if (event.type !== 'user/message') return []
    const data = event.data
    if (!data || typeof data['source'] !== 'object' || data['source'] === null) return []
    if ((data['source'] as { kind?: string }).kind !== 'user') return []
    return [content(data['content'])]
  })
}

function assistants(log: Durable): string[] {
  return log.events.flatMap(event => {
    if (event.type !== 'assistant/message') return []
    const message = event.data?.['message']
    if (!message || typeof message !== 'object') return []
    return [content((message as { content?: unknown }).content)]
  })
}

describe.skipIf(process.platform !== 'linux')('RFC #6 keyless shipped CLI through native Linux PTY', () => {
  it('persists two real Agent turns, never commits a failed stream and resumes across processes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-durable-'))
    await chmod(dir, 0o700)
    try {
      const first = await execute(dir, 'ansi-first', 'ansi', [
        { wait: 'dsh TUI (ANSI)' },
        { write: 'alpha\r' }, { wait: '[dsh] echo: alpha' },
        { write: 'beta\r' }, { wait: '[dsh] echo: beta' },
        { write: '[failure]\r' },
        { wait: 'intentional keyless fixture stream failure' },
        { write: '/quit\r' },
      ], { nativeDisabled: true })
      expect(first.exit_code, first.output).toBe(0)
      const initial = await durable(dir)
      expect(users(initial)).toEqual(['alpha', 'beta', '[failure]'])
      expect(assistants(initial)).toEqual(['echo: alpha', 'echo: beta'])
      expect(initial.events.some(event => event.type === 'turn/end')).toBe(true)
      expect(initial.events.some(event => event.type === 'assistant/attempt')).toBe(true)

      const resumed = await execute(dir, 'ansi-resume', 'ansi', [
        { wait: 'dsh TUI (ANSI)' },
        { wait: '[you] alpha' },
        { wait: '[dsh] echo: beta' },
        { write: 'gamma\r' }, { wait: '[dsh] echo: gamma' },
        { write: '/quit\r' },
      ], { shorthand: true, nativeDisabled: true, sessionId: initial.id })
      expect(resumed.exit_code, resumed.output).toBe(0)
      expect(resumed.output).not.toContain('speculative, must not commit')
      const after = await durable(dir)
      expect(after.id).toBe(initial.id)
      expect(users(after)).toEqual(['alpha', 'beta', '[failure]', 'gamma'])
      expect(assistants(after)).toEqual(['echo: alpha', 'echo: beta', 'echo: gamma'])
      expect(after.events.length).toBeGreaterThan(initial.events.length)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 160_000)

  it('routes raw multi-key packets, split UTF-8, delete/move and bracketed multiline paste through the REAL SDK into one durable input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-raw-keys-'))
    await chmod(dir, 0o700)
    try {
      const result = await execute(dir, 'native-raw', 'native', [
        { wait: '\x1b_tsp;o;' },
        { write: 'xyzQ' },
        { hex: '1b5b44' },
        { hex: '1b5b337e' },
        { hex: 'f09f' }, { hex: '9880' },
        { hex: '1b5b3230307e' },
        { write: '\nsecond line' },
        { hex: '1b5b3230317e' },
        { hex: '0d' },
        { wait: 'echo: xyz' },
        { event: {
          ev: 'send', sf: 'dsh', id: 'dock.composer.line.input',
          text: 'atomic\nsend',
        } },
        { wait: 'echo: atomic' },
        { write: '/quit\r' },
      ])
      expect(result.exit_code, result.output).toBe(0)
      expect(result.hello_sent).toBe(true)
      expect(result.acks).toBeGreaterThan(0)
      const persisted = await durable(dir)
      expect(users(persisted)).toEqual(['xyz😀\nsecond line', 'atomic\nsend'])
      expect(assistants(persisted)).toEqual([
        'echo: xyz😀\nsecond line', 'echo: atomic\nsend',
      ])
      expect(users(persisted).filter(text => text === 'xyz😀\nsecond line')).toHaveLength(1)
      expect(users(persisted).filter(text => text === 'atomic\nsend')).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 130_000)

  it('falls back to real ANSI when Tern answers DA1 first or when native is explicitly disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-da1-'))
    await chmod(dir, 0o700)
    try {
      const da1 = await execute(dir, 'da1-first', 'late-hello', [
        { wait: 'dsh TUI (ANSI)' },
        { write: 'fallback\r' },
        { wait: '[dsh] echo: fallback' },
        { write: '/quit\r' },
      ])
      expect(da1.exit_code, da1.output).toBe(0)
      expect(users(await durable(dir))).toEqual(['fallback'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 100_000)

  it('restores terminal ownership after a real protocol error and exits nonzero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-fault-'))
    await chmod(dir, 0o700)
    try {
      const failed = await execute(dir, 'native-error', 'native', [
        { wait: '\x1b_tsp;o;' },
        { event: { ev: 'error', sf: 'dsh', msg: 'injected PTY surface failure' } },
        { wait: 'injected PTY surface failure' },
      ])
      expect(failed.exit_code, failed.output).toBe(1)
      expect(failed.output).toContain('\x1b[?2004l')
      expect(failed.output).toContain('\x1b[<u')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 100_000)

  it('fences split post-prompt TSP replies and invalid frames in the real ANSI Session user event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-late-ansi-'))
    await chmod(dir, 0o700)
    const hello = {
      r: 'hello', v: 1, term: 'tern', ver: '0.1.0',
      kinds: ['text', 'row', 'col', 'editor'], features: ['edit', 'send'],
      apc: 4096, credits: 2, cols: 80, cell: { w: 8, h: 16 },
      dark: true, reduceMotion: false,
    }
    const json = JSON.stringify(hello)
    const intended = 'preé-mid🌱post'
    try {
      const result = await execute(dir, 'ansi-late-frames', 'late-hello', [
        // The banner alone is not input readiness; wait for readline's real prompt.
        { wait: 'dsh> ' },
        { write: 'pre' },
        { hex: 'c3' }, { hex: 'a9' },
        // Split an APC reply after the fallback is already selected, including
        // a pause inside its JSON. Neither the frame nor its JSON is user text.
        { hex: '1b5f7473703b723b' },
        { write: json.slice(0, 20) },
        { sleep_ms: 65 },
        { write: json.slice(20) + '\x1b\\' },
        { write: '-mid' },
        { write: '\x1b_tsp;r;' + JSON.stringify({ ...hello, v: 99 }) + '\x1b\\' },
        { write: '\x1b_tsp;e;{broken-json}\x1b\\' },
        { write: '\x1b_tsp;r;{"r":"hello","v":1,"term":"foreign"}\x1b\\' },
        // OSC 877 is the same SDK-maintained input seam, also split.
        { hex: '1b5d3837373b7473703b723b' },
        { write: json.slice(0, 9) },
        { write: json.slice(9) + '\x1b\\' },
        // A plain Escape must remain a key; a split UTF-8 scalar must survive.
        { hex: '1b' }, { sleep_ms: 650 },
        { hex: 'f09f' }, { hex: '8cb1' },
        { write: 'post\r' },
        { wait: '[dsh] echo: ' + intended },
        { write: '/quit\r' },
      ])
      expect(result.exit_code, result.output).toBe(0)
      const saved = await durable(dir)
      expect(users(saved)).toEqual([intended])
      expect(assistants(saved)).toEqual(['echo: ' + intended])
      // Context/instruction user/message records remain durable; only source.kind=user
      // is an actual submitted intent. Keep the exact-one isolation witness.
      expect(users(saved)).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('handles ANSI Ctrl-D EOF and native SIGTERM without leaving the terminal held', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-terminal-end-'))
    await chmod(dir, 0o700)
    try {
      const eof = await execute(dir, 'ansi-eof', 'ansi', [
        { wait: 'dsh> ' }, { hex: '04' },
      ], { nativeDisabled: true, timeoutSec: 15 })
      expect(eof.exit_code, eof.output).toBe(0)
      const signalled = await execute(dir, 'native-term', 'native', [
        { wait: '\x1b_tsp;o;' }, { signal: 'SIGTERM' },
      ], { timeoutSec: 15 })
      expect(signalled.exit_code, signalled.output).toBe(0)
      expect(signalled.output).toContain('\x1b[?2004l')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 90_000)
})
