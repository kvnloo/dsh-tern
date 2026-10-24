/**
 * Explicit consumer release gate. Requires a built host library and access to
 * npm's public registry (or REGISTRY_TERN_TARBALL pointing to the raw 0.1.0
 * package). Never installs providers, publishes or changes another repo.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicEnvironment } from '../../scripts/public-environment.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'dsh-tui-packed-'))
const run = (tool, args, cwd = root, env = process.env) =>
  execFileSync(tool, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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
  for (const entry of ['index', 'startup']) {
    assert.equal(readFileSync(join(packed, 'lib', entry + '.js'), 'utf8'),
      readFileSync(join(root, 'lib', entry + '.js'), 'utf8'),
      'both packed runtime exports must be present and byte-identical to the final bundles')
  }
  assert.deepEqual(readdirSync(join(packed, 'lib/types')).filter(name => name.endsWith('.js')), [],
    'unbundled compiler intermediates must not ship beside the qualified SDK bundle')
  const lib = readFileSync(join(packed, 'lib/index.js'), 'utf8')
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
  for (const name of ['home', 'config', 'cache', 'dsh', 'agents']) {
    mkdirSync(join(temp, name))
  }
  const consumer = join(temp, 'npm-consumer')
  mkdirSync(consumer)
  // A plugin consumer supplies the pinned host peers. In particular, npm's
  // automatic optional-peer selection otherwise chooses stable include1.0.10,
  // which requires stable loader1.0.6 instead of this host's alpha loader.
  // Resolve the real published host graph explicitly, never --force or
  // --legacy-peer-deps, and still import both public exports below.
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'dsh-tern-consumer', private: true, type: 'module',
    dependencies: {
      ...config.peerDependencies,
      '@deepseek-ai/cordis-plugin-include': config.devDependencies['@deepseek-ai/cordis-plugin-include'],
    },
  }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    join(localDir, localArchives[0])], consumer)
  const installed = JSON.parse(readFileSync(
    join(consumer, 'node_modules/@kvnloo/dsh-tern/package.json'), 'utf8'))
  assert.equal(installed.name, '@kvnloo/dsh-tern')
  assert.equal(installed.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.deepEqual(installed.exports['.'], config.exports['.'])
  assert.deepEqual(installed.exports['./startup'], config.exports['./startup'])
  assert.equal(readFileSync(
    join(consumer, 'node_modules/@kvnloo/dsh-tern/lib/index.js'), 'utf8'), lib,
    'clean npm consumer must load identical patched production runtime bytes')
  // Import by the same public specifiers used by Cordis, in a fresh process
  // outside the checkout. Reading bytes alone cannot exercise exports or peers.
  run(process.execPath, ['--input-type=module', '--eval', [
    "import assert from 'node:assert/strict'",
    "const startup = await import('@kvnloo/dsh-tern/startup')",
    "const app = await import('@kvnloo/dsh-tern')",
    "assert.equal(startup.name, 'tui-startup')",
    "assert.equal(app.name, 'tui-app')",
    "assert.equal(typeof startup.apply, 'function')",
    "assert.equal(typeof app.apply, 'function')",
  ].join('\n')], consumer, publicEnvironment(temp))

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
  // CI retains the exact already-tested archive, never a separate repack.
  // The receipt certifies this packed consumer gate, not native acceptance.
  if (process.env.DSH_TUI_PACKED_ARTIFACT_DIR) {
    const destination = resolve(process.env.DSH_TUI_PACKED_ARTIFACT_DIR)
    mkdirSync(destination, { recursive: true })
    const archive = localArchives[0]
    const tarball = join(localDir, archive)
    copyFileSync(tarball, join(destination, archive))
    writeFileSync(join(destination, 'packed-consumer-receipt.json'), JSON.stringify({
      schema_version: 1,
      plugin_commit: run('git', ['rev-parse', 'HEAD']).trim(),
      package_name: config.name,
      tarball: archive,
      tarball_sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
      gate: 'test:packed',
      imports: ['@kvnloo/dsh-tern/startup', '@kvnloo/dsh-tern'],
      registry_negative_control: '@stencil-hq/tern@0.1.0',
    }, null, 2) + '\n')
  }
  process.stdout.write('Packed TUI embeds the patched SDK; unpatched registry 0.1.0 is a negative control.\n')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
