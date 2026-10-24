/**
 * SYNTHETIC UNIT DATA ONLY: strict negative/positive validators for private
 * RFC #6 evidence scripts. These are NOT live Tern/DSH/Hermes proof.
 * Actual smoke/peer protocol differential must execute on the owned host.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const harness = fileURLToPath(new URL('./host/harness/', import.meta.url))
const compareScript = join(harness, 'compare_wire.py')
const sealScript = join(harness, 'evidence_bundle.py')
const created: string[] = []
const GIT_SHA = 'a'.repeat(40)
const TERN_SHA = 'b'.repeat(64)
const CLI_SHA = 'c'.repeat(64)
const H = (value: string): string => createHash('sha256').update(value).digest('hex')
const safeDir = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}
const write = (path: string, data: string): void => {
  safeDir(dirname(path))
  writeFileSync(path, data, { mode: 0o600 })
  chmodSync(path, 0o600)
}
const json = (path: string, data: unknown): void => write(path, JSON.stringify(data, null, 2) + '\n')
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tsp-UNIT-'))
  chmodSync(root, 0o700)
  created.push(root)
  return root
}
afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})
function python(script: string, args: string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync('python3', [script, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  expect(result.error, String(result.error)).toBeUndefined()
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}
type Event = { dir: 'in' | 'out'; verb: string; body: Record<string, any> | string; params?: Record<string, string> }
const body = (event: Event): Record<string, any> => event.body as Record<string, any>
const hello = {
  r: 'hello', v: 1, term: 'tern', ver: '0.9.5',
  kinds: ['col', 'text', 'editor', 'input'],
  features: ['blobs', 'settle', 'adopt', 'dock', 'program-palette',
    'reduce-motion', 'aside', 'scroll', 'styles', 'flow'],
  credits: 1, apc: 8192, cols: 100,
}
function startup(app: string): Event[] {
  return [
    { dir: 'out', verb: 'q', body: {
      q: 'hello', v: [1], app, ver: '', features: ['edit', 'undo', 'send'],
    } },
    { dir: 'in', verb: 'r', body: { ...hello } },
    { dir: 'out', verb: 'b', params: { id: app + '.logo', mime: 'image/png' }, body: 'aGVsbG8=' },
    { dir: 'out', verb: 'o', body: { sf: app, mode: 'inline' } },
    { dir: 'out', verb: 'f', body: {
      sf: app, s: 1, ops: [
        // The public SDK op's ID must equal the actual node.id, under surface root.
        ['add', app + '.root', app, null, {
          id: app + '.root', k: 'col', c: [
            { id: app + '.message', k: 'text', p: { text: 'Ready' } },
            { id: app + '.editor', k: 'editor', p: { text: '' } },
          ],
        }],
        ['text', app + '.message', 'replace', 'Ready'], // SDK Op is FOUR fields
      ],
    } },
    { dir: 'in', verb: 'e', body: { ev: 'ack', sf: app, s: 1 } },
    { dir: 'out', verb: 'x', body: { id: app, keep: true } },
  ]
}
const wire = (events: Event[]): string => events.map(item => JSON.stringify(item)).join('\n') + '\n'
interface StartupFixture {
  dir: string
  file: string
  manifest: string
  events: Event[]
  meta: Record<string, any>
  persist(): void
}
function captured(root: string, app: string, opts: { capture?: string } = {}): StartupFixture {
  const dir = join(root, app)
  safeDir(dir)
  const file = join(dir, 'wire.jsonl')
  const manifest = join(dir, 'manifest.json')
  const events = startup(app)
  const meta: Record<string, any> = {
    schema: 'dsh.tsp.evidence.2', mode: 'live', source_kind: 'actual-process',
    scope: 'startup-no-prompt', git_sha: GIT_SHA,
    plugin: { source_sha: 'd'.repeat(40), artifact_sha256: 'e'.repeat(64),
      location: 'local', hash_origin: 'measured-locally' },
    tern_version: 'Tern 0.9.5', tern_binary_sha256: TERN_SHA,
    model_id: 'tui-fixture/deterministic',
    workspace_start: { empty: true, prior_events: 0 },
    capture_id: opts.capture ?? 'capture-' + app, wire_file: 'wire.jsonl',
    files: [{ path: 'wire.jsonl', sha256: '' }],
  }
  const persist = (): void => {
    const raw = wire(events)
    write(file, raw)
    meta['files'][0]['sha256'] = H(raw)
    json(manifest, meta)
  }
  persist()
  return { dir, file, manifest, events, meta, persist }
}
let comparisonNumber = 0
function diff(dsh: StartupFixture, peer: StartupFixture): ReturnType<typeof python> {
  return python(compareScript, [
    '--dsh', dsh.file, '--peer', peer.file,
    '--dsh-manifest', dsh.manifest, '--peer-manifest', peer.manifest,
    '--out', join(dsh.dir, 'comparison-' + (++comparisonNumber) + '.json'),
  ])
}
interface Evidence {
  root: string
  archive: string
  capture: Record<string, any>
  launcher: Record<string, any>
  plugin: Record<string, any>
  update(): void
}
function evidence(parent: string): Evidence {
  const root = join(parent, 'evidence')
  safeDir(root)
  safeDir(join(root, 'control'))
  safeDir(join(root, 'log'))
  safeDir(join(root, 'sessions', 'owned'))
  safeDir(join(root, 'runtime'))
  safeDir(join(root, 'home'))
  safeDir(join(root, 'cache'))
  write(join(root, 'control/git-sha'), GIT_SHA + '\n')
  write(join(root, 'plugin/plugin.tgz'), 'synthetic-standalone-package-bytes')
  write(join(root, 'control/tern-version'), 'Tern 0.9.5\n')
  write(join(root, 'control/tern-binary-sha256'), TERN_SHA + '\n')
  write(join(root, 'control/evidence-mode'), 'live\n')
  write(join(root, 'control/replies.tsv'), 'startup\t{"ok":true}\n')
  write(join(root, 'log/sway.log'), 'private HEADLESS-1 active\n')
  write(join(root, 'log/tern-serve.log'), 'private test server\n')
  write(join(root, 'log/metadata.jsonl'), '{"direction":"out","verb":"f"}\n')
  write(join(root, 'log/dsh-sdk-wire.jsonl'), wire(startup('dsh')))
  write(join(root, 'sessions/owned/session.v1.jsonl'),
    '{"type":"session","id":"session-unit"}\n{"type":"turn/end"}\n')
  const capture = {
    capture_id: 'unit-local-capture', scope: 'live-functional',
    model_id: 'tui-fixture/deterministic',
    workspace_start: { empty: true, prior_events: 0 },
    collector: 'local-process', wire_file: 'log/dsh-sdk-wire.jsonl',
  }
  const launcher = {
    source_sha: GIT_SHA, artifact_sha256: CLI_SHA, location: 'local',
    hash_origin: 'measured-locally', provenance: 'SYNTHETIC UNIT DATA; not an executable attestation',
  }
  const plugin = {
    source_sha: 'd'.repeat(40),
    artifact_sha256: H('synthetic-standalone-package-bytes'),
    location: 'local', hash_origin: 'measured-locally',
    provenance: 'SYNTHETIC plugin fixture; not a real packed consumer',
  }
  const archive = join(parent, 'sealed.tar.gz')
  const update = (): void => {
    json(join(root, 'control/capture.json'), capture)
    json(join(root, 'control/launcher.json'), launcher)
    json(join(root, 'control/plugin.json'), plugin)
  }
  update()
  return { root, archive, capture, launcher, plugin, update }
}
function seal(e: Evidence, extras: string[] = []): ReturnType<typeof python> {
  return python(sealScript, ['--evidence-dir', e.root, '--out', e.archive, ...extras])
}
function inspectArchive(path: string): { names: string[]; manifest: Record<string, any>; integrity: boolean } {
  const script = [
    'import json,tarfile,hashlib,sys',
    'with tarfile.open(sys.argv[1],"r:gz") as t:',
    ' m=json.loads(t.extractfile("manifest.json").read())',
    ' names=t.getnames()',
    ' ok=all(hashlib.sha256(t.extractfile(f["path"]).read()).hexdigest()==f["sha256"]',
    '        and t.getmember(f["path"]).size==f["bytes"] for f in m["files"])',
    ' print(json.dumps({"names":names,"manifest":m,"integrity":ok}))',
  ].join('\n')
  const process = python('-c', [script, path])
  expect(process.status, process.stderr).toBe(0)
  return JSON.parse(process.stdout) as { names: string[]; manifest: Record<string, any>; integrity: boolean }
}

describe('RFC #6 synthetic startup protocol validator (NOT parity proof)', () => {
  it('accepts q.v:[1], program q.features, terminal kinds/features, SDK blob, text and CLOSE', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    const result = diff(dsh, peer)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('"startup-protocol-only-not-edit-send-or-model-parity"')
  })

  it('accepts a cumulative in-flight ACK draining AFTER x CLOSE', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    const ack = peer.events.splice(5, 1)[0]!
    peer.events.push(ack)
    peer.persist()
    expect(diff(dsh, peer).status).toBe(0)
  })

  it('accepts real-SDK-shaped frame2 focus and null-unfocus (synthetic, NOT b675 replay)', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    // The retained b675 recording actually has ["focus","dock.composer.line.input"]
    // in frame2. These rows are constructed UNIT data, never the retained capture.
    const focusId = 'dock.composer.line.input'
    body(peer.events[4]!)['ops'][0][4].c.push({ id: focusId, k: 'input', p: { value: '' } })
    peer.events.splice(6, 0,
      { dir: 'out', verb: 'f', body: { sf: 'hermes', s: 2,
        ops: [['focus', focusId], ['focus', null]] } },
      { dir: 'in', verb: 'e', body: { ev: 'ack', sf: 'hermes', s: 2 } },
    )
    peer.persist()
    const result = diff(dsh, peer)
    expect(result.status, result.stderr).toBe(0)
  })

  it('accepts all typed public SDK op families plus credits=2/cumulative ACK', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    body(dsh.events[1]!)['credits'] = 2
    body(peer.events[1]!)['credits'] = 2
    const ack = peer.events.splice(5, 1)[0]!
    body(ack)['s'] = 2
    peer.events.splice(5, 0,
      { dir: 'out', verb: 'f', body: { sf: 'hermes', s: 2, ops: [
        ['set', 'hermes.message', { text: 'Updated' }],
        ['splice', 'hermes.message', 0, 0, 'Start '],
        ['move', 'hermes.editor', 'hermes.root', null],
        ['reveal', 'hermes.editor', 'start'],
        ['reveal', 'hermes.editor', 'end'],
        ['reveal', 'hermes.editor', 'nearest'],
        ['scroll', 'hermes.editor', 'line-up'],
        ['scroll', 'hermes.editor', 'line-down'],
        ['scroll', 'hermes.editor', 'page-up'],
        ['scroll', 'hermes.editor', 'page-down'],
        ['scroll', 'hermes.editor', 'start'],
        ['scroll', 'hermes.editor', 'end'],
        ['settle', 'hermes.message'],
        ['del', 'hermes.message'],
        ['suspend'], ['resume'],
      ] } },
      ack,
    )
    dsh.persist()
    peer.persist()
    expect(diff(dsh, peer).status).toBe(0)
  })

  it('rejects malformed focus and other non-SDK operations rather than swallowing them', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    const ops = body(peer.events[4]!)['ops'] as unknown[][]
    for (const invalid of [
      ['focus'], ['focus', ''], ['focus', 99], ['focus', false],
      ['focus', {}], ['focus', null, 'extra'],
      ['set', 'hermes.message'], ['set', 'hermes.message', null],
      ['splice', 'hermes.message', -1, 0, '!'],
      ['move', 'hermes.editor', 'hermes.root', 17],
      ['add', 'other', 'hermes', null, { id: 'mismatched', k: 'text' }],
      ['reveal', 'hermes.message', 'bottom'],
      ['reveal', 'hermes.message', 'center'],
      ['scroll', 'hermes.editor', 'wrong-direction'],
      ['scroll', 'hermes.editor', null],
      ['suspend', 'extra'], ['resume', null],
      ['props', 'hermes.message', { text: 'not an SDK opcode' }],
      ['future-unknown', 'hermes.editor'],
    ]) {
      ops.push(invalid)
      peer.persist()
      const result = diff(dsh, peer)
      expect(result.status, JSON.stringify(invalid) + ': ' + result.stderr).toBe(2)
      ops.pop()
    }
    body(peer.events[1]!)['credits'] = 3 // bounded startup oracle is credits <=2
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
  })

  it('rejects unsupported q versions/features and malformed r replies', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    body(peer.events[0]!)['v'] = 1 // scalar version is NOT the SDK query
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    body(peer.events[0]!)['v'] = [1]
    body(peer.events[0]!)['features'] = ['edit', 'undo']
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    body(peer.events[0]!)['features'] = ['edit', 'undo', 'send']
    body(peer.events[1]!)['v'] = 2 // not in the offered list
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    body(peer.events[1]!)['v'] = 1
    body(peer.events[1]!)['kinds'] = ['col', 'editor']
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
  })

  it('refuses manifests that both lie about the live terminal version', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    dsh.meta['tern_version'] = 'Tern 0.9.6'
    peer.meta['tern_version'] = 'Tern 0.9.6'
    dsh.persist()
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
  })

  it('rejects malformed blob records, three-field text, and incorrect CLOSE', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    peer.events[2]!.body = 'not/base64?'
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    peer.events[2]!.body = 'aGVsbG8='
    peer.events[2]!.params = { id: 'hermes.logo', mime: '' }
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    peer.events[2]!.params = { id: 'hermes.logo', mime: 'image/png' }
    body(peer.events[4]!)['ops'][1] = ['text', 'hermes.message', 'Ready']
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    body(peer.events[4]!)['ops'][1] = ['text', 'hermes.message', 'replace', 'Ready']
    body(peer.events[6]!)['keep'] = 'true'
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    body(peer.events[6]!)['keep'] = true
    peer.events.pop()
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2) // no close
  })

  it('rejects frames after CLOSE, over-credit frames, bad ACK and real errors', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    peer.events.push({ dir: 'out', verb: 'f', body: {
      sf: 'hermes', s: 2, ops: [['text', 'hermes.message', 'append', '!']],
    } })
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2) // frame after x
    peer.events.pop()
    peer.events.splice(5, 0, { dir: 'out', verb: 'f', body: {
      sf: 'hermes', s: 2, ops: [['text', 'hermes.message', 'append', '!']],
    } })
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2) // second frame without credit
    peer.events.splice(5, 1)
    body(peer.events[5]!)['s'] = 2
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2) // ACK for unissued frame
    body(peer.events[5]!)['s'] = 1
    peer.events.push({ dir: 'in', verb: 'e', body: { ev: 'error', msg: 'real close/credit defect' } })
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    peer.events.pop()
    delete body(peer.events[4]!)['ops'][0][4]['id']
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
  })

  it('rejects differing negotiation, missing metadata, mismatched model/workspace', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    body(peer.events[1]!)['credits'] = 2
    peer.persist()
    expect(diff(dsh, peer).status).toBe(1)
    body(peer.events[1]!)['credits'] = 1
    delete peer.meta['model_id']
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    peer.meta['model_id'] = 'different-model'
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    peer.meta['model_id'] = 'tui-fixture/deterministic'
    peer.meta['workspace_start'] = { empty: false, prior_events: 1 }
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
  })

  it('rejects replay/wrong-archive/capture-id duplications and tampered bytes', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    peer.meta['mode'] = 'replay'
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    peer.meta['mode'] = 'live'
    peer.meta['capture_id'] = dsh.meta['capture_id']
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    peer.meta['capture_id'] = 'independent'
    peer.persist()
    write(peer.file, readFileSync(peer.file, 'utf8') + '\n')
    expect(diff(dsh, peer).status).toBe(2)
  })
})

describe('RFC #6 synthetic evidence seal safety (NOT native proof)', () => {
  it('archives only approved actual logs, Sessions, wire and exact hashes, not sockets or secrets', () => {
    const e = evidence(workspace())
    write(join(e.root, 'home/credentials.json'), '{"secret":"NEVER ARCHIVE"}')
    write(join(e.root, 'cache/token'), 'NEVER ARCHIVE')
    const sock = python('-c', [
      'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()',
      join(e.root, 'runtime/control.sock'),
    ])
    expect(sock.status, sock.stderr).toBe(0)
    write(join(e.root, 'log/unapproved.txt'), 'NEVER ARCHIVE')
    const result = seal(e)
    expect(result.status, result.stderr).toBe(0)
    const a = inspectArchive(e.archive)
    expect(a.integrity).toBe(true)
    expect(a.names).toContain('log/dsh-sdk-wire.jsonl')
    expect(a.names).toContain('sessions/owned/session.v1.jsonl')
    expect(a.names).toContain('redacted-wire.jsonl')
    expect(a.names).toContain('manifest.json')
    expect(a.names.some(name => /home|cache|runtime|unapproved/.test(name))).toBe(false)
    expect(a.manifest['source_kind']).toBe('actual-process')
    expect(a.manifest['record_counts']).toEqual({ in: 2, out: 5 })
    expect(readFileSync(e.root + '/log/dsh-sdk-wire.jsonl', 'utf8')).toContain('Ready')
    expect(existsSync(e.root + '/manifest.json')).toBe(false)
  })

  it('refuses symlink/hardlink and group/world-readable artifact inputs', () => {
    const a = evidence(workspace())
    const target = join(a.root, 'log/dsh-sdk-wire.jsonl')
    rmSync(target)
    symlinkSync(join(a.root, 'control/git-sha'), target)
    expect(seal(a).status).toBe(2)
    rmSync(target)
    write(target, wire(startup('dsh')))
    chmodSync(target, 0o644)
    expect(seal(a).status).toBe(2)
    chmodSync(target, 0o600)
    const duplicate = join(a.root, 'log/linked-other.jsonl')
    linkSync(target, duplicate)
    expect(seal(a).status).toBe(2)
    rmSync(duplicate)
    expect(seal(a).status).toBe(0)
  })

  it('rejects a plugin artifact mismatch and malformed plugin source without conflating host evidence', () => {
    const e = evidence(workspace())
    e.plugin.artifact_sha256 = 'f'.repeat(64)
    e.update()
    expect(seal(e).status).toBe(2)
    expect(existsSync(e.archive)).toBe(false)
    e.plugin.artifact_sha256 = H('synthetic-standalone-package-bytes')
    e.plugin.source_sha = 'not-a-commit'
    e.update()
    expect(seal(e).status).toBe(2)
    e.plugin.source_sha = 'd'.repeat(40)
    e.update()
    expect(seal(e).status).toBe(0)
    const saved = inspectArchive(e.archive)
    expect(saved.manifest['git_sha']).toBe(GIT_SHA)
    expect(saved.manifest['launcher']).toMatchObject({
      source_sha: GIT_SHA, artifact_sha256: CLI_SHA,
    })
    expect(saved.manifest['plugin']).toMatchObject({
      source_sha: 'd'.repeat(40),
      artifact_sha256: H('synthetic-standalone-package-bytes'),
    })
  })

  it('requires exact source/build metadata and allows retry after redaction failure', () => {
    const e = evidence(workspace())
    e.launcher.artifact_sha256 = 'not-a-hash'
    e.update()
    expect(seal(e).status).toBe(2)
    e.launcher.artifact_sha256 = CLI_SHA
    e.update()
    write(join(e.root, 'log/dsh-sdk-wire.jsonl'), wire(startup('dsh')) + '{invalid\n')
    expect(seal(e).status).toBe(2)
    expect(existsSync(e.archive)).toBe(false)
    expect(existsSync(join(e.root, 'redacted-wire.jsonl'))).toBe(false)
    expect(existsSync(join(e.root, 'manifest.json'))).toBe(false)
    write(join(e.root, 'log/dsh-sdk-wire.jsonl'), wire(startup('dsh')))
    expect(seal(e).status).toBe(0)
    expect(seal(e).status).toBe(2) // no archive overwrite
    expect(inspectArchive(e.archive).integrity).toBe(true)
  })

  it('refuses a redaction-to-hash mutation, then retries with consistent source data', () => {
    const e = evidence(workspace())
    // Monkeypatch solely inside this synthetic Python test process, after the
    // original redacted_wire read. Production has no test-only hook.
    const script = [
      'import importlib.util,sys',
      'from pathlib import Path',
      'spec=importlib.util.spec_from_file_location("proof",sys.argv[1])',
      'm=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'original=m.redacted_wire',
      'def changed(src,dst):',
      ' counts=original(src,dst)',
      ' with src.open("a",encoding="utf-8") as stream:',
      '  stream.write(\'{"dir":"in","verb":"e","body":{"ev":"ack","sf":"dsh","s":1}}\\n\')',
      ' return counts',
      'm.redacted_wire=changed',
      'try:',
      ' m.seal(Path(sys.argv[2]),Path(sys.argv[3]),False)',
      'except ValueError:',
      ' sys.exit(2)',
      'sys.exit(0)',
    ].join('\n')
    const result = python('-c', [script, sealScript, e.root, e.archive])
    expect(result.status, result.stderr).toBe(2)
    expect(existsSync(e.archive)).toBe(false)
    expect(seal(e).status).toBe(0)
    const saved = inspectArchive(e.archive)
    expect(saved.integrity).toBe(true)
    expect(saved.manifest['record_counts']).toEqual({ in: 2, out: 5 })
  })

  it('rejects a symlinked ancestor leading an archive back inside its evidence root', () => {
    const parent = workspace()
    const e = evidence(parent)
    const alias = join(parent, 'alias')
    symlinkSync(parent, alias, 'dir')
    const bypass = join(alias, 'evidence', 'escaped.tar.gz')
    const result = python(sealScript, ['--evidence-dir', e.root, '--out', bypass])
    expect(result.status).toBe(2)
    expect(existsSync(join(e.root, 'escaped.tar.gz'))).toBe(false)
    expect(seal(e).status, 'safe destination must remain retryable').toBe(0)
  })

  it('distinguishes scenario double-quoting from POSIX shell quoting at actual ctl sites (UNIT only)', () => {
    const source = readFileSync(join(harness, 'private_tern.sh'), 'utf8')
    const begin = source.indexOf('\nscenario_quote() {')
    const end = source.indexOf('\nctl() {', begin + 1)
    expect(begin).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(begin)
    const functions = source.slice(begin, end)
    expect(source).toContain('ctl replay-start surface-play "$(scenario_quote "$BASE/log/replay-source.jsonl")"')
    expect(source).toContain('ctl app-launch run "$(run_quote "$BASE/launch-dsh.sh")"')
    expect(source).toContain('ctl log-pane-run run "$(run_quote "$BASE/log-pane.sh")"')
    for (const filename of [
      '/tmp/path with spaces/replay witness.jsonl',
      '/tmp/quote "double" and ' + "'single'" + '/file.jsonl',
      '/tmp/back\\slash/$(false) $HOME/replay.jsonl',
      '/tmp/Unicode α😀 and spaces/replay.jsonl',
      '/tmp/line\nbreak and \ttab/replay.jsonl',
    ]) {
      // Execute only the extracted production encoding helpers. No Tern, Sway,
      // DSH, provider, user command or arbitrary fragment is launched.
      const encoded = spawnSync('bash', ['-c',
        functions + '\nscenario_quote "$1"\nrun_quote "$1"', 'unit-quote', filename,
      ], { encoding: 'utf8', timeout: 10_000 })
      expect(encoded.error, String(encoded.error)).toBeUndefined()
      expect(encoded.status, encoded.stderr).toBe(0)
      const lines = encoded.stdout.trimEnd().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/^"/) // Tern scenario strings, not shell single quotes
      expect(lines[1]).toMatch(/^"/)
      expect(JSON.parse(lines[0]!)).toBe(filename) // surface-play file argument
      // Tern's scenario parser documents literal Unicode and only \\", \\\\, \\n, \\t
      // escapes; JSON's \\uXXXX form is not an advertised scenario escape.
      expect(lines[0]).not.toMatch(/\\u[0-9a-f]{4}/i)
      expect(lines[1]).not.toMatch(/\\u[0-9a-f]{4}/i)
      const shellWord = JSON.parse(lines[1]!) as string
      // Only a trusted synthetic filename is evaluated by the POSIX test shell.
      const roundTrip = spawnSync('sh', ['-c', 'printf %s ' + shellWord], {
        encoding: 'utf8', timeout: 10_000,
      })
      expect(roundTrip.error, String(roundTrip.error)).toBeUndefined()
      expect(roundTrip.status, roundTrip.stderr).toBe(0)
      expect(roundTrip.stdout).toBe(filename) // run strips scenario, THEN shell parses
    }
  })

  it('keeps private launcher shell parseable without executing Sway or a provider', () => {
    const source = readFileSync(join(harness, 'private_tern.sh'), 'utf8')
    expect(source).toContain('DSH_TUI_TEST_WORKSPACE=$WORKSPACE')
    expect(source).toContain('run_quote "$BASE/launch-dsh.sh"')
    expect(source).toContain('replay_ready()')
    const parse = spawnSync('bash', ['-n', join(harness, 'private_tern.sh')], {
      encoding: 'utf8', timeout: 10_000,
    })
    expect(parse.error, String(parse.error)).toBeUndefined()
    expect(parse.status, parse.stderr).toBe(0)
  })

  it('labels replay only and remote-uncollected without claiming live local evidence', () => {
    const e = evidence(workspace())
    write(join(e.root, 'control/evidence-mode'), 'replay\n')
    e.capture.scope = 'replay-only'
    e.capture.wire_file = 'log/replay-source.jsonl'
    write(join(e.root, 'log/replay-source.jsonl'), wire(startup('dsh')))
    e.update()
    rmSync(join(e.root, 'log/dsh-sdk-wire.jsonl'))
    rmSync(join(e.root, 'log/metadata.jsonl'))
    rmSync(join(e.root, 'sessions'), { recursive: true })
    expect(seal(e).status).toBe(0)
    const replay = inspectArchive(e.archive)
    expect(replay.manifest['source_kind']).toBe('surface-replay')
    expect(replay.manifest['scope']).toBe('replay-only')

    const remote = evidence(workspace())
    remote.launcher.location = 'remote'
    remote.launcher.hash_origin = 'declared-remote'
    remote.capture.collector = 'remote-uncollected'
    remote.capture.wire_file = null
    remote.capture.workspace_start = { empty: false, prior_events: null }
    remote.update()
    rmSync(join(remote.root, 'log/dsh-sdk-wire.jsonl'))
    rmSync(join(remote.root, 'log/metadata.jsonl'))
    rmSync(join(remote.root, 'sessions'), { recursive: true })
    // A remote LIVE capture may not smuggle a replay source through the
    // global allowlist, even without locally collected SDK/Session files.
    write(join(remote.root, 'log/replay-source.jsonl'), wire(startup('dsh')))
    expect(seal(remote).status).toBe(2)
    expect(existsSync(remote.archive)).toBe(false)
    rmSync(join(remote.root, 'log/replay-source.jsonl'))
    expect(seal(remote).status).toBe(0)
    expect(inspectArchive(remote.archive).manifest['source_kind']).toBe('remote-uncollected')
  })
})

/**
 * Synthetic SDK-shaped frame operations only: exercise the real Python PTY
 * driver's current-document discovery without starting a CLI, Agent or Tern.
 * Live action delivery and Session truth remain in public-services.e2e.ts.
 */
type DriverNode = {
  id: string
  k: string
  p: Record<string, unknown>
  c?: DriverNode[]
}
interface DriverState {
  actions: Record<string, string>
  answer: string | null
  nodes: string[]
}
function probePtyDriver(
  ops: unknown[][][],
  steps: readonly ({ action: string } | { answer: string })[] = [],
): { states: DriverState[]; outgoing: Record<string, unknown>[]; actionsSent: { label: string; id: string }[] } {
  const script = [
    'import importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("pty_fixture_unit",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'assert spec and spec.loader',
    'spec.loader.exec_module(module)',
    'driver=module.Driver.__new__(module.Driver)',
    'driver.frames=[]',
    'driver.nodes={}',
    'driver.node_changes=[]',
    'driver.actions={}',
    'driver.answer_id=None',
    'driver.actions_sent=[]',
    'snapshots=[]',
    'for ops in json.loads(sys.argv[2]):',
    ' driver.frames.append({"sf":"dsh","s":len(driver.frames)+1,"ops":ops})',
    ' driver.apply_frame(driver.frames[-1])',
    ' snapshots.append({"actions":dict(driver.actions),"answer":driver.answer_id,',
    '                   "nodes":sorted(driver.nodes)})',
    'sent=[]',
    'driver.send=lambda data: sent.append(data)',
    'driver.spec={"steps":json.loads(sys.argv[3])}',
    'driver.steps()',
    'outgoing=[json.loads(item.split(b";",2)[2][:-2]) for item in sent]',
    'print(json.dumps({"states":snapshots,"outgoing":outgoing,',
    '                  "actionsSent":driver.actions_sent}))',
  ].join('\n')
  const run = python('-c', [
    script, join(harness, 'pty_driver.py'), JSON.stringify(ops), JSON.stringify(steps),
  ])
  expect(run.status, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as {
    states: DriverState[]
    outgoing: Record<string, unknown>[]
    actionsSent: { label: string; id: string }[]
  }
}
const addPtyNode = (node: DriverNode, region: 'layer' | 'dock'): unknown[] =>
  ['add', node.id, region, null, node]
function questionNode(
  root: string,
  region: 'layer' | 'dock',
  kind: 'el' | 'row' = 'el',
): DriverNode {
  const choice: DriverNode = kind === 'el'
    ? { id: root + '.choice.0', k: 'el',
      p: { tag: 'button', role: 'dsh.question.choice', text: '1) Allow once' } }
    : { id: root + '.choice.0', k: 'row',
      p: { role: 'dsh.question.choice' },
      c: [{ id: root + '.choice.0.label', k: 'text', p: { text: '1) Allow once' } }] }
  return {
    id: root, k: region === 'layer' ? 'overlay' : 'card',
    p: { role: 'dsh.question', ...(region === 'layer' ? { modal: true } : {}) },
    c: [choice, { id: root + '.answer', k: 'editor',
      p: { text: '', sendable: true } }],
  }
}

describe('RFC #6 synthetic PTY active-question selection (NOT live pointer proof)', () => {
  it('routes action.click and native send only to the active modal document, excluding dock controls', () => {
    const root = 'layer.request.abcdef987654.1'
    const unrelated: DriverNode = {
      id: 'dock.navigation', k: 'col', p: { role: 'dsh.navigation' },
      c: [
        { id: 'dock.navigation.accept', k: 'el',
          p: { tag: 'button', text: '1) Allow once', role: 'dsh.question.choice' } },
        { id: 'dock.navigation.editor', k: 'editor', p: { text: 'not an answer' } },
      ],
    }
    const composer: DriverNode = {
      id: 'dock.composer', k: 'col', p: { role: 'dsh.editor' },
      c: [{ id: 'dock.composer.input', k: 'input',
        p: { text: 'unsent draft', sendable: false } }],
    }
    const run = probePtyDriver([[
      addPtyNode(unrelated, 'dock'), addPtyNode(composer, 'dock'),
      addPtyNode(questionNode(root, 'layer'), 'layer'),
    ]], [{ action: 'Allow once' }, { answer: 'Beta' }])
    expect(run.states[0]?.actions).toEqual({ '1) Allow once': root + '.choice.0' })
    expect(run.states[0]?.answer).toBe(root + '.answer')
    expect(run.outgoing).toEqual([
      { ev: 'action', sf: 'dsh', id: root + '.choice.0', act: 'click' },
      { ev: 'send', sf: 'dsh', id: root + '.answer', text: 'Beta' },
    ])
    expect(run.actionsSent).toEqual([
      { label: '1) Allow once', id: root + '.choice.0' },
      { label: 'answer', id: root + '.answer' },
    ])
  })

  it('uses the current dock fallback, replaces stale choices, and invalidates removed/reopened editor IDs', () => {
    const old = 'dock.request.111111111111.1'
    const fresh = 'dock.request.111111111111.2'
    const different = 'dock.request.222222222222.3'
    const first = questionNode(old, 'dock')
    const replaced = questionNode(old, 'dock')
    replaced.c![0] = { id: old + '.choice.1', k: 'el',
      p: { tag: 'button', role: 'dsh.question.choice', text: '2) Deny' } }
    const run = probePtyDriver([
      [addPtyNode(first, 'dock')],
      [addPtyNode(replaced, 'dock')], // same root rebuilt: old choice.0 must disappear
      [['del', old + '.answer']],
      [['del', old]],
      [addPtyNode(questionNode(fresh, 'dock'), 'dock')],
      [['del', fresh], addPtyNode(questionNode(different, 'dock'), 'dock')],
    ], [{ action: 'Allow once' }, { answer: 'custom 😀' }])
    expect(run.states[0]?.actions).toEqual({ '1) Allow once': old + '.choice.0' })
    expect(run.states[1]?.actions).toEqual({ '2) Deny': old + '.choice.1' })
    expect(run.states[1]?.nodes).not.toContain(old + '.choice.0')
    expect(run.states[2]?.answer).toBeNull()
    expect(run.states[2]?.actions).toEqual({ '2) Deny': old + '.choice.1' })
    expect(run.states[3]?.actions).toEqual({})
    expect(run.states[3]?.answer).toBeNull()
    expect(run.states[4]?.answer).toBe(fresh + '.answer')
    expect(run.states[5]?.actions).toEqual({ '1) Allow once': different + '.choice.0' })
    expect(run.states[5]?.answer).toBe(different + '.answer')
    expect(run.states[5]?.nodes).not.toContain(fresh + '.answer')
    expect(run.outgoing).toEqual([
      { ev: 'action', sf: 'dsh', id: different + '.choice.0', act: 'click' },
      { ev: 'send', sf: 'dsh', id: different + '.answer', text: 'custom 😀' },
    ])
  })

  it('extracts a negotiated row choice label from its actual child, not a historical el button', () => {
    const root = 'dock.request.feedfacecaf0.9'
    const run = probePtyDriver([
      [addPtyNode(questionNode(root, 'dock', 'row'), 'dock')],
      [['set', root + '.choice.0.label', { text: '1) Deny' }]],
    ], [{ action: 'Deny' }, { answer: 'selected' }])
    expect(run.states[0]?.actions).toEqual({ '1) Allow once': root + '.choice.0' })
    expect(run.states[1]?.actions).toEqual({ '1) Deny': root + '.choice.0' })
    expect(run.outgoing).toEqual([
      { ev: 'action', sf: 'dsh', id: root + '.choice.0', act: 'click' },
      { ev: 'send', sf: 'dsh', id: root + '.answer', text: 'selected' },
    ])
  })

  it('keeps a negotiated leaf-only dock question distinct from unrelated composer and navigation', () => {
    const root = 'dock.request.123456789abc.4'
    const run = probePtyDriver([
      [
        addPtyNode({ id: 'dock.nav.choice.0', k: 'el',
          p: { tag: 'button', text: '1) Allow once', role: 'dsh.question.choice' } }, 'dock'),
        addPtyNode({ id: 'dock.composer.input', k: 'input',
          p: { text: 'unsent draft' } }, 'dock'),
        addPtyNode({ id: root + '.choice.0', k: 'el',
          p: { tag: 'button', role: 'dsh.question.choice', text: '1) Allow once' } }, 'dock'),
        addPtyNode({ id: root + '.answer', k: 'input', p: { text: '' } }, 'dock'),
      ],
      [['del', root + '.choice.0'], ['del', root + '.answer']],
    ])
    expect(run.states[0]?.actions).toEqual({ '1) Allow once': root + '.choice.0' })
    expect(run.states[0]?.answer).toBe(root + '.answer')
    expect(run.states[1]?.actions).toEqual({})
    expect(run.states[1]?.answer).toBeNull()
  })
})
