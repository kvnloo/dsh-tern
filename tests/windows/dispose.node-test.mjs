import assert from 'node:assert/strict'
import test from 'node:test'
import { ConptyPeer } from './conpty-peer.mjs'

test('dispose waits for the native child exit before releasing subscriptions', async () => {
  let exited
  let dataDisposed = false
  let exitDisposed = false
  const terminal = {
    onData() { return { dispose() { dataDisposed = true } } },
    onExit(callback) {
      exited = callback
      return { dispose() { exitDisposed = true } }
    },
    kill() {
      setImmediate(() => {
        assert.equal(dataDisposed, false)
        assert.equal(exitDisposed, false)
        exited({ exitCode: 1 })
      })
    },
  }
  const peer = new ConptyPeer(terminal, 'native')
  await peer.dispose()
  assert.equal(peer.exit.code, 1)
  assert.equal(dataDisposed, true)
  assert.equal(exitDisposed, true)
})
