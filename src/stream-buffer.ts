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
const TYPING_INDICATOR = ' ✍️';
// When a reply exceeds this, the streamed message shows only a short preview
// and the full text is delivered separately as a file (see onResult in
// index.ts). Kept small so the preview is a quick summary, not a wall of text —
// this must match REPLY_FILE_THRESHOLD in index.ts so every clipped reply also
// gets its full-text file.
const PREVIEW_MAX = 500;
const PREVIEW_NOTICE = '\n\n_…(全文はこのあと添付します)_';

export interface SlackPoster {
  post(text: string): Promise<string>; // returns message ts
  update(ts: string, text: string): Promise<void>;
}

export class StreamBuffer {
  private readonly poster: SlackPoster;
  private readonly format: (raw: string) => string;
  private buf = '';
  private messageTs: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(poster: SlackPoster, format: (raw: string) => string) {
    this.poster = poster;
    this.format = format;
  }

  /** Append a text chunk. Schedules an update if not already pending. */
  append(text: string): void {
    this.buf += text;
    this.scheduleUpdate();
  }

  /** Flush all buffered text to Slack immediately. Call before tool_use / permission / result. */
  async flush(): Promise<void> {
    this.clearTimer();
    if (!this.buf) return;
    await this.pushToSlack(false);
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
    if (this.flushing) return;
    this.flushing = true;
    try {
      const text = this.format(this.buf);
      // Clip the streamed preview so a long reply can't exceed Slack's block
      // limit. The untrimmed text remains available via getFullText().
      const preview =
        text.length > PREVIEW_MAX
          ? text.slice(0, PREVIEW_MAX) + PREVIEW_NOTICE
          : text;
      const display = showTyping ? preview + TYPING_INDICATOR : preview;

      if (this.messageTs === null) {
        this.messageTs = await this.poster.post(display);
      } else {
        await this.poster.update(this.messageTs, display);
      }
    } finally {
      this.flushing = false;
    }
  }
}
