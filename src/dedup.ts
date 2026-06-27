/**
 * dedup.ts — a tiny TTL-bounded "seen ids" set.
 *
 * Slack delivers events at-least-once: if Iris does not ack within ~3s, or on
 * a websocket reconnect, the same event/message can arrive again. Without
 * de-duplication the same prompt is sent to Claude twice (duplicate runs) and
 * the same button click could be processed twice. We remember recently seen
 * ids and reject repeats.
 *
 * Kept free of timers and IO so it can be unit-tested by injecting `now`.
 */
export class SeenSet {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(ttlMs = 5 * 60 * 1000, max = 5000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  /**
   * Record `id` as seen at time `now`. Returns true if this id is fresh
   * (first time within the TTL), false if it is a duplicate. Falsy ids are
   * always treated as fresh (cannot dedup what we can't key on).
   */
  check(id: string | undefined, now: number): boolean {
    if (!id) return true;
    const prev = this.seen.get(id);
    if (prev !== undefined && now - prev < this.ttlMs) {
      // Refresh the timestamp so a burst of retries keeps being rejected.
      this.seen.set(id, now);
      return false;
    }
    this.seen.set(id, now);
    this.prune(now);
    return true;
  }

  /** Drop expired entries; hard-cap the map size to bound memory. */
  private prune(now: number): void {
    for (const [id, ts] of this.seen) {
      if (now - ts >= this.ttlMs) this.seen.delete(id);
    }
    if (this.seen.size > this.max) {
      // Evict oldest-inserted first (Map preserves insertion order).
      const overflow = this.seen.size - this.max;
      let i = 0;
      for (const id of this.seen.keys()) {
        if (i++ >= overflow) break;
        this.seen.delete(id);
      }
    }
  }
}
