import assert from 'node:assert/strict'
import test from 'node:test'
import { ConptyPeer } from './conpty-peer.mjs'

test('dispose waits for the native child exit before releasing subscriptions', async () => {
  let exited
  let dataDisposed = false
  let exitDisposed = false
  const released = []
  const terminal = {
    _agent: {
      _conoutSocketWorker: { dispose() { released.push('worker') } },
      inSocket: { destroy() { released.push('input') } },
      outSocket: { destroy() { released.push('output') } },
    },
    onData() { return { dispose() { dataDisposed = true } } },
    onExit(callback) {
      exited = callback
      return { dispose() { exitDisposed = true } }
    },
    kill() {
      setImmediate(() => {
        assert.equal(dataDisposed, false)
        assert.equal(exitDisposed, false)
        assert.deepEqual(released, [])
        exited({ exitCode: 1 })
      })
    },
  }
  const peer = new ConptyPeer(terminal, 'native')
  await peer.dispose()
  assert.equal(peer.exit.code, 1)
  assert.equal(dataDisposed, true)
  assert.equal(exitDisposed, true)
  assert.deepEqual(released, ['worker', 'input', 'output'])
})

test('natural exit still releases the owned conout worker and pipe sockets', async () => {
  let exited
  const released = []
  const terminal = {
    _agent: {
      _conoutSocketWorker: { dispose() { released.push('worker') } },
      inSocket: { destroy() { released.push('input') } },
      outSocket: { destroy() { released.push('output') } },
    },
    onData() { return { dispose() {} } },
    onExit(callback) { exited = callback; return { dispose() {} } },
    kill() { assert.fail('an exited child must not be killed again') },
  }
  const peer = new ConptyPeer(terminal, 'native')
  exited({ exitCode: 0 })
  await peer.dispose()
  assert.deepEqual(released, ['worker', 'input', 'output'])
})
