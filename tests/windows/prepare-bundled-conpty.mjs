import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Test-only change to the real native Windows addon. Never modify the product
// SDK, synthesize child output, or substitute a parser for the ConPTY handles.
const directory = fileURLToPath(new URL('.', import.meta.url))
const dependency = join(directory, 'node_modules/node-pty')
const source = join(dependency, 'src/win/conpty.cc')
const patch = join(directory, 'node-pty-passthrough.patch')
const originalBlob = '7b286d3d644c26141df516929703aa6e129df4b2'
const patchedBlob = '81e9dc7d1e0fc9bf35301200064fe0715eb100c8'
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
assert.equal(process.platform, 'win32')
assert.equal(JSON.parse(readFileSync(join(dependency, 'package.json'), 'utf8')).version, '1.1.0')
assert.equal(createHash('sha256').update(readFileSync(patch)).digest('hex'),
  '68ef3401195af62392c04b61b8acbdbb84a39079c733fb0c5ba4d1ef6f1ec84c')
assert.equal(blobHash(readFileSync(source)), originalBlob, 'installed native source must match the immutable upstream Git blob')
execFileSync('git', ['apply', '--unsafe-paths', '--unidiff-zero', '--directory', dependency.replaceAll('\\', '/'), patch], {
  cwd: tmpdir(), stdio: 'inherit', timeout: 20_000,
})
assert.equal(blobHash(readFileSync(source)), patchedBlob, 'only the reviewed native passthrough flag may change')
console.log('Prepared test-only bundled-conpty-passthrough native source; rebuild the real addon before the gate.')
