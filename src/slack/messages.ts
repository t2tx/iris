/**
 * messages.ts — inbound Slack message types and the pure filter that decides
 * which raw `message` events Iris should act on.
 *
 * Kept free of Bolt/IO so acceptMessage() can be unit-tested by injecting the
 * SeenSet and the current time.
 */

import {SeenSet} from '../dedup.js';
import {log} from '../log.js';

export interface SlackFile {
  name?: string;
  mimetype?: string;
  url_private?: string;
}

export interface InboundMessage {
  channel: string;
  channel_type?: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  bot_id?: string;
  user?: string;
  client_msg_id?: string;
  files?: SlackFile[];
}

/**
 * Filter raw Slack messages down to ones we should act on, dropping bot
 * messages, unsupported subtypes, empty messages, and at-least-once duplicates.
 * Returns the accepted message + its prompt, or null to ignore.
 *
 * `seen` and `now` are injected so this is a pure, unit-testable function.
 */
/**
 * True if this is the kind of message Iris acts on at all, before dedup.
 * Drops edits/joins (unsupported subtypes), bot messages (incl. our own), and
 * top-level channel posts — those have no thread_ts and are handled by the
 * app_mention handler instead. Returning here is what keeps acceptMessage from
 * consuming the shared seen-id for an event it isn't going to process: Slack
 * delivers the same client_msg_id for both the `message` and the `app_mention`,
 * so marking it seen would make the app_mention reject itself as a duplicate.
 */
function isActionableMessage(m: InboundMessage, subtype?: string): boolean {
  if (subtype !== undefined && subtype !== 'file_share') return false;
  if (m.bot_id) return false; // bots, including ourselves
  if (m.channel_type !== 'im' && !m.thread_ts) return false; // top-level channel
  return true;
}

export function acceptMessage(
  message: unknown,
  seen: SeenSet,
  now: number,
): {m: InboundMessage; prompt: string} | null {
  const subtype = (message as {subtype?: string}).subtype;
  const m = message as InboundMessage;
  if (!isActionableMessage(m, subtype)) return null;
  // Drop Slack retries / reconnect re-deliveries of the same message.
  const msgId = m.client_msg_id || `msg:${m.channel}:${m.ts}`;
  if (!seen.check(msgId, now)) {
    log.debug(`duplicate message ignored (${msgId})`);
    return null;
  }
  const prompt = (m.text || '').trim();
  // Allow a file-only message (no text) through; otherwise require text.
  if (!prompt && !m.files?.length) return null;
  return {m, prompt};
}
