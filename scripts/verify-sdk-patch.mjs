import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const path = fileURLToPath(new URL('../patches/@stencil-hq__tern@0.1.0.patch', import.meta.url))
const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
assert.equal(actual, 'c222b3495ade7f7b334ae4f5f94be05b2b4edb2764645dd1972f90ad436e0998',
  'qualified Tern SDK 0.1.0 patch bytes changed; require a new witnessed qualification')
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
assert.equal(pkg.devDependencies['@stencil-hq/tern'], '0.1.0')
assert.equal(pkg.dependencies?.['@stencil-hq/tern'], undefined, 'patched SDK must only be bundled, never installed unpatched at runtime')
process.stdout.write('Qualified Tern 0.1.0 patch bytes and dependency pin verified.\n')
