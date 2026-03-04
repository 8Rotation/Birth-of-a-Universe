/**
 * min-heap.ts — Array-backed binary min-heap.
 *
 * O(log N) push / pop, O(1) peek / length, O(1) clear.
 *
 * Used for the pending-particle priority queue (keyed by arrivalTime)
 * to replace the old sorted-array + splice/shift approach that was
 * O(N) per insert and O(N) per extract.
 */

export class MinHeap<T> {
  private data: T[] = [];
  private readonly key: (item: T) => number;

  constructor(key: (item: T) => number) {
    this.key = key;
  }

  get length(): number {
    return this.data.length;
  }

  /** Insert an item. O(log N). */
  push(item: T): void {
    this.data.push(item);
    this._bubbleUp(this.data.length - 1);
  }

  /** Return the minimum item without removing it. O(1). */
  peek(): T | undefined {
    return this.data[0];
  }

  /** Remove and return the minimum item. O(log N). */
  pop(): T | undefined {
    const d = this.data;
    const n = d.length;
    if (n === 0) return undefined;
    const top = d[0];
    if (n === 1) {
      d.length = 0;
      return top;
    }
    d[0] = d[n - 1];
    d.length = n - 1;
    this._sinkDown(0);
    return top;
  }

  /** Remove all items. O(1). */
  clear(): void {
    this.data.length = 0;
  }

  // ── Internal heap operations ──────────────────────────────────────

  private _bubbleUp(i: number): void {
    const d = this.data;
    const k = this.key;
    const item = d[i];
    const itemKey = k(item);
    while (i > 0) {
      const pi = (i - 1) >> 1;
      const parent = d[pi];
      if (itemKey >= k(parent)) break;
      d[i] = parent;
      i = pi;
    }
    d[i] = item;
  }

  private _sinkDown(i: number): void {
    const d = this.data;
    const k = this.key;
    const n = d.length;
    const item = d[i];
    const itemKey = k(item);
    while (true) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      let smallest = l;
      let smallestKey = k(d[l]);
      if (r < n) {
        const rKey = k(d[r]);
        if (rKey < smallestKey) {
          smallest = r;
          smallestKey = rKey;
        }
      }
      if (itemKey <= smallestKey) break;
      d[i] = d[smallest];
      i = smallest;
    }
    d[i] = item;
  }
}
