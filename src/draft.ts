/**
 * Native TSP editor edits use UTF-16 offsets. Length is an optimistic edit
 * precondition: an event against an older draft must not overwrite new input.
 */
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

  take(): string {
    const value = this.value
    this.value = ''
    this.caret = 0
    this.undoStack.length = 0
    return value
  }
}
