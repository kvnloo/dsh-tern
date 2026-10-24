import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const installedSdk = join(root, 'node_modules/@stencil-hq/tern')
const candidate = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT']
  .map(filename => join(installedSdk, filename)).find(existsSync)
const source = candidate ?? join(root, 'third_party/stencil-hq-tern-sdk/LICENSE')
const bytes = readFileSync(source)
if (!candidate) {
  const blobHash = createHash('sha1')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  assert.equal(blobHash, 'd90a6ea82277f531056af45928102fa58d71ae0c',
    'vendored SDK MIT notice must match the authentic upstream Git blob')
}
const content = bytes.toString('utf8')
assert.match(content, /MIT License/i)
assert.match(content, /permission is hereby granted/i)
const target = join(root, 'licenses/tern-LICENSE')
mkdirSync(join(root, 'licenses'), { recursive: true })
copyFileSync(source, target)
assert.deepEqual(readFileSync(target), bytes, 'SDK MIT notice must remain byte-identical')
process.stdout.write('Bundled exact upstream Tern SDK MIT notice.\n')
