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

const harness = fileURLToPath(new URL('../../../../apps/cli/tests/profiles/tui/harness/', import.meta.url))
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
type Event = { dir: 'in' | 'out'; verb: string; body: Record<string, any> }
const hello = {
  r: 'hello', v: 1, term: 'tern', ver: '0.9.5',
  kinds: ['col', 'text', 'editor'], features: ['edit', 'send', 'undo'],
  credits: 1, apc: 8192, cols: 100,
}
function startup(app: string): Event[] {
  return [
    { dir: 'out', verb: 'q', body: { q: 'hello', v: 1, app } },
    { dir: 'in', verb: 'r', body: { ...hello } },
    { dir: 'out', verb: 'o', body: { sf: app, mode: 'inline' } },
    { dir: 'out', verb: 'f', body: {
      sf: app, s: 1, ops: [
        // First add's region is deliberately NOT the real semantic node ID.
        ['add', 'main', 'start', null, {
          id: app + '.root', k: 'col', c: [
            { id: app + '.message', k: 'text', p: { text: 'Ready' } },
            { id: app + '.editor', k: 'editor', p: { text: '' } },
          ],
        }],
        ['text', app + '.message', 'Ready'], // actual TSP 3-field text op
      ],
    } },
    { dir: 'in', verb: 'e', body: { ev: 'ack', sf: app, s: 1 } },
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
  const archive = join(parent, 'sealed.tar.gz')
  const update = (): void => {
    json(join(root, 'control/capture.json'), capture)
    json(join(root, 'control/launcher.json'), launcher)
  }
  update()
  return { root, archive, capture, launcher, update }
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
  it('accepts q/r + actual recursive node IDs + 3-field text + bounded ACK only', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    const result = diff(dsh, peer)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('"startup-protocol-only-not-edit-send-or-model-parity"')
  })

  it('rejects mismatched negotiation, missing metadata, model and workspace', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    peer.events[1]!.body['credits'] = 2
    peer.persist()
    expect(diff(dsh, peer).status).toBe(1)
    peer.events[1]!.body['credits'] = 1
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

  it('rejects over-credit, bad ACK, protocol errors and missing real IDs', () => {
    const root = workspace()
    const dsh = captured(root, 'dsh')
    const peer = captured(root, 'hermes')
    peer.events.splice(4, 0, { dir: 'out', verb: 'f', body: {
      sf: 'hermes', s: 2, ops: [['text', 'hermes.message', 'unacked']],
    } })
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    peer.events.splice(4, 1)
    peer.events[4]!.body['s'] = 2
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    peer.events[4]!.body['s'] = 1
    peer.events.push({ dir: 'in', verb: 'e', body: { ev: 'error', msg: 'bad operation' } })
    peer.persist()
    expect(diff(dsh, peer).status).toBe(2)
    peer.events.pop()
    delete peer.events[3]!.body['ops'][0][4]['id']
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
    expect(a.manifest['record_counts']).toEqual({ in: 2, out: 3 })
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
    expect(seal(remote).status).toBe(0)
    expect(inspectArchive(remote.archive).manifest['source_kind']).toBe('remote-uncollected')
  })
})
