/** Async ownership stack: unwind every acquired listener/resource on any exit. */
export class ResourceStack {
  private finalizers: Array<() => void | Promise<void>> = []

  add(finalizer: () => void | Promise<void>): void {
    this.finalizers.push(finalizer)
  }

  async close(): Promise<void> {
    const errors: unknown[] = []
    for (const finalizer of this.finalizers.splice(0).reverse()) {
      try { await finalizer() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'TUI resource cleanup failed')
  }
}
