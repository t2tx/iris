/**
 * thread-history.ts — read a Slack thread's human turns, for carrying
 * conversation context across a /switch.
 *
 * Claude Code persists a session under the cwd it was started in, and a
 * session cannot be resumed from a different directory (verified: `--resume`
 * from another cwd reports "No conversation found", and `--session-id` +
 * `--fork-session` does not help because the lookup runs before the fork).
 * Iris itself keeps no transcript — SessionManager stores a session *id*, not
 * its content — so when /switch respawns in the new directory the conversation
 * is gone.
 *
 * Slack, however, already holds the thread. Reading it back is the one source
 * of context that survives a respawn, needs no new storage, and works the same
 * for every backend (the carry-over rides on --append-system-prompt, which all
 * four backends pass through at spawn).
 *
 * Only human turns are carried. In a real 683-reply thread, 649 of the
 * messages were the bot's own (progress lines, notices, replies) and just 38
 * were human — 2141 characters in total. Dropping the bot's side is what keeps
 * the carry-over small; it also avoids feeding Iris's own status chatter back
 * into the agent.
 *
 * Kept free of Bolt so fetchThreadHistory() can be unit-tested with a stub
 * reader, following the pure-core convention of messages.ts.
 */

import { log } from "../log.js";

/** Most recent human turns to carry over. */
export const DEFAULT_MAX_TURNS = 100;

/**
 * Pages to read before giving up. A thread is walked oldest→newest, so a very
 * long one is truncated at the OLD end, which is what we want — the newest
 * turns are the relevant ones. The cap bounds how long /switch can block on
 * Slack: the measured 683-reply thread needed 4 pages.
 */
const MAX_PAGES = 8;

/** Messages per page. Slack's documented default for this method is 1000, but
 * apps created after 2025-05-29 that are commercially distributed and not
 * Marketplace-approved are capped at 15; asking for 200 is served in full for
 * internal apps (measured) and degrades gracefully for capped ones. */
const PAGE_SIZE = 200;

/** The subset of a Slack message this module needs. */
export interface ThreadMessage {
	text?: string;
	bot_id?: string;
	subtype?: string;
	user?: string;
}

/** One page of `conversations.replies`, as returned by the Slack Web API. */
export interface RepliesPage {
	messages?: ThreadMessage[];
	response_metadata?: { next_cursor?: string };
}

/**
 * Reads one page of a thread. Injected so the fetch logic is testable without
 * Bolt; in production this is `app.client.conversations.replies`.
 */
export type RepliesReader = (args: {
	channel: string;
	ts: string;
	limit: number;
	cursor?: string;
}) => Promise<RepliesPage>;

/** True for a message that represents something a human typed. */
function isHumanTurn(m: ThreadMessage): boolean {
	// bot_id covers Iris's own posts and any other app in the thread. This is
	// the same test acceptMessage() uses to decide what to act on.
	if (m.bot_id) return false;
	// Joins/edits/etc. A file_share carries a real human text, so keep it.
	if (m.subtype !== undefined && m.subtype !== "file_share") return false;
	return typeof m.text === "string" && m.text.trim() !== "";
}

/**
 * Slash commands are instructions to Iris, not conversation. Carrying
 * `/switch mile-service` over would make the agent think the user asked it to
 * switch again.
 */
function isCommand(text: string): boolean {
	return text.startsWith("/");
}

/** Strip Slack mention markup (`<@U123>`) and collapse whitespace. */
function clean(text: string): string {
	return text
		.replace(/<@[A-Z0-9]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Fetch the human turns of a thread, oldest→newest, capped at `maxTurns`
 * (the most recent ones are kept).
 *
 * Never throws: a missing scope, a revoked token or a transport error yields
 * an empty list, so a caller degrades to "no carry-over" instead of failing
 * the /switch. The reason is logged.
 */
export async function fetchThreadHistory(
	read: RepliesReader,
	channel: string,
	threadTs: string,
	maxTurns: number = DEFAULT_MAX_TURNS,
): Promise<string[]> {
	const turns: string[] = [];
	let cursor: string | undefined;

	for (let page = 0; page < MAX_PAGES; page++) {
		let res: RepliesPage;
		try {
			res = await read({
				channel,
				ts: threadTs,
				limit: PAGE_SIZE,
				...(cursor ? { cursor } : {}),
			});
		} catch (err) {
			// missing_scope (private channel without groups:history, DM without
			// im:history), invalid_auth, rate limiting, network failure.
			log.warn(`thread history unavailable: ${(err as Error).message}`);
			break;
		}
		for (const m of res.messages ?? []) {
			if (!isHumanTurn(m)) continue;
			const text = clean(m.text as string);
			if (!text || isCommand(text)) continue;
			turns.push(text);
		}
		cursor = res.response_metadata?.next_cursor;
		if (!cursor) break;
	}

	// Keep the newest maxTurns (the tail), since the thread is oldest-first.
	return turns.length > maxTurns ? turns.slice(-maxTurns) : turns;
}

/**
 * Render carried-over turns as a system-prompt section.
 *
 * Framed as a record of what the user asked before, NOT as the live
 * conversation: only the human side survives, so the agent must not assume it
 * already answered any of it. Returns "" for no turns, so the caller can
 * append unconditionally.
 */
export function renderCarryOver(turns: string[], previousDir: string): string {
	if (turns.length === 0) return "";
	const lines = turns.map((t) => `- ${t}`).join("\n");
	return [
		"Context carried over from this Slack thread, which was previously",
		`working in ${previousDir}. These are the user's own messages only —`,
		"your earlier replies and any tool results are NOT included, so do not",
		"assume work described here was completed. Use it to understand what the",
		"user is working on; if you need a detail that is missing, ask.",
		"",
		lines,
	].join("\n");
}
