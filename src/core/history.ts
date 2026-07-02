// Snapshot-based undo/redo. Snapshots are immutable project states —
// clip arrays are tiny, so full snapshots stay cheap even "unlimited".

export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];

  /** Record the state as it was BEFORE a committed mutation. */
  push(before: T): void {
    this.undoStack.push(before);
    this.redoStack.length = 0;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Returns the state to restore, or null. `current` goes to the redo stack. */
  undo(current: T): T | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(current);
    return prev;
  }

  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(current);
    return next;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
