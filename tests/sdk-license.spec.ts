import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../', import.meta.url))
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sdk-license-'))
  roots.push(root)
  for (const dir of ['scripts', 'node_modules/@stencil-hq/tern', 'third_party/stencil-hq-tern-sdk']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  copyFileSync(join(repo, 'scripts/copy-sdk-license.mjs'), join(root, 'scripts/copy-sdk-license.mjs'))
  const vendored = join(root, 'third_party/stencil-hq-tern-sdk/LICENSE')
  copyFileSync(join(repo, 'third_party/stencil-hq-tern-sdk/LICENSE'), vendored)
  return { root, vendored, target: join(root, 'licenses/tern-LICENSE'), run: () =>
    spawnSync(process.execPath, [join(root, 'scripts/copy-sdk-license.mjs')], { encoding: 'utf8' }) }
}

describe('SDK MIT notice preparation', () => {
  it('copies the installed package notice in preference to the fallback', () => {
    const f = fixture()
    const notice = 'MIT License\nCopyright installed package\nPermission is hereby granted\n'
    writeFileSync(join(f.root, 'node_modules/@stencil-hq/tern/LICENSE.md'), notice)
    writeFileSync(f.vendored, 'unusable fallback')
    expect(f.run().status).toBe(0)
    expect(readFileSync(f.target, 'utf8')).toBe(notice)
  })

  it('copies the hash-verified authentic fallback when the package has no notice', () => {
    const f = fixture()
    expect(f.run().status).toBe(0)
    expect(readFileSync(f.target)).toEqual(readFileSync(f.vendored))
  })

  it('fails closed before copying a tampered fallback, even if it still looks like MIT', () => {
    const f = fixture()
    writeFileSync(f.vendored, readFileSync(f.vendored, 'utf8') + '\n')
    const result = f.run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('vendored SDK MIT notice must match the authentic upstream Git blob')
    expect(existsSync(f.target)).toBe(false)
  })
})
