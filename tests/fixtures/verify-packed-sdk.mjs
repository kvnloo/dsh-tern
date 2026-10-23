/**
 * Explicit consumer release gate. Requires a built host library and access to
 * npm's public registry (or REGISTRY_TERN_TARBALL pointing to the raw 0.1.0
 * package). Never installs providers, publishes or changes another repo.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const boundedCloseGuard = /if\s*\(\s*!this\.blocked\s*\)\s*this\.#flush\s*\(\s*\)/
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
  assert.equal(lib, readFileSync(join(root, 'lib/index.js'), 'utf8'),
    'packed production library must be byte-identical to the built native runtime')
  const sdkNotice = readFileSync(join(packed, 'licenses/tern-LICENSE'), 'utf8')
  assert.match(sdkNotice, /MIT License/i, 'SDK original MIT notice must ship in the tarball')
  assert.match(sdkNotice, /permission is hereby granted/i)
  assert.match(readFileSync(join(packed, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    /Can Bölük \/ Stencil Labs/, 'credit text must ship with embedded SDK')
  const config = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'))
  assert.equal(config.devDependencies['@stencil-hq/tern'], '0.1.0')
  assert.equal(config.dependencies?.['@stencil-hq/tern'], undefined,
    'clean npm users must not install the unpatched SDK as a runtime dependency')
  assert.doesNotMatch(lib, /(?:from\s*|import\s*\()\s*['"]@stencil-hq\/tern(?:['"/]|$)/)
  assert.match(lib, /\bforget\s*\(\s*ids\s*\)\s*\{/, 'Surface.forget method body must be bundled')
  assert.match(lib, /\bonAck\s*\(\s*listener\s*\)\s*\{/, 'Surface.onAck method body must be bundled')
  assert.match(lib, boundedCloseGuard,
    'credit-bounded close must survive in the packed SDK, not only workspace tests')

  // Recreate the original RED witness as a real npm consumer, now expected
  // GREEN. This install cannot rely on the source checkout's pnpm patch map,
  // monorepo workspaces, or a fake profile loader.
  const consumer = join(temp, 'npm-consumer')
  mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'),
    JSON.stringify({ name: 'dsh-tern-consumer', private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    join(localDir, localArchives[0])], consumer)
  const installed = JSON.parse(readFileSync(
    join(consumer, 'node_modules/@kvnloo/dsh-tern/package.json'), 'utf8'))
  assert.equal(installed.name, '@kvnloo/dsh-tern')
  assert.equal(installed.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.deepEqual(installed.exports['.'], config.exports['.'])
  assert.equal(readFileSync(
    join(consumer, 'node_modules/@kvnloo/dsh-tern/lib/index.js'), 'utf8'), lib,
    'clean npm consumer must load identical patched production runtime bytes')

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
  assert.doesNotMatch(sdk, boundedCloseGuard,
    'unpatched registry SDK must retain the observed over-credit close negative control')
  const wire = readFileSync(join(raw, 'dist/wire.js'), 'utf8')
  assert.doesNotMatch(wire, /num\(raw,\s*['"]v['"]\)\s*!==\s*PROTOCOL_VERSION/,
    'negative control must lack the workspace hello guard')
  process.stdout.write('Packed TUI embeds the patched SDK; unpatched registry 0.1.0 is a negative control.\n')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
