export class ByteCache<K, V> {
  private entries = new Map<K, { value: V; size: number }>();
  private bytes = 0;

  private limit: number;
  constructor(limit: number) { this.limit = limit; }
  get(key: K): V | undefined { return this.entries.get(key)?.value; }
  keys() { return this.entries.keys(); }
  delete(key: K) {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.size; this.entries.delete(key); }
  }
  set(key: K, value: V, size: number) {
    this.delete(key);
    size += 128 + (typeof key === 'string' ? key.length * 2 : 0);
    if (size > this.limit) return;
    while (this.bytes + size > this.limit) this.delete(this.entries.keys().next().value as K);
    this.entries.set(key, { value, size });
    this.bytes += size;
  }
}
