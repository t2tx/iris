/**
 * stream-buffer.ts — accumulates text chunks from Claude and periodically
 * pushes them to Slack via chat.postMessage (first chunk) or chat.update
 * (subsequent chunks). This gives a "streaming" feel without flooding the
 * Slack API with one message per token.
 *
 * Lifecycle: one StreamBuffer per "turn" (user message → result).
 * When a non-text event (tool_use / permission) arrives, the caller should
 * flush() before posting that event as a separate message.
 */

const UPDATE_INTERVAL_MS = 500;
const TYPING_INDICATOR = " ✍️";

export interface SlackPoster {
	post(text: string): Promise<string>; // returns message ts
	update(ts: string, text: string): Promise<void>;
}

export class StreamBuffer {
	private readonly poster: SlackPoster;
	private readonly format: (raw: string) => string;
	private buf = "";
	private messageTs: string | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private flushing = false;
	// A terminal flush() (typing indicator off, full text) requested while a
	// streaming push is in flight is remembered here so it is re-run once the
	// in-flight push drains. Without this the `if (this.flushing) return` guard
	// below silently dropped the final update, leaving the bubble at a stale
	// partial frame with the typing indicator stuck.
	private pendingFinal = false;

	constructor(poster: SlackPoster, format: (raw: string) => string) {
		this.poster = poster;
		this.format = format;
	}

	/** Append a text chunk. Schedules an update if not already pending. */
	append(text: string): void {
		this.buf += text;
		this.scheduleUpdate();
	}

	/**
	 * Flush all buffered text to Slack immediately. Call before tool_use /
	 * permission / result. Non-blocking when a streaming push is already in
	 * flight: the terminal update is re-queued (see pendingFinal) and lands as
	 * soon as the in-flight push drains.
	 */
	async flush(): Promise<void> {
		this.clearTimer();
		if (!this.buf) return;
		void this.pushToSlack(false);
	}

	/** Get the full accumulated text (before formatting). */
	getFullText(): string {
		return this.buf;
	}

	/** Get the current message ts (null if nothing posted yet). */
	getMessageTs(): string | null {
		return this.messageTs;
	}

	private scheduleUpdate(): void {
		if (this.timer !== null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.pushToSlack(true);
		}, UPDATE_INTERVAL_MS);
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private async pushToSlack(showTyping: boolean): Promise<void> {
		// A push is already in flight. For a terminal flush (typing off) remember
		// it so the post-update re-run lands the full text without the typing
		// indicator; a streaming tick is a no-op (another tick is already pending).
		if (this.flushing) {
			if (!showTyping) this.pendingFinal = true;
			return;
		}
		this.flushing = true;
		try {
			const text = this.format(this.buf);
			const display = showTyping ? text + TYPING_INDICATOR : text;

			if (this.messageTs === null) {
				this.messageTs = await this.poster.post(display);
			} else {
				await this.poster.update(this.messageTs, display);
			}
		} catch (err) {
			// Swallow-and-log: fire-and-forget callers (onText via append, the
			// scheduleUpdate timer's `void pushToSlack`) would otherwise surface a
			// failed post as an unhandled promise rejection. A failed post leaves
			// the turn's bubble absent but must not flood the event loop.
			console.error(
				`[stream-buffer] push failed: ${String((err as Error)?.message ?? err)}`,
			);
		} finally {
			this.flushing = false;
			// A terminal flush was requested mid-flight; run it now so the final
			// full-text update (typing indicator off) actually lands.
			if (this.pendingFinal) {
				this.pendingFinal = false;
				void this.pushToSlack(false);
			}
		}
	}
}
