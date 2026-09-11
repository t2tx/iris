import { describe, expect, it } from "vitest";
import {
	fetchThreadHistory,
	type RepliesPage,
	type RepliesReader,
	renderCarryOver,
} from "./thread-history.js";

/** A reader that serves fixed pages and records the args it was called with. */
function reader(pages: RepliesPage[]): {
	read: RepliesReader;
	calls: { cursor?: string }[];
} {
	const calls: { cursor?: string }[] = [];
	let i = 0;
	const read: RepliesReader = async (args) => {
		calls.push({ cursor: args.cursor });
		return pages[i++] ?? {};
	};
	return { read, calls };
}

const human = (text: string) => ({ text, user: "U1" });
const bot = (text: string) => ({ text, bot_id: "B1" });

describe("fetchThreadHistory", () => {
	it("keeps human turns and drops bot messages", async () => {
		const { read } = reader([
			{ messages: [human("調べて"), bot("🔧 Read"), human("なぜ？")] },
		]);
		expect(await fetchThreadHistory(read, "C1", "1.1")).toEqual([
			"調べて",
			"なぜ？",
		]);
	});

	it("drops slash commands so the agent does not re-run them", async () => {
		const { read } = reader([
			{ messages: [human("/switch argus"), human("続けて")] },
		]);
		expect(await fetchThreadHistory(read, "C1", "1.1")).toEqual(["続けて"]);
	});

	it("drops unsupported subtypes but keeps file_share", async () => {
		const { read } = reader([
			{
				messages: [
					{ text: "joined", user: "U1", subtype: "channel_join" },
					{ text: "見て", user: "U1", subtype: "file_share" },
				],
			},
		]);
		expect(await fetchThreadHistory(read, "C1", "1.1")).toEqual(["見て"]);
	});

	it("strips mentions and collapses whitespace", async () => {
		const { read } = reader([
			{ messages: [human("<@U0BAEK5CZ18>  調べて\n\nお願い")] },
		]);
		expect(await fetchThreadHistory(read, "C1", "1.1")).toEqual([
			"調べて お願い",
		]);
	});

	it("skips empty and whitespace-only messages", async () => {
		const { read } = reader([
			{ messages: [human(""), human("   "), { user: "U1" }, human("ok")] },
		]);
		expect(await fetchThreadHistory(read, "C1", "1.1")).toEqual(["ok"]);
	});

	it("follows next_cursor across pages", async () => {
		const { read, calls } = reader([
			{ messages: [human("a")], response_metadata: { next_cursor: "c1" } },
			{ messages: [human("b")] },
		]);
		expect(await fetchThreadHistory(read, "C1", "1.1")).toEqual(["a", "b"]);
		expect(calls.map((c) => c.cursor)).toEqual([undefined, "c1"]);
	});

	it("keeps the newest turns when over the cap", async () => {
		const { read } = reader([
			{ messages: [human("1"), human("2"), human("3"), human("4")] },
		]);
		expect(await fetchThreadHistory(read, "C1", "1.1", 2)).toEqual(["3", "4"]);
	});

	// A missing scope (private channel without groups:history) must degrade to
	// "no carry-over", never fail the /switch that triggered it.
	it("returns [] when the reader throws", async () => {
		const read: RepliesReader = async () => {
			throw new Error("missing_scope");
		};
		expect(await fetchThreadHistory(read, "C1", "1.1")).toEqual([]);
	});

	it("keeps turns collected before a mid-pagination failure", async () => {
		let n = 0;
		const read: RepliesReader = async () => {
			if (n++ === 0)
				return {
					messages: [human("a")],
					response_metadata: { next_cursor: "c" },
				};
			throw new Error("ratelimited");
		};
		expect(await fetchThreadHistory(read, "C1", "1.1")).toEqual(["a"]);
	});

	it("stops paging instead of looping forever", async () => {
		let calls = 0;
		const read: RepliesReader = async () => {
			calls++;
			return {
				messages: [human("x")],
				response_metadata: { next_cursor: "c" },
			};
		};
		await fetchThreadHistory(read, "C1", "1.1");
		expect(calls).toBeLessThanOrEqual(8);
	});
});

describe("renderCarryOver", () => {
	it("returns '' for no turns so callers can append unconditionally", () => {
		expect(renderCarryOver([], "/old")).toBe("");
	});

	it("lists the turns and names the previous dir", () => {
		const out = renderCarryOver(["調べて", "なぜ？"], "/work/iris");
		expect(out).toContain("/work/iris");
		expect(out).toContain("- 調べて");
		expect(out).toContain("- なぜ？");
	});

	it("warns that replies and tool results are absent", () => {
		const out = renderCarryOver(["x"], "/old");
		expect(out).toContain("NOT included");
	});
});
