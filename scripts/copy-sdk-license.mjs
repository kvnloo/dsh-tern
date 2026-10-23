import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const installedSdk = join(root, 'node_modules/@stencil-hq/tern')
const candidate = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT']
  .map(filename => join(installedSdk, filename)).find(existsSync)
assert.ok(candidate, 'installed official Tern 0.1.0 distribution must supply its MIT license; do not invent notice text')
const bytes = readFileSync(candidate)
const content = bytes.toString('utf8')
assert.match(content, /MIT License/i)
assert.match(content, /permission is hereby granted/i)
const target = join(root, 'licenses/tern-LICENSE')
mkdirSync(join(root, 'licenses'), { recursive: true })
copyFileSync(candidate, target)
assert.deepEqual(readFileSync(target), bytes, 'SDK MIT notice must remain byte-identical')
process.stdout.write('Bundled exact upstream Tern SDK MIT notice.\n')
