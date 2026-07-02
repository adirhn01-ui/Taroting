import { describe, expect, it } from "vitest";
import { History } from "./history";

describe("History", () => {
  it("undoes and redoes in order", () => {
    const h = new History<number>();
    // states: 0 -> 1 -> 2 (push the BEFORE state on each mutation)
    h.push(0);
    h.push(1);
    let current = 2;

    current = h.undo(current)!;
    expect(current).toBe(1);
    current = h.undo(current)!;
    expect(current).toBe(0);
    expect(h.canUndo).toBe(false);
    expect(h.undo(current)).toBeNull();

    current = h.redo(current)!;
    expect(current).toBe(1);
    current = h.redo(current)!;
    expect(current).toBe(2);
    expect(h.canRedo).toBe(false);
  });

  it("clears redo on a new mutation", () => {
    const h = new History<number>();
    h.push(0);
    let current = 1;
    current = h.undo(current)!; // back to 0
    expect(h.canRedo).toBe(true);
    h.push(current); // new branch
    expect(h.canRedo).toBe(false);
  });

  it("clear() empties both stacks", () => {
    const h = new History<number>();
    h.push(0);
    h.undo(1);
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});
