/**
 * Native TSP editor edits use UTF-16 offsets. Length is an optimistic edit
 * precondition: an event against an older draft must not overwrite new input.
 */
import type { Key } from '@stencil-hq/tern'

export interface NativeEdit {
  readonly from: number
  readonly to: number
  readonly text: string
  readonly cursor: number
  readonly len: number
}

export class Draft {
  private value = ''
  private caret = 0
  private readonly undoStack: Array<{ text: string; cursor: number }> = []

  get text(): string { return this.value }
  get cursor(): number { return this.caret }

  set(value: string): void {
    this.undoStack.push({ text: this.value, cursor: this.caret })
    this.value = value
    this.caret = value.length
  }

  edit(ev: NativeEdit): boolean {
    if (
      ev.len !== this.value.length
      || !Number.isSafeInteger(ev.from)
      || !Number.isSafeInteger(ev.to)
      || !Number.isSafeInteger(ev.cursor)
      || ev.from < 0
      || ev.to < ev.from
      || ev.to > this.value.length
    ) return false
    this.undoStack.push({ text: this.value, cursor: this.caret })
    this.value = this.value.slice(0, ev.from) + ev.text + this.value.slice(ev.to)
    this.caret = Math.max(0, Math.min(this.value.length, ev.cursor))
    return true
  }

  undo(): boolean {
    const previous = this.undoStack.pop()
    if (!previous) return false
    this.value = previous.text
    this.caret = previous.cursor
    return true
  }

  /** Apply PTY keys decoded by the public Tern SDK; TSP edit events are not typing. */
  key(key: Key): boolean {
    const before = this.value
    const at = this.caret
    const prev = (): number => {
      if (!at) return 0
      const tail = before.charCodeAt(at - 1)
      const head = before.charCodeAt(at - 2)
      return Math.max(0, at - (tail >= 0xdc00 && tail <= 0xdfff
        && head >= 0xd800 && head <= 0xdbff ? 2 : 1))
    }
    const next = (): number =>
      Math.min(before.length, at + ((before.codePointAt(at) ?? 0) > 0xffff ? 2 : 1))
    const replace = (from: number, to: number, text: string): boolean => {
      if (from === to && !text) return false
      this.undoStack.push({ text: before, cursor: at })
      this.value = before.slice(0, from) + text + before.slice(to)
      this.caret = from + text.length
      return true
    }
    if (key.ctrl && key.name === 'z') return this.undo()
    if (key.name === 'left') { this.caret = prev(); return this.caret !== at }
    if (key.name === 'right') { this.caret = next(); return this.caret !== at }
    if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      this.caret = at === 0 ? 0 : before.lastIndexOf('\n', at - 1) + 1
      return this.caret !== at
    }
    if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      const end = before.indexOf('\n', at)
      this.caret = end < 0 ? before.length : end
      return this.caret !== at
    }
    if (key.name === 'up' || key.name === 'down') {
      const start = at === 0 ? 0 : before.lastIndexOf('\n', at - 1) + 1
      const col = at - start
      if (key.name === 'up') {
        if (!start) return false
        const previousEnd = start - 1
        const previousStart = before.lastIndexOf('\n', previousEnd - 1) + 1
        this.caret = previousStart + Math.min(col, previousEnd - previousStart)
      } else {
        const end = before.indexOf('\n', at)
        if (end < 0) return false
        const nextEnd = before.indexOf('\n', end + 1)
        this.caret = end + 1 + Math.min(col, (nextEnd < 0 ? before.length : nextEnd) - end - 1)
      }
      return this.caret !== at
    }
    if (key.name === 'backspace') return at ? replace(prev(), at, '') : false
    if (key.name === 'delete') return at < before.length ? replace(at, next(), '') : false
    if (key.name === 'enter') return key.shift || key.alt ? replace(at, at, '\n') : false
    if (key.name === 'tab' && !key.ctrl && !key.meta && !key.alt) return replace(at, at, '\t')
    if (key.ctrl || key.alt || key.meta) return false
    if (key.text === undefined || key.text.length === 0) return false
    return replace(at, at, key.text)
  }

  /** Set an editor value only when it actually changes; retain caret when requested. */
  restore(text: string, cursor: number): void {
    this.value = text
    this.caret = Math.max(0, Math.min(text.length, cursor))
    this.undoStack.length = 0
  }

  take(): string {
    const value = this.value
    this.value = ''
    this.caret = 0
    this.undoStack.length = 0
    return value
  }
}
