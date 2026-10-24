#!/usr/bin/env node
/**
 * Exact-head, keyless native Windows acceptance. OS ConPTY owns the real child
 * console. DSH CLI / profile / loader / Agent / Session / services are real.
 * Only the provider and harmless workspace-local tool are scripted by the
 * existing tests/host/fixtures/cordis.yml; Tern's remote peer is in-band.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir, release } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { ConptyPeer, GateFailure, requireGate } from './conpty-peer.mjs'

const require = createRequire(import.meta.url)
let pty
let ptyPackage
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const pluginName = '@kvnloo/dsh-tern'
const expectedHost = '5badb15009ae1756c3afe0ae0cef1faafc290ccc'
const backendMode = process.env.DSH_WINDOWS_CONPTY_BACKEND ?? 'inbox-conpty'
requireGate(['inbox-conpty', 'bundled-conpty-passthrough'].includes(backendMode),
  'unknown explicit ConPTY backend mode')
const useConptyDll = backendMode === 'bundled-conpty-passthrough'
const args = process.argv.slice(2)
const options = new Map()
for (let i = 0; i < args.length; i += 2) {
  requireGate(['--host', '--archive', '--out'].includes(args[i]) && !!args[i + 1],
    'usage: --host ABSOLUTE --archive ABSOLUTE --out ABSOLUTE')
  options.set(args[i], resolve(args[i + 1]))
}
requireGate(options.size === 3 && args.length === 6, 'three Windows gate paths are required')
const host = options.get('--host')
const archive = options.get('--archive')
const out = options.get('--out')
requireGate([host, archive, out].every(isAbsolute), 'all gate paths must be absolute')
mkdirSync(out, { recursive: true, mode: 0o700 })
const cases = []
const evidence = {
  schema: 1,
  qualification: 'windows-os-conpty-native-not-parser-only',
  status: 'RED',
  phase: 'startup',
  inputs: {}, backend: {}, cases,
}
const childRoots = []
let phase = 'startup'

function step(name, fn) {
  phase = name
  evidence.phase = name
  return Promise.resolve().then(fn).then(result => {
    const publicResult = { ...(result ?? {}) }
    delete publicResult.sessionId // Never publish the physical private Session identifier.
    cases.push({ name, status: 'PASS', ...publicResult })
    return result
  })
}

function gitHead(path) {
  return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function gitClean(path) {
  return execFileSync('git', ['-C', path, 'status', '--porcelain', '--untracked-files=no'],
    { encoding: 'utf8' }).trim() === ''
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function backendCheck() {
  pty = require('node-pty')
  ptyPackage = require('node-pty/package.json')
  requireGate(process.platform === 'win32', 'gate requires actual process.platform win32')
  requireGate(Number(process.versions.node.split('.')[0]) >= 24, 'Node >=24 required')
  requireGate(ptyPackage.version === '1.1.0', 'pinned node-pty 1.1.0 is required')
  const addon = require('node-addon-api/package.json')
  requireGate(addon.version === '7.1.0', 'pinned node-addon-api 7.1.0 is required')
  const implementation = readFileSync(join(dirname(require.resolve('node-pty')), 'windowsPtyAgent.js'), 'utf8')
  requireGate(implementation.includes("loadNativeModule('conpty')")
    || implementation.includes('loadNativeModule("conpty")'),
  'node-pty installed Windows backend does not explicitly load native ConPTY')
  requireGate(implementation.includes('startProcess('), 'node-pty native ConPTY startProcess missing')
  // Published v1.1.0 contains a WinPTY fallback. It is not a permitted
  // backend for this gate: each spawned instance must prove _useConpty=true.
  requireGate(implementation.includes("loadNativeModule('pty')")
    && implementation.includes('if (this._useConpty)'),
  'pinned node-pty 1.1.0 ConPTY/WinPTY selector changed')
  const build = Number(release().split('.').at(-1))
  requireGate(Number.isInteger(build) && build >= 18309, 'Windows build does not qualify for OS ConPTY')
  const commit = gitHead(root)
  requireGate(commit === process.env.DSH_WINDOWS_EXPECT_SHA,
    'checkout is not the exact expected plugin PR/push head')
  requireGate(gitHead(host) === expectedHost, 'unmodified pinned DSH host SHA mismatch')
  requireGate(gitClean(host), 'DSH host tracked sources changed')
  requireGate(existsSync(join(host, 'apps', 'cli', 'lib', 'bin.js')),
    'built real DSH host CLI missing')
  requireGate(statSync(archive).isFile() && archive.endsWith('.tgz'), 'packed plugin artifact missing')
  const sdkPatchSha256 = sha256(join(root, 'patches', '@stencil-hq__tern@0.1.0.patch'))
  requireGate(sdkPatchSha256 === 'c222b3495ade7f7b334ae4f5f94be05b2b4edb2764645dd1972f90ad436e0998',
    'qualified production SDK patch SHA256 changed')
  evidence.inputs = {
    pluginRepository: 'kvnloo/dsh-tern',
    pluginGitSha: commit,
    pluginArchiveSha256: sha256(archive),
    hostRepository: 'kvnloo/deepseek-harness',
    hostGitSha: expectedHost,
    hostTrackedClean: true,
    sdkPatchSha256,
  }
  evidence.backend = {
    platform: process.platform, arch: process.arch,
    windowsBuild: build, node: process.version,
    nodePty: ptyPackage.version, nodeAddonApi: addon.version,
    mode: backendMode, useConptyDll,
    backend: useConptyDll ? 'bundled OpenConsole ConPTY passthrough via node-pty'
      : 'inbox kernel32 OS ConPTY via node-pty WindowsTerminal',
  }
  if (useConptyDll) {
    const dependency = dirname(require.resolve('node-pty/package.json'))
    const source = readFileSync(join(dependency, 'src/win/conpty.cc'))
    const sourceBlob = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex')
    requireGate(sourceBlob === '81e9dc7d1e0fc9bf35301200064fe0715eb100c8',
      'bundled passthrough must use the exact reviewed test-only native source')
    const patchSha256 = sha256(join(root, 'tests/windows/node-pty-passthrough.patch'))
    requireGate(patchSha256 === '68ef3401195af62392c04b61b8acbdbb84a39079c733fb0c5ba4d1ef6f1ec84c',
      'test-only native passthrough patch bytes changed')
    evidence.backend.nativeSourceBlob = sourceBlob
    evidence.backend.nativePatchSha256 = patchSha256
    evidence.backend.passthroughFlags = 8
    evidence.backend.conptyAddonSha256 = sha256(join(dependency, 'build/Release/conpty.node'))
    evidence.backend.conptyDllSha256 = sha256(join(dependency, 'build/Release/conpty/conpty.dll'))
    evidence.backend.openConsoleSha256 = sha256(join(dependency, 'build/Release/conpty/OpenConsole.exe'))
    requireGate(evidence.backend.conptyDllSha256 === '7c7430632052ff703540b68371ec43821820aa1335d8e11dfbcd9ff00e9daaed',
      'loaded bundled conpty.dll must match official node-pty 1.1.0 x64 package')
    requireGate(evidence.backend.openConsoleSha256 === 'd1fe7faa62f9e955e2ac2371f95d7e5513df4d496255097158f979c94782c5fc',
      'bundled OpenConsole.exe must match official node-pty 1.1.0 x64 package')
  }
  // A source assertion alone is insufficient; the subsequent preflight and
  // real plugin cases must each observe actual ConPTY child input/output.
  return { versionChecks: 2 }
}

function privateWorkspace(label) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-conpty-' + label + '-'))
  chmodSync(dir, 0o700)
  childRoots.push(dir)
  for (const name of ['home', 'appdata', 'localappdata', 'temp', 'config', 'cache',
    'agents', 'dsh', 'sessions', 'workspace']) {
    mkdirSync(join(dir, name), { recursive: true, mode: 0o700 })
  }
  return {
    dir, profile: join(dir, 'dsh'), workspace: join(dir, 'workspace'),
    sessions: join(dir, 'sessions'),
  }
}

function isolatedEnv(sandbox) {
  const preserve = [
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
  ]
  const env = Object.fromEntries(preserve.flatMap(name =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]]))
  return {
    ...env,
    HOME: join(sandbox.dir, 'home'),
    USERPROFILE: join(sandbox.dir, 'home'),
    APPDATA: join(sandbox.dir, 'appdata'),
    LOCALAPPDATA: join(sandbox.dir, 'localappdata'),
    TMP: join(sandbox.dir, 'temp'),
    TEMP: join(sandbox.dir, 'temp'),
    XDG_CONFIG_HOME: join(sandbox.dir, 'config'),
    XDG_CACHE_HOME: join(sandbox.dir, 'cache'),
    DSH_HOME: sandbox.profile,
    DSH_AGENTS_HOME: join(sandbox.dir, 'agents'),
    DSH_TUI_TEST_STORE: sandbox.sessions,
    DSH_TUI_TEST_WORKSPACE: sandbox.workspace,
    DSH_TELEMETRY_DISABLED: '1',
    TERN_TSP: '1',
    TERM: 'xterm-256color',
  }
}

function spawnConsole(command, argv, sandbox) {
  const terminal = pty.spawn(command, argv, {
    name: 'xterm-256color', cols: 100, rows: 28,
    cwd: sandbox.workspace, env: isolatedEnv(sandbox),
    useConpty: true, useConptyDll,
  })
  // v1.1.0's published WindowsTerminal owns WindowsPtyAgent._useConpty.
  // Assert the *actual spawned* native backend, never mere platform claims.
  requireGate(terminal?._agent?._useConpty === true
    && terminal._agent._useConptyDll === useConptyDll,
  'spawned Windows pseudoterminal was not OS ConPTY (WinPTY is forbidden)')
  if (useConptyDll) {
    const nativeAddon = join(dirname(require.resolve('node-pty/package.json')), 'build/Release/conpty.node')
    requireGate(Object.keys(require.cache).some(path => resolve(path).toLowerCase() === resolve(nativeAddon).toLowerCase()),
      'actual spawned ConPTY must load the rebuilt passthrough addon, never a prebuilt fallback')
  }
  return terminal
}

function cliArgs(extra = []) {
  const config = join(root, 'tests', 'host', 'fixtures', 'cordis.yml')
  return [join(host, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'tui',
    '--patch', config, ...extra]
}

function installPlugin(sandbox) {
  const launch = [join(host, 'apps', 'cli', 'lib', 'bin.js'),
    'plugin', '--profile', 'tui', 'add', archive]
  const result = spawnSync(process.execPath, launch, {
    cwd: sandbox.workspace, env: isolatedEnv(sandbox),
    encoding: 'utf8', timeout: 600_000, windowsHide: true,
    maxBuffer: 1_000_000,
  })
  requireGate(!result.error && result.status === 0 && !result.signal,
    'ordinary host dsh plugin --profile tui add tarball failed')
  const manifest = JSON.parse(readFileSync(join(sandbox.profile, 'profiles', 'tui', 'package.json'), 'utf8'))
  requireGate(!!manifest.dependencies?.[pluginName],
    'real plugin manager did not install the packed external plugin')
  requireGate(JSON.stringify(manifest.dsh?.profile?.bundles)
    === JSON.stringify(['@deepseek-ai/dsh-base', pluginName]),
  'host profile base+external-plugin layering differs')
  const installed = JSON.parse(readFileSync(join(
    sandbox.profile, 'profiles', 'tui', 'node_modules', '@kvnloo', 'dsh-tern', 'package.json'), 'utf8'))
  requireGate(installed.name === pluginName && installed.dsh?.bundle?.patch === './cordis.patch.yml',
    'host plugin-manager installation does not resolve the real bundle manifest')
}

async function preflight() {
  const sandbox = privateWorkspace('preflight')
  const carrier = '\x1b_tsp;probe;{}\x1b\\'
  const child = spawnConsole(process.execPath, [
    '-e',
    'process.stdout.write("CONPTY_TTY=" + JSON.stringify({ p: process.platform, i: !!process.stdin.isTTY, o: !!process.stdout.isTTY }) + "\\n" + process.argv[1] + "\\nCONPTY_PROBE_END\\n")',
    carrier,
  ], sandbox)
  const peer = new ConptyPeer(child, 'fallback')
  try {
    await peer.waitForExit(20_000)
    requireGate(peer.exit.code === 0, 'native ConPTY preflight process failed')
    requireGate(peer.output.includes('CONPTY_TTY={"p":"win32","i":true,"o":true}'),
      'OS ConPTY did not attach real child stdin and stdout TTY')
    requireGate(peer.output.includes('CONPTY_PROBE_END'), 'ConPTY preflight did not finish its actual output')
    return {
      exitCode: peer.exit.code, childTtyInput: true, childTtyOutput: true,
      // Diagnostic only. The following real DSH native phase must still pass.
      childApcOutputPreserved: peer.output.includes(carrier),
    }
  } finally { await peer.dispose() }
}

function userContent(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('')
}

function durable(sandbox) {
  const paths = readdirSync(sandbox.sessions, { recursive: true })
    .filter(file => /^session(?:\.v[1-9]\d*)?\.jsonl$/.test(basename(file)))
  requireGate(paths.length > 0, 'real persisted Session JSONL was not created')
  paths.sort((a, b) => {
    const version = file => Number(basename(file).match(/^session\.v(\d+)\.jsonl$/)?.[1] ?? 0)
    return version(b) - version(a)
  })
  const lines = readFileSync(join(sandbox.sessions, paths[0]), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line))
  requireGate(lines[0]?.type === 'session' && typeof lines[0].id === 'string',
    'physical Session header is missing')
  const events = lines.slice(1)
  const users = events.filter(item => item.type === 'user/message' && item.data?.source?.kind === 'user')
    .map(item => userContent(item.data.content))
  const assistants = events.filter(item => item.type === 'assistant/message')
    .map(item => userContent(item.data?.message?.content)).filter(Boolean)
  return { id: lines[0].id, events, users, assistants }
}

function assertExact(values, expected, phaseLabel) {
  if (JSON.stringify(values) !== JSON.stringify(expected)) {
    // Only structural counters and hashes escape; never persist Session text.
    const digest = text => createHash('sha256').update(text).digest('hex')
    evidence.sessionMismatch = {
      phaseLabel, actualCount: values.length, expectedCount: expected.length,
      actual: values.map((text, index) => ({
        utf8Bytes: Buffer.byteLength(text), sha256: digest(text),
        exactExpectedIndex: expected.indexOf(text),
        expectedPrefix: typeof expected[index] === 'string' && expected[index].startsWith(text),
        crlfOnlyDifference: typeof expected[index] === 'string'
          && text.replaceAll('\r\n', '\n') === expected[index],
      })),
      expected: expected.map(text => ({ utf8Bytes: Buffer.byteLength(text), sha256: digest(text) })),
    }
  }
  requireGate(JSON.stringify(values) === JSON.stringify(expected), phaseLabel + ': physical Session exact content mismatch')
}

function assertTool(log) {
  const calls = log.events.filter(event => event.type === 'tool/call')
  const results = log.events.filter(event => event.type === 'tool/result')
  requireGate(calls.length === 1 && results.length === 1,
    'real Agent must persist exactly one fixture tool call/result')
  const call = calls[0]
  requireGate(call.data?.name === 'tui_fixture_effect' && typeof call.data?.callId === 'string',
    'real ToolService fixture call identity missing')
  const result = results[0].data?.message
  requireGate(result?.toolCallId === call.data.callId &&
    userContent(result.content) === 'DSH_TUI_FIXTURE_OK',
  'real fixture ToolService result did not match its durable call')
  return call.data.callId
}

function launch(sandbox, extra = [], mode = 'native') {
  const child = spawnConsole(process.execPath, cliArgs(extra), sandbox)
  return new ConptyPeer(child, mode)
}

async function waitNative(peer) {
  try {
    await peer.waitFor(() => peer.queryCount === 1 && peer.opens.some(o => o.id === 'dsh')
      && peer.frames.some(f => f.sf === 'dsh'), 'real OSC877 hello + native semantic surface', 45_000)
    peer.assertTransport()
    requireGate(!peer.output.includes('dsh TUI (ANSI)'), 'unexpected silent ANSI fallback')
  } catch (error) {
    // Do not export raw child output, paths, history or environment.
    evidence.failedNegotiation = {
      ...peer.stats(),
      ansiFallbackObserved: peer.output.includes('dsh TUI (ANSI)'),
      pluginImportFailureObserved: peer.output.includes('failed to import'),
    }
    throw error
  }
}

async function waitNode(peer, condition, name, after = 0, ms = 45_000) {
  await peer.waitFor(() => peer.nodeMatches(condition, after), name, ms)
}

async function finishNative(peer) {
  peer.write('/quit\r')
  await peer.waitForExit(25_000)
  peer.assertClosed()
}

async function nativeOne(sandbox) {
  const peer = launch(sandbox)
  try {
    await waitNative(peer)
    // Real TTY typing + cursor move + delete + Unicode + bracketed multiline
    // paste, not a forged editor event.
    peer.write('xyzQ')
    peer.write('\x1b[D')
    peer.write('\x1b[3~')
    peer.write('😀')
    peer.write('\x1b[200~\nsecond line\x1b[201~')
    await waitNode(peer, {
      id: 'dock.composer.line.input', text: 'xyz😀\nsecond line',
    }, 'native Unicode paste and editing')
    let before = peer.frames.length
    peer.write('\r')
    await waitNode(peer, { contains: 'echo: xyz' },
      'real Agent first native reply', before)
    await waitNode(peer, { id: 'dock.status.label', contains: ' · idle' },
      'first Agent turn settled', before)
    before = peer.frames.length
    peer.sendOsc877('e', {
      ev: 'send', sf: 'dsh', id: 'dock.composer.line.input', text: 'atomic\nsend',
    })
    await waitNode(peer, { contains: 'echo: atomic' },
      'OSC877 atomic native multiline send', before)
    await waitNode(peer, { id: 'dock.status.label', contains: ' · idle' },
      'atomic send turn settled', before)
    before = peer.frames.length
    peer.sendOsc877('e', {
      ev: 'send', sf: 'dsh', id: 'dock.composer.line.input', text: '[tool]',
    })
    await waitNode(peer, { contains: 'Tool result: DSH_TUI_FIXTURE_OK' },
      'real ToolService execution and stable native card', before, 60_000)
    // Tool completion is not the Agent's final text reply. Like the public
    // service gate, observe that reply before reading the physical Session.
    await waitNode(peer, { contains: 'tool settled' },
      'real Agent final reply after tool execution', before, 60_000)
    await waitNode(peer, { id: 'dock.status.label', contains: ' · idle' },
      'tool Agent turn settled', before, 60_000)
    // Session events are queued by the pinned JSONL backend. Confirm native
    // close and process exit (the persistence drain) before reading disk,
    // matching the public-service/Linux tests rather than sampling live writes.
    const liveNodes = new Map(peer.nodes)
    await finishNative(peer)
    const saved = durable(sandbox)
    assertExact(saved.users, ['xyz😀\nsecond line', 'atomic\nsend', '[tool]'], 'native send-once')
    assertExact(saved.assistants, [
      'echo: xyz😀\nsecond line', 'echo: atomic\nsend', 'tool settled',
    ], 'real Agent replies')
    const callId = assertTool(saved)
    const toolId = 'main.tool.' + callId
    requireGate(liveNodes.get(toolId)?.p?.role === 'dsh.tool',
      'real native semantic tool card role missing')
    requireGate(liveNodes.get(toolId + '.body')?.p?.text
      === 'Tool result: DSH_TUI_FIXTURE_OK',
    'real native tool result card did not settle')
    const additions = peer.frames.flatMap(frame => frame.ops)
      .filter(op => Array.isArray(op) && op[0] === 'add' && op[4]?.id === toolId)
    requireGate(additions.length === 1, 'tool card was re-added instead of reconciled once')
    return {
      sessionId: saved.id, durableUserCount: saved.users.length,
      durableAssistantCount: saved.assistants.length,
      durableToolResults: 1, transport: peer.stats(),
    }
  } finally { await peer.dispose() }
}

async function nativeResume(sandbox, sessionId) {
  const peer = launch(sandbox, ['--session-id', sessionId])
  try {
    await waitNative(peer)
    await waitNode(peer, { contains: 'Tool result: DSH_TUI_FIXTURE_OK' },
      'durable Session replay on new real ConPTY child')
    // A pane is no longer visible, loses its original surface and then
    // becomes visible; the real SDK opens the documented recovery surface.
    peer.sendOsc877('e', { ev: 'visible', sf: 'dsh', visible: false })
    peer.sendOsc877('e', { ev: 'gone', sf: 'dsh', ids: ['dsh'] })
    peer.sendOsc877('e', { ev: 'visible', sf: 'dsh', visible: true })
    await peer.waitFor(() => peer.opens.some(o => o.id === 'dsh.recovery.1')
      && peer.frames.some(f => f.sf === 'dsh.recovery.1'),
    'actual ConPTY detach/reattach surface lifecycle', 45_000)
    const before = peer.frames.length
    peer.write('after-resume\r')
    await waitNode(peer, { contains: 'echo: after-resume' },
      'Agent reply after recovered native surface', before)
    await waitNode(peer, { id: 'dock.status.label', contains: ' · idle' },
      'resumed Agent turn settled', before)
    await finishNative(peer)
    const saved = durable(sandbox)
    requireGate(saved.id === sessionId, 'real persisted Session ID changed across process restart')
    assertExact(saved.users, ['xyz😀\nsecond line', 'atomic\nsend', '[tool]', 'after-resume'],
      'native multi-turn resume')
    assertExact(saved.assistants, [
      'echo: xyz😀\nsecond line', 'echo: atomic\nsend', 'tool settled', 'echo: after-resume',
    ], 'native durable assistant replay')
    return {
      resumedSameSession: true, durableUserCount: saved.users.length,
      durableAssistantCount: saved.assistants.length, transport: peer.stats(),
    }
  } finally { await peer.dispose() }
}

async function fallbackMalicious(sandbox) {
  const peer = launch(sandbox, [], 'fallback')
  const hello = JSON.stringify({
    r: 'hello', v: 1, term: 'tern', ver: '0.1.0',
    kinds: ['text', 'row', 'col', 'editor'], features: ['edit', 'send'],
    apc: 4096, credits: 2, cols: 80, cell: { w: 8, h: 16 },
    dark: true, reduceMotion: false,
  })
  try {
    await peer.waitFor(() => peer.output.includes('dsh> '),
      'DA1-first real ANSI fallback prompt', 45_000)
    requireGate(peer.queryCount === 1 && peer.frames.length === 0,
      'DA1-first did not suppress native surface')
    peer.write('preé')
    // Match the Linux post-prompt witness: a split valid late TSP reply,
    // invalid/foreign TSP replies, malformed JSON, and a split OSC877 reply.
    // Non-TSP APC is intentionally ordinary key input in the published SDK.
    peer.write('\x1b_tsp;r;' + hello.slice(0, 20))
    await new Promise(resolve => setTimeout(resolve, 65))
    peer.write(hello.slice(20) + '\x1b\\')
    peer.write('-mid')
    peer.sendOsc877('r', {
      r: 'hello', v: 99, term: 'tern', ver: '0.1.0',
      kinds: ['text'], features: ['send'], apc: 4096, credits: 2,
    })
    peer.write('\x1b_tsp;r;{"r":"hello","v":1,"term":"foreign"}\x1b\\')
    peer.sendOsc877('e', '{broken-json}')
    peer.write('\x1b]877;tsp;r;' + hello.slice(0, 9))
    peer.write(hello.slice(9) + '\x1b\\')
    peer.write('🌱post\r')
    // A completed reply is the shutdown barrier, not proof of exact content.
    // Assert the unchanged exact intent/reply after exit so a mismatch yields
    // the existing nontextual Session diagnostics rather than an opaque timeout.
    await peer.waitFor(() => peer.output.includes('[dsh] echo: '),
      'ANSI Agent reply after malformed / foreign / late hello', 45_000)
    peer.write('/quit\r')
    await peer.waitForExit(25_000)
    requireGate(peer.exit.code === 0, 'ANSI fallback /quit exit not zero')
    requireGate(peer.frames.length === 0, 'malformed hello promoted to a native frame')
    const saved = durable(sandbox)
    assertExact(saved.users, ['preé-mid🌱post'], 'late hello never becomes a user request')
    assertExact(saved.assistants, ['echo: preé-mid🌱post'], 'fallback real Agent reply')
    requireGate(peer.output.includes('[dsh] echo: preé-mid🌱post'),
      'exact fenced ANSI Agent reply missing from terminal output')
    peer.assertTransport(false)
    return {
      durableUserCount: 1, durableAssistantCount: 1,
      maliciousCarriers: 5, transport: peer.stats(),
    }
  } finally { await peer.dispose() }
}

async function disabledNative(sandbox) {
  const peer = launch(sandbox, ['--no-native'], 'fallback')
  try {
    await peer.waitFor(() => peer.output.includes('dsh> '),
      'explicitly disabled native real ANSI prompt', 30_000)
    requireGate(peer.queryCount === 0 && peer.frames.length === 0,
      'native opt-out still probed or rendered TSP')
    peer.write('disabled\r')
    await peer.waitFor(() => peer.output.includes('[dsh] echo: disabled'),
      'opt-out real Agent reply', 45_000)
    peer.write('/quit\r')
    await peer.waitForExit(25_000)
    requireGate(peer.exit.code === 0, 'opt-out /quit exit not zero')
    assertExact(durable(sandbox).users, ['disabled'], 'native opt-out Session')
    return { durableUserCount: 1, transport: peer.stats() }
  } finally { await peer.dispose() }
}

async function nativeErrorRecovery(sandbox) {
  // A genuine SDK error is injected into the original OS ConPTY, then a new
  // ConPTY child proves that the dead pane did not own the host profile.
  const failed = launch(sandbox)
  let crashExit
  try {
    await waitNative(failed)
    failed.sendOsc877('e', {
      ev: 'error', sf: 'dsh', msg: 'injected ConPTY surface failure',
    })
    await failed.waitForExit(25_000)
    requireGate(Number.isInteger(failed.exit.code) && failed.exit.code !== 0,
      'real ConPTY protocol failure must exit nonzero')
    requireGate(failed.output.includes('\x1b[?2004l'),
      'failure did not restore bracketed paste')
    crashExit = failed.exit.code
  } finally { await failed.dispose() }

  const recovered = launch(sandbox)
  try {
    await waitNative(recovered)
    const before = recovered.frames.length
    recovered.write('new-child-after-error\r')
    await waitNode(recovered, { contains: 'echo: new-child-after-error' },
      'reopened child after native SDK failure', before)
    await waitNode(recovered, { id: 'dock.status.label', contains: ' · idle' },
      'recovered child Agent turn settled', before)
    await finishNative(recovered)
    return { crashExitCode: crashExit, recoveryExitCode: recovered.exit.code,
      transport: recovered.stats() }
  } finally { await recovered.dispose() }
}

function safeFailure(error) {
  if (error instanceof GateFailure) return error.message
  const code = typeof error?.code === 'string' ? error.code : 'unclassified'
  return 'unexpected ' + (error?.name ?? 'Error') + ' (' + code + '); private details withheld'
}

try {
  await step('inputs-and-native-backend', backendCheck)
  await step('os-conpty-tty-preflight', preflight)
  const main = privateWorkspace('native')
  await step('packed-real-plugin-manager-native-profile', () => {
    installPlugin(main)
    return { installedThroughRealHost: true }
  })
  const first = await step('native-unicode-multiline-edit-atomic-send-tool-close',
    () => nativeOne(main))
  await step('native-persistent-session-restart-and-surface-recovery',
    () => nativeResume(main, first.sessionId))
  const errorRecovery = privateWorkspace('error-recovery')
  await step('packed-real-plugin-manager-error-recovery-profile', () => {
    installPlugin(errorRecovery)
    return { installedThroughRealHost: true }
  })
  await step('native-os-conpty-protocol-error-and-fresh-child', () =>
    nativeErrorRecovery(errorRecovery))
  const disabled = privateWorkspace('disabled')
  await step('packed-real-plugin-manager-optout-profile', () => {
    installPlugin(disabled)
    return { installedThroughRealHost: true }
  })
  await step('explicit-no-native-ansi-real-agent', () => disabledNative(disabled))
  const fallback = privateWorkspace('fenced')
  await step('packed-real-plugin-manager-fallback-profile', () => {
    installPlugin(fallback)
    return { installedThroughRealHost: true }
  })
  await step('da1-first-late-foreign-malformed-hello', () => fallbackMalicious(fallback))
  evidence.status = 'GREEN'
  evidence.phase = 'complete'
} catch (error) {
  evidence.status = 'RED'
  evidence.phase = phase
  evidence.failure = safeFailure(error)
  cases.push({ name: phase, status: 'RED', reason: evidence.failure })
} finally {
  // Only synthetic receipt metadata may escape the private workspace.
  // Never upload raw PTY streams, Session logs, profiles or HOME.
  const destination = join(out, 'summary.json')
  writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  for (const dir of childRoots) rmSync(dir, { recursive: true, force: true })
}
process.stdout.write('Windows ConPTY gate ' + evidence.status + ' at phase ' + evidence.phase
  + '; cases=' + cases.filter(item => item.status === 'PASS').length + ' PASS, '
  + cases.filter(item => item.status === 'RED').length + ' RED\n')
if (evidence.status === 'RED') {
  process.stderr.write('Windows ConPTY RED ' + evidence.phase + ': ' + evidence.failure + '\n')
  process.exitCode = 1
}
