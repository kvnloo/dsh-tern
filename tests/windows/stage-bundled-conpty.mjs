import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// node-gyp rebuild removes build/Release. Upstream scripts/post-install.js,
// not binding.gyp, stages these official node-pty 1.1.0 package binaries.
const dependency = fileURLToPath(new URL('./node_modules/node-pty/', import.meta.url))
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert.equal(JSON.parse(readFileSync(join(dependency, 'package.json'), 'utf8')).version, '1.1.0')
const source = join(dependency, 'third_party/conpty/1.23.251008001/win10-x64')
const destination = join(dependency, 'build/Release/conpty')
const pins = {
  'conpty.dll': '7c7430632052ff703540b68371ec43821820aa1335d8e11dfbcd9ff00e9daaed',
  'OpenConsole.exe': 'd1fe7faa62f9e955e2ac2371f95d7e5513df4d496255097158f979c94782c5fc',
}
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
// Verify both sources before staging either; never accept runner/prebuilt files.
for (const [name, hash] of Object.entries(pins)) {
  assert.equal(sha256(join(source, name)), hash, `official package ${name} SHA256 mismatch`)
}
mkdirSync(destination, { recursive: true })
for (const [name, hash] of Object.entries(pins)) {
  copyFileSync(join(source, name), join(destination, name))
  assert.equal(sha256(join(destination, name)), hash, `staged ${name} SHA256 mismatch`)
}
console.log('Staged hash-pinned official node-pty 1.1.0 x64 ConPTY binaries after native rebuild.')
