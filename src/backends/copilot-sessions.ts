/**
 * copilot-sessions.ts — parse Copilot's ACP `session/list` response into a
 * display-friendly session list.
 *
 * Copilot's `--acp` mode answers a `session/list{cwd}` request with
 *  { result: { sessions: [{ sessionId, cwd, title, updatedAt }] } }.
 *  This module is the PURE parser for that shape (unit-testable, no I/O); the
 *  process that actually runs `copilot --acp` to produce the response lives in
 *  the integration / smoke layer (issue #100). Mirrors claude-sessions.ts'
 *  "pure, display-oriented" shape.
 */

/** One persisted Copilot session, projected to the fields /resume displays. */
export interface CopilotSession {
	id: string; // sessionId
	cwd: string; // the project working dir the session was created in
	title: string; // first prompt head, for display
	updatedAt: string; // ISO timestamp, for sorting / display
}

/**
 * Parse a `session/list` response result of shape
 *  { sessions: [{ sessionId, cwd, title, updatedAt }] }  into CopilotSession[].
 *
 * Robust to malformed entries: entries that are not objects, or are missing a
 * usable `sessionId`, are dropped rather than throwing. `undefined` / `null` /
 * non-result shapes yield an empty array.
 */
export function parseCopilotSessionList(result: unknown): CopilotSession[] {
	if (typeof result !== "object" || result === null) return [];
	const sessions = (result as Record<string, unknown>)["sessions"];
	if (!Array.isArray(sessions)) return [];

	const out: CopilotSession[] = [];
	for (const s of sessions) {
		if (typeof s !== "object" || s === null) continue;
		const rec = s as Record<string, unknown>;
		const id = rec["sessionId"];
		if (typeof id !== "string" || !id) continue;
		out.push({
			id,
			cwd: typeof rec["cwd"] === "string" ? rec["cwd"] : "",
			title: typeof rec["title"] === "string" ? rec["title"] : "",
			updatedAt: typeof rec["updatedAt"] === "string" ? rec["updatedAt"] : "",
		});
	}
	return out;
}

/**
 * Render a list of Copilot sessions as a multi-line /resume body (mirroring the
 * Claude /resume listing in commands.ts). Returns an empty string for an empty
 * list so callers can short-circuit with "no sessions found".
 */
export function formatCopilotSessions(sessions: CopilotSession[]): string {
	if (sessions.length === 0) return "";

	// Newest first: sessions come back updatedAt-ascending; reverse for display.
	const ordered = [...sessions].reverse();
	const lines = ordered.map((s) => {
		const when = formatWhen(s.updatedAt);
		const head = s.title ? `\n     📌 ${preview(s.title)}` : "";
		return `• \`${s.id}\` (${when})${head}`;
	});
	return [
		"*Past copilot sessions*:",
		...lines,
		"_Reconnect with_ `/resume `<id>`.`",
	].join("\n");
}

/** Truncate a one-line preview of a prompt for the session list. */
function preview(text: string, max = 60): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Format an ISO timestamp as a locale string, or '(unknown)' if blank/invalid. */
function formatWhen(iso: string): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return "(unknown)";
	return new Date(ms).toLocaleString();
}
