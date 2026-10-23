/** Async ownership stack: unwind every acquired listener/resource on any exit. */
export class ResourceStack {
  private finalizers: Array<() => void | Promise<void>> = []

  /** Register a teardown callback for reverse-acquisition-order disposal.
   * @param finalizer - synchronous or asynchronous release for one owned resource.
   */
  add(finalizer: () => void | Promise<void>): void {
    this.finalizers.push(finalizer)
  }

  /** Release every registered resource even when earlier finalizers fail.
   * @throws AggregateError containing all cleanup failures after unwind completes.
   */
  async close(): Promise<void> {
    const errors: unknown[] = []
    for (const finalizer of this.finalizers.splice(0).reverse()) {
      try { await finalizer() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'TUI resource cleanup failed')
  }
}
