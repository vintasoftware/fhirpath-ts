/** Small LRU built on Map insertion order; get() refreshes recency. */
export class LruCache<V> {
  private readonly capacity: number
  private readonly entries = new Map<string, V>()

  constructor(capacity: number) {
    this.capacity = capacity
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key)
    if (value !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, value)
    }
    return value
  }

  set(key: string, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key)
    } else if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) {
        this.entries.delete(oldest)
      }
    }
    this.entries.set(key, value)
  }

  get size(): number {
    return this.entries.size
  }
}
