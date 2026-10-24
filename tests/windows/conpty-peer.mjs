/**
 * Real Windows ConPTY peer. The only simulated party is the remote Tern
 * terminal: all observed bytes originate from node-pty's OS ConPTY child.
 * Reuse the TSP wire shapes and semantic reconciliation from the retained
 * Linux driver (tests/host/harness/pty_driver.py); do not mock a renderer.
 */
export class GateFailure extends Error {
  constructor(reason) { super(reason); this.name = 'GateFailure' }
}
export function requireGate(condition, reason) {
  if (!condition) throw new GateFailure(reason)
}

const APC = '\x1b_tsp;'
const ST = '\x1b\\'
const DA1 = '\x1b[?1;2c'
const MAX_OUTPUT = 8 * 1024 * 1024
const HELLO = Object.freeze({
  r: 'hello', v: 1, term: 'tern', ver: '0.1.0',
  kinds: ['text', 'row', 'col', 'card', 'md', 'editor', 'input', 'el'],
  features: ['edit', 'undo', 'send', 'settle'],
  apc: 4096, credits: 16, cols: 100,
  cell: { w: 8, h: 16 }, dark: true, reduceMotion: false,
})

export class ConptyPeer {
  constructor(pty, mode) {
    requireGate(mode === 'native' || mode === 'fallback', 'invalid peer mode')
    this.pty = pty
    this.mode = mode
    this.output = ''
    this.cursor = 0
    this.queryCount = 0
    this.osc877 = { hello: 0, events: 0 }
    this.opens = []
    this.closes = []
    this.frames = []
    this.acks = new Set()
    this.chunks = new Map()
    this.chunkPackets = 0
    this.nodes = new Map()
    this.changes = []
    this.transportErrors = []
    this.exit = null
    this.failure = null
    this.waiters = new Set()
    this.dataSubscription = pty.onData(data => {
      try {
        requireGate(typeof data === 'string', 'ConPTY output is not a decoded stream')
        this.output += data
        requireGate(Buffer.byteLength(this.output) <= MAX_OUTPUT, 'ConPTY output exceeded 8 MiB bound')
        this.scan()
      } catch (error) {
        this.failure = error
      }
      this.notify()
    })
    this.exitSubscription = pty.onExit(event => {
      this.exit = { code: event.exitCode, signal: event.signal ?? 0 }
      this.notify()
    })
  }

  notify() { for (const callback of [...this.waiters]) callback() }

  write(bytes) {
    requireGate(this.exit === null, 'ConPTY child already exited before terminal input')
    this.pty.write(bytes)
  }

  sendOsc877(verb, value) {
    const body = typeof value === 'string' ? value : JSON.stringify(value)
    this.write('\x1b]877;tsp;' + verb + ';' + body + ST)
    if (verb === 'r') this.osc877.hello++
    else if (verb === 'e') this.osc877.events++
  }

  scan() {
    if (this.queryCount === 0 && this.output.includes(APC + 'q;')) {
      this.queryCount++
      if (this.mode === 'native') this.sendOsc877('r', HELLO)
      else this.write(DA1)
    }
    for (;;) {
      const start = this.output.indexOf(APC, this.cursor)
      if (start < 0) {
        this.cursor = Math.max(0, this.output.length - APC.length + 1)
        return
      }
      const verbStart = start + APC.length
      const divider = this.output.indexOf(';', verbStart)
      if (divider < 0) { this.cursor = start; return }
      const verb = this.output.slice(verbStart, divider)
      if (verb === 'q') { this.cursor = divider + 1; continue }
      const end = this.output.indexOf(ST, divider + 1)
      if (end < 0) { this.cursor = start; return }
      const payload = this.output.slice(divider + 1, end)
      this.cursor = end + ST.length
      try { this.consume(verb, payload) }
      catch (error) {
        this.transportErrors.push(error instanceof GateFailure ? error.message : 'unparseable native TSP carrier')
      }
    }
  }

  reassemble(verb, body) {
    const params = new Map()
    let rest = body
    while (rest.startsWith('c=') || rest.startsWith('m=')) {
      const delimiter = rest.indexOf(';')
      requireGate(delimiter > 0, 'unterminated native TSP chunk parameter')
      const parameter = rest.slice(0, delimiter)
      const equals = parameter.indexOf('=')
      requireGate(equals > 0, 'malformed native TSP chunk parameter')
      const key = parameter.slice(0, equals)
      const value = parameter.slice(equals + 1)
      requireGate(value.length > 0 && !params.has(key), 'duplicate or empty TSP chunk parameter')
      params.set(key, value)
      rest = rest.slice(delimiter + 1)
    }
    const id = params.get('c')
    if (!id) {
      requireGate(params.size === 0, 'orphan native TSP continuation')
      return rest
    }
    requireGate(!params.has('m') || ['0', '1'].includes(params.get('m')), 'invalid TSP continuation')
    const key = verb + ':' + id
    const parts = this.chunks.get(key) ?? []
    parts.push(rest)
    this.chunkPackets++
    requireGate(parts.join('').length <= 2 * 1024 * 1024, 'native TSP frame exceeds 2 MiB')
    if (params.get('m') === '1') { this.chunks.set(key, parts); return null }
    this.chunks.delete(key)
    return parts.join('')
  }

  consume(verb, carrier) {
    if (!['f', 'o', 'x', 'e'].includes(verb)) return
    const content = this.reassemble(verb, carrier)
    if (content === null) return
    let message
    try { message = JSON.parse(content) }
    catch { throw new GateFailure('invalid JSON from actual ConPTY TSP packet') }
    requireGate(message !== null && typeof message === 'object' && !Array.isArray(message),
      'non-object native TSP payload')
    if (verb === 'o') this.opens.push(message)
    if (verb === 'x') this.closes.push(message)
    if (verb === 'e' && message.ev === 'error') {
      this.transportErrors.push('real child emitted TSP error')
    }
    if (verb !== 'f') return
    requireGate(typeof message.sf === 'string' && Number.isSafeInteger(message.s)
      && message.s > 0 && Array.isArray(message.ops), 'invalid native semantic frame')
    this.frames.push(message)
    this.applyFrame(message)
    const key = message.sf + ':' + message.s
    if (!this.acks.has(key)) {
      this.acks.add(key)
      this.sendOsc877('e', { ev: 'ack', sf: message.sf, s: message.s })
    }
  }

  removeNode(id) {
    for (const nodeId of [...this.nodes.keys()]) {
      if (nodeId === id || nodeId.startsWith(id + '.')) this.nodes.delete(nodeId)
    }
  }

  remember(doc) {
    if (doc === null || typeof doc !== 'object') return
    if (typeof doc.id === 'string') {
      const entry = { k: doc.k, p: { ...(doc.p ?? {}) } }
      this.nodes.set(doc.id, entry)
      this.changes.push({ frame: this.frames.length, id: doc.id, k: entry.k, p: { ...entry.p } })
    }
    if (Array.isArray(doc.c)) for (const child of doc.c) this.remember(child)
  }

  changed(id) {
    const entry = this.nodes.get(id)
    if (entry) this.changes.push({ frame: this.frames.length, id, k: entry.k, p: { ...entry.p } })
  }

  applyFrame(frame) {
    for (const op of frame.ops) {
      if (!Array.isArray(op)) continue
      if (op[0] === 'add' && op[4]?.id) {
        this.removeNode(op[4].id)
        this.remember(op[4])
      } else if (op[0] === 'text' && typeof op[1] === 'string' && typeof op[3] === 'string') {
        const entry = this.nodes.get(op[1])
        if (!entry) continue
        entry.p.text = op[2] === 'append' ? (entry.p.text ?? '') + op[3] : op[3]
        this.changed(op[1])
      } else if (['props', 'set', 'prop', 'patch'].includes(op[0]) && typeof op[1] === 'string') {
        const entry = this.nodes.get(op[1])
        if (!entry) continue
        if (op[2] && typeof op[2] === 'object' && !Array.isArray(op[2]))
          Object.assign(entry.p, op[2])
        else if (typeof op[2] === 'string' && op.length >= 4)
          entry.p[op[2]] = op[3]
        this.changed(op[1])
      } else if (op[0] === 'del' && typeof op[1] === 'string') {
        this.removeNode(op[1])
      }
    }
    requireGate(this.changes.length <= 200_000, 'native semantic event bound exceeded')
  }

  nodeMatches(condition, afterFrame = 0) {
    return this.changes.some(change => {
      if (change.frame <= afterFrame) return false
      if (condition.id && condition.id !== change.id) return false
      if (condition.contains && (typeof change.p.text !== 'string'
        || !change.p.text.includes(condition.contains))) return false
      for (const key of ['text', 'cursor', 'sendable']) {
        if (Object.hasOwn(condition, key) && change.p[key] !== condition[key]) return false
      }
      return true
    })
  }

  waitFor(predicate, phase, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      let timer
      const check = () => {
        let ready = false
        try { ready = predicate() }
        catch (error) { finish(error); return }
        if (this.failure) return finish(this.failure)
        if (ready) return finish()
        if (this.exit !== null) return finish(new GateFailure('child exited before ' + phase))
      }
      const finish = error => {
        clearTimeout(timer)
        this.waiters.delete(check)
        if (error) reject(error)
        else resolve()
      }
      this.waiters.add(check)
      timer = setTimeout(() => finish(new GateFailure('deadline exceeded: ' + phase)), timeoutMs)
      check()
    })
  }

  waitForExit(timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      if (this.exit) { resolve(this.exit); return }
      let timer
      const check = () => {
        if (!this.exit && !this.failure) return
        clearTimeout(timer)
        this.waiters.delete(check)
        if (this.failure) reject(this.failure)
        else resolve(this.exit)
      }
      this.waiters.add(check)
      timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(new GateFailure('deadline exceeded: real ConPTY child exit'))
      }, timeoutMs)
      check()
    })
  }

  assertTransport(native = true) {
    requireGate(this.failure === null, 'native peer internal failure')
    requireGate(this.chunks.size === 0, 'native child ended with incomplete TSP chunks')
    requireGate(this.transportErrors.length === 0,
      'native child transport RED: ' + (this.transportErrors[0] ?? 'unknown'))
    if (!native) return
    requireGate(this.queryCount === 1 && this.osc877.hello === 1,
      'native ConPTY OSC877 hello did not traverse child input')
    requireGate(this.opens.some(open => open.id === 'dsh'), 'no native inline surface open')
    requireGate(this.frames.some(frame => frame.sf === 'dsh'), 'no native semantic frame: ANSI fallback is not a pass')
    requireGate(this.acks.size > 0 && this.osc877.events > 0,
      'native OSC877 acknowledgment transport missing')
  }

  assertClosed() {
    requireGate(this.exit?.code === 0, 'ordinary /quit did not exit zero')
    requireGate(this.closes.some(close => typeof close.id === 'string' && close.id.startsWith('dsh')),
      'native surface CLOSE (TSP x) missing after /quit')
    requireGate(this.output.includes('\x1b[?2004l'), 'native terminal did not disable bracketed paste')
    requireGate(this.output.includes('\x1b[<u'), 'native terminal did not restore kitty keyboard mode')
    this.assertTransport()
  }

  stats() {
    return {
      backend: 'node-pty/WindowsTerminal/OS-ConPTY',
      queryCount: this.queryCount, sentOsc877Hello: this.osc877.hello,
      sentOsc877Events: this.osc877.events,
      openedSurfaceIds: this.opens.map(item => item.id).filter(v => typeof v === 'string').slice(0, 12),
      closeCount: this.closes.length, semanticFrames: this.frames.length,
      ackCount: this.acks.size, chunkPackets: this.chunkPackets,
      transportErrors: this.transportErrors.length,
      exitCode: this.exit?.code ?? null, exitSignal: this.exit?.signal ?? null,
    }
  }

  async dispose() {
    try {
      if (!this.exit) {
        this.pty.kill()
        // ConPTY releases its child handles asynchronously. Keep the exit
        // subscription alive until shutdown completes before removing files.
        await this.waitForExit(20_000)
      }
      // node-pty1.1.0 closes only outSocket on natural OS-ConPTY exit.
      // Its conout worker and input socket still keep this test process alive.
      // These are owned handles on the already asserted pinned backend.
      const agent = this.pty._agent
      requireGate(typeof agent?._conoutSocketWorker?.dispose === 'function'
        && typeof agent?.inSocket?.destroy === 'function'
        && typeof agent?.outSocket?.destroy === 'function',
      'pinned node-pty ConPTY cleanup handles changed')
      agent._conoutSocketWorker.dispose()
      agent.inSocket.destroy()
      agent.outSocket.destroy()
    } finally {
      this.dataSubscription.dispose()
      this.exitSubscription.dispose()
    }
  }
}
