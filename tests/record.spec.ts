import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TspRecorder } from '../src/record.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('opt-in redacted semantic trace', () => {
  it('records event metadata and caps without a source text payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tsp-metadata-'))
    dirs.push(dir)
    const file = join(dir, 'trace.jsonl')
    const recorder = new TspRecorder(file, 'session-test')
    recorder.write({
      direction: 'in', verb: 'send', parsedBytes: 43, revision: 2, surfaceId: 'dsh',
      caps: { kinds: ['editor'], features: ['settle'], credits: 2, apc: 4096 },
    })
    const raw = readFileSync(file, 'utf8')
    const line = JSON.parse(raw.trim()) as Record<string, unknown>
    expect(line).toMatchObject({
      sessionId: 'session-test', direction: 'in', verb: 'send', parsedBytes: 43,
      revision: 2, surfaceId: 'dsh',
    })
    expect(typeof line.ms).toBe('number')
    expect(raw).not.toContain('prompt')
    expect(raw).not.toContain('"body"')
  })
  it('performs no writes when disabled', () => {
    const recorder = new TspRecorder(undefined, 'session-test')
    expect(() => recorder.write({ direction: 'out', verb: 'render', parsedBytes: 4 })).not.toThrow()
  })
})
