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
 * Every call to `enqueue(key, op)` returns a promise that resolves with the
 * operation's return value.  The operation runs only after `minIntervalMs` has
 * elapsed since the *previous* operation for the same key settled.  Operations
 * are chained so concurrent enqueues never overlap.
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
	 * Schedule `op` after the minimum interval for `key` has elapsed.
	 * The operation runs inside the per-key chain so concurrent enqueues
	 * are fully serialised — the next operation cannot start until the
	 * previous one settles AND the interval elapses.
	 */
	enqueue<T>(key: string, op: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(key) ?? Promise.resolve();
		// Build a chain link: wait interval → run op → record lastSend.
		// The result is extracted via a shared variable because the chain
		// type is Promise<void> (it must not carry the value).
		let result: T;
		const next = prev
			.then(() => this.waitMinInterval(key))
			.then(() => op())
			.then((v) => {
				result = v;
				this.lastSend.set(key, Date.now());
			});
		// Swallow errors so a failed op doesn't break the chain for later callers.
		this.chains.set(
			key,
			next.catch(() => {
				// Still record lastSend on failure so the interval applies.
				this.lastSend.set(key, Date.now());
			}),
		);
		return next.then(() => result);
	}

	private async waitMinInterval(key: string): Promise<void> {
		const now = Date.now();
		const last = this.lastSend.get(key) ?? 0;
		const wait = Math.max(0, this.minIntervalMs - (now - last));
		if (wait > 0) await sleep(wait);
	}
}
