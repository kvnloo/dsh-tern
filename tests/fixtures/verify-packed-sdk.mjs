/**
 * Explicit consumer release gate. Requires a built host library and access to
 * npm's public registry (or REGISTRY_TERN_TARBALL pointing to the raw 0.1.0
 * package). Never installs providers, publishes or changes another repo.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'dsh-tui-packed-'))
const run = (tool, args, cwd = root) =>
  execFileSync(tool, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const unpack = (tarball, folder) => {
  mkdirSync(folder, { recursive: true })
  run('tar', ['-xzf', tarball, '-C', folder])
  return join(folder, 'package')
}
try {
  const localDir = join(temp, 'local')
  const registryDir = join(temp, 'registry')
  mkdirSync(localDir)
  mkdirSync(registryDir)
  run('pnpm', ['pack', '--pack-destination', localDir])
  const localArchives = readdirSync(localDir).filter(name => name.endsWith('.tgz'))
  assert.equal(localArchives.length, 1, 'one packed tui-app tarball')
  const packed = unpack(join(localDir, localArchives[0]), join(temp, 'packed'))
  const lib = readFileSync(join(packed, 'lib/index.js'), 'utf8')
  const config = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'))
  assert.equal(config.dependencies['@stencil-hq/tern'], '0.1.0')
  assert.doesNotMatch(lib, /(?:from\s*|import\s*\()\s*['"]@stencil-hq\/tern(?:['"/]|$)/)
  assert.match(lib, /\bforget\s*\(\s*ids\s*\)\s*\{/, 'Surface.forget method body must be bundled')
  assert.match(lib, /\bonAck\s*\(\s*listener\s*\)\s*\{/, 'Surface.onAck method body must be bundled')

  const supplied = process.env.REGISTRY_TERN_TARBALL
  if (!supplied) {
    run('npm', ['pack', '@stencil-hq/tern@0.1.0', '--ignore-scripts',
      '--registry=https://registry.npmjs.org', '--pack-destination', registryDir], temp)
  }
  const registryArchives = supplied ? [supplied] :
    readdirSync(registryDir).filter(name => name.endsWith('.tgz')).map(name => join(registryDir, name))
  assert.equal(registryArchives.length, 1, 'one unpatched registry SDK tarball')
  const raw = unpack(registryArchives[0], join(temp, 'raw-sdk'))
  const sdk = readFileSync(join(raw, 'dist/surface.js'), 'utf8')
  assert.doesNotMatch(sdk, /\bforget\s*\(/, 'negative control must be unpatched 0.1.0')
  assert.doesNotMatch(sdk, /\bonAck\s*\(/, 'negative control must be unpatched 0.1.0')
  const wire = readFileSync(join(raw, 'dist/wire.js'), 'utf8')
  assert.doesNotMatch(wire, /num\(raw,\s*['"]v['"]\)\s*!==\s*PROTOCOL_VERSION/,
    'negative control must lack the workspace hello guard')
  process.stdout.write('Packed TUI embeds the patched SDK; unpatched registry 0.1.0 is a negative control.\n')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
