#!/usr/bin/env node
/**
 * Run the unchanged public Agent/Session PTY cases against the pinned real host.
 * Package installation is ONE ordinary dsh plugin command in a private profile,
 * not a manual symlink, fake bundle activation, or alternate runtime.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const root = fileURLToPath(new URL('../', import.meta.url))
const mode = process.argv[2]
assert.ok(mode === 'src' || mode === 'lib', 'expected src or lib')
const host = process.env.DSH_HOST_ROOT
assert.ok(host && isAbsolute(host), 'DSH_HOST_ROOT must be the absolute pinned host checkout')
const actualHostSha = execFileSync('git', ['-C', host, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
assert.equal(actualHostSha, '5badb15009ae1756c3afe0ae0cef1faafc290ccc',
  'public test host baseline must be the unmodified pinned DSH master')
const privateRoot = mkdtempSync(join(tmpdir(), 'dsh-tern-public-'))
chmodSync(privateRoot, 0o700)
const profileHome = join(privateRoot, 'dsh')
const packages = join(privateRoot, 'packages')
for (const name of ['home', 'config', 'cache', 'agents', 'dsh', 'packages']) {
  mkdirSync(join(privateRoot, name), { mode: 0o700 })
}
const environment = {
  ...Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'TMPDIR', 'TZ']
    .flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])),
  HOME: join(privateRoot, 'home'),
  XDG_CONFIG_HOME: join(privateRoot, 'config'),
  XDG_CACHE_HOME: join(privateRoot, 'cache'),
  DSH_HOME: profileHome,
  DSH_AGENTS_HOME: join(privateRoot, 'agents'),
  DSH_TELEMETRY_DISABLED: '1',
  TERM: 'xterm-256color',
}
const run = (program, args, cwd, env = environment) => execFileSync(program, args, {
  cwd, env, stdio: 'inherit', timeout: args.includes('vitest') ? 1_800_000 : 600_000,
})
try {
  // prepack builds the patched SDK bundle. The resulting tarball, not a source
  // link, is the exact spec handed to the public plugin manager.
  run('pnpm', ['pack', '--pack-destination', packages], root, environment)
  const archives = readdirSync(packages).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1, 'exactly one local packed plugin')
  const archive = resolve(packages, archives[0])
  const launch = resolveExampleLaunch({
    srcBin: join(host, 'apps/cli/src/bin.ts'),
    tsconfigPath: join(host, 'tsconfig.json'), sourceImport: 'tsx/esm', mode,
  })
  run(launch.command,
    [...launch.args, 'plugin', '--profile', 'tui', 'add', archive], host,
    { ...environment, ...launch.env })
  const profile = JSON.parse(readFileSync(join(profileHome, 'profiles/tui/package.json'), 'utf8'))
  assert.ok(profile.dependencies?.['@kvnloo/dsh-tern'], 'real plugin add must install the external bundle')
  assert.deepEqual(profile.dsh?.profile?.bundles,
    ['@deepseek-ai/dsh-base', '@kvnloo/dsh-tern'], 'base and plugin patch layer order')
  const installed = JSON.parse(readFileSync(join(profileHome, 'profiles/tui/node_modules/@kvnloo/dsh-tern/package.json'), 'utf8'))
  assert.equal(installed.name, '@kvnloo/dsh-tern')
  assert.equal(installed.dsh.bundle.patch, './cordis.patch.yml')
  run('pnpm', ['exec', 'vitest', 'run', '--retry=0',
    'tests/host/tests/keyless.e2e.ts', 'tests/host/tests/public-services.e2e.ts'], root, {
      ...environment, DSH_HOST_ROOT: host, DSH_EXAMPLE_MODE: mode,
      DSH_TUI_PROFILE_HOME: profileHome, DSH_TUI_PACKAGE_TARBALL: archive,
      DSH_TELEMETRY_DISABLED: '1',
    })
} finally {
  if (process.env.DSH_TUI_KEEP_PRIVATE === '1') {
    process.stderr.write('Private public-gate artifacts retained at ' + privateRoot + '\n')
  } else {
    rmSync(privateRoot, { recursive: true, force: true })
  }
}
