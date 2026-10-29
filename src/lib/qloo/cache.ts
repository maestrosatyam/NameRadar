/** Small bounded TTL + LRU cache for private, server-side Qloo response caching. */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { maxEntries: number; ttlMs: number; now?: () => number }) {
    this.maxEntries = opts.maxEntries;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
