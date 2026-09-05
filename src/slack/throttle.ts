/**
 * slack-throttle.ts — per-thread send queue that serialises outbound Slack API
 * calls and enforces a minimum interval between them.
 *
 * Slack rate-limits chat.postMessage / chat.update at Tier 3 (50 req/min) with
 * an additional ~1 req/sec burst cap.  When the bot exceeds the threshold the
 * Slack *UI* silently hides messages ("Due to a high volume of activity…").
 * Proactive throttling avoids this by spacing calls apart.
 */

const DEFAULT_MIN_INTERVAL_MS = 3_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A per-key (typically thread_ts or channel) serialising throttle.
 *
 * Every call to `enqueue(key)` returns a promise that resolves only after
 * `minIntervalMs` has elapsed since the *previous* call for the same key
 * completed.  Calls are chained so concurrent enqueues never overlap.
 */
export class SlackThrottle {
	private readonly minIntervalMs: number;
	/** Timestamp of the last completed send per key. */
	private lastSend = new Map<string, number>();
	/** Promise chain per key — serialises concurrent callers. */
	private chains = new Map<string, Promise<void>>();

	constructor(minIntervalMs = DEFAULT_MIN_INTERVAL_MS) {
		this.minIntervalMs = minIntervalMs;
	}

	/**
	 * Wait until it is safe to send to `key`.  Returns a promise that resolves
	 * once the minimum interval has been respected.
	 */
	enqueue(key: string): Promise<void> {
		const prev = this.chains.get(key) ?? Promise.resolve();
		const next = prev.then(() => this.waitMinInterval(key));
		// Swallow errors so a failed send doesn't break the chain for later callers.
		this.chains.set(
			key,
			next.catch(() => {}),
		);
		return next;
	}

	private async waitMinInterval(key: string): Promise<void> {
		const now = Date.now();
		const last = this.lastSend.get(key) ?? 0;
		const wait = Math.max(0, this.minIntervalMs - (now - last));
		if (wait > 0) await sleep(wait);
		this.lastSend.set(key, Date.now());
	}
}
