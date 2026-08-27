import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CommandContext,
	findDirectories,
	handleCommand,
} from "./commands.js";
import type { SessionManager } from "./session.js";

function makeCtx(overrides?: Partial<CommandContext>): CommandContext {
	const mockManager = {
		getSessionInfo: () => ({ pid: 123, sessionId: "sid-abc", alive: true }),
		listSessions: () => [
			{ sessionKey: "thread-1", pid: 123, alive: true },
			{ sessionKey: "thread-2", pid: 456, alive: false },
		],
		killSession: () => true,
		clearSession: () => true,
		getEffectiveWorkDir: () => "/mock/work",
		getWorkDirOverride: () => undefined,
		setWorkDirOverride: () => {},
		clearWorkDirOverride: () => {},
		setResumeId: () => {},
	} as unknown as SessionManager;

	return {
		sessionKey: "thread-1",
		manager: mockManager,
		allManagers: new Map([["work", mockManager]]),
		projectName: "work",
		baseWorkDir: "/mock/work",
		...overrides,
	};
}

describe("handleCommand", () => {
	it("returns null for non-command messages", () => {
		expect(handleCommand("hello world", makeCtx())).toBe(null);
		expect(handleCommand("not a command", makeCtx())).toBe(null);
	});

	it("bare unknown /command returns an Unknown-command notice", () => {
		const result = handleCommand("/sessoins", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("Unknown command")).toBeTruthy();
		expect(result?.text.includes("/sessoins")).toBeTruthy();
	});

	it('non-slash text and "/path with spaces" pass through to Claude', () => {
		expect(handleCommand("!unknown", makeCtx())).toBe(null);
		// A slash token followed by more words is a normal prompt, not a command.
		expect(handleCommand("/path/to/file を説明して", makeCtx())).toBe(null);
	});

	it("/help returns command list", () => {
		const result = handleCommand("/help", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("/help")).toBeTruthy();
		expect(result?.text.includes("/status")).toBeTruthy();
	});

	it("!help is not a command (! prefix removed)", () => {
		expect(handleCommand("!help", makeCtx())).toBe(null);
	});

	it("/cc:<command> forwards /<command> to Claude", () => {
		const result = handleCommand("/cc:mycommand", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBe("/mycommand");
	});

	it("/cc:<command> with args forwards the whole command line", () => {
		const result = handleCommand("/cc:review src/index.ts", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBe("/review src/index.ts");
	});

	it("/cc: does not collide with Iris own commands (e.g. /cc:help → Claude)", () => {
		const result = handleCommand("/cc:help", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBe("/help"); // forwarded, not Iris /help
	});

	it("bare /cc: shows usage and does not forward", () => {
		const result = handleCommand("/cc:", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBe(undefined);
		expect(result?.text.includes("/cc:")).toBeTruthy();
	});

	it("leading space + /help works (Slack DM workaround)", () => {
		const result = handleCommand("  /help", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("/help")).toBeTruthy();
	});

	it("/status returns session info", () => {
		const result = handleCommand("/status", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("123")).toBeTruthy();
		expect(result?.text.includes("sid-abc")).toBeTruthy();
	});

	it("/status with no session", () => {
		const ctx = makeCtx({
			manager: {
				getSessionInfo: () => null,
			} as unknown as SessionManager,
		});
		const result = handleCommand("/status", ctx);
		expect(result).toBeTruthy();
		expect(result?.text.includes("No active session")).toBeTruthy();
	});

	it("/sessions lists all sessions", () => {
		const result = handleCommand("/sessions", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("thread-1")).toBeTruthy();
		expect(result?.text.includes("thread-2")).toBeTruthy();
	});

	it("/restart restarts the process (resume)", () => {
		const result = handleCommand("/restart", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.toLowerCase().includes("resume")).toBeTruthy();
	});

	it("/clear resets the conversation", () => {
		const result = handleCommand("/clear", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.toLowerCase().includes("cleared")).toBeTruthy();
	});

	it("/new is an alias for /clear", () => {
		const result = handleCommand("/new", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.toLowerCase().includes("cleared")).toBeTruthy();
	});

	it("commands are case-insensitive", () => {
		expect(handleCommand("/HELP", makeCtx())).toBeTruthy();
		expect(handleCommand("/Status", makeCtx())).toBeTruthy();
	});

	it("/help includes /switch", () => {
		const result = handleCommand("/help", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("/switch")).toBeTruthy();
	});

	it("/help includes /resume", () => {
		const result = handleCommand("/help", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("/resume")).toBeTruthy();
	});
});

describe("/resume command", () => {
	it("no arg with no sessions reports none found", () => {
		const result = handleCommand("/resume", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("No past Claude sessions")).toBeTruthy();
	});

	it("unknown id reports no match", () => {
		const result = handleCommand("/resume nonexistent-id", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("No session matching")).toBeTruthy();
	});
});

describe("/summary command", () => {
	it("no arg forwards the default handover prompt to Claude", () => {
		const result = handleCommand("/summary", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBeTruthy();
		// The default prompt is handover-oriented (mentions 引き継ぎ).
		expect(result?.forwardToClaude?.includes("引き継")).toBeTruthy();
		expect(result?.forwardToClaude?.includes("【次の一手】")).toBeTruthy();
		// And asks for a fenced code block so the result is easy to copy.
		expect(result?.forwardToClaude?.includes("```")).toBeTruthy();
	});

	it("forwards a custom request, with the code-block wrap appended", () => {
		const result = handleCommand(
			"/summary 未解決の問題だけ箇条書きで",
			makeCtx(),
		);
		expect(result).toBeTruthy();
		expect(
			result?.forwardToClaude?.startsWith("未解決の問題だけ箇条書きで"),
		).toBeTruthy();
		expect(result?.forwardToClaude?.includes("```")).toBeTruthy();
	});

	it("is listed in /help", () => {
		const result = handleCommand("/help", makeCtx());
		expect(result?.text?.includes("/summary")).toBeTruthy();
	});
});

describe("/switch command", () => {
	it("no arg shows current workDir (default)", () => {
		const result = handleCommand("/switch", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("/mock/work")).toBeTruthy();
		expect(result?.text.includes("default")).toBeTruthy();
	});

	it("no arg shows (switched) when overridden", () => {
		const result = handleCommand(
			"/switch",
			makeCtx({
				manager: {
					...makeCtx().manager,
					getEffectiveWorkDir: () => "/mock/work/argus",
					getWorkDirOverride: () => "/mock/work/argus",
				} as unknown as SessionManager,
			}),
		);
		expect(result).toBeTruthy();
		expect(result?.text.includes("switched")).toBeTruthy();
	});

	it("/switch - when already at default", () => {
		const result = handleCommand("/switch -", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("Already at default")).toBeTruthy();
	});

	it("/switch - reverts override and clears session (no resume)", () => {
		let overrideCleared = false;
		let sessionCleared = false;
		const result = handleCommand(
			"/switch -",
			makeCtx({
				manager: {
					...makeCtx().manager,
					getWorkDirOverride: () => "/mock/work/argus",
					clearWorkDirOverride: () => {
						overrideCleared = true;
					},
					clearSession: () => {
						sessionCleared = true;
						return true;
					},
				} as unknown as SessionManager,
			}),
		);
		expect(result).toBeTruthy();
		expect(result?.text.includes("default")).toBeTruthy();
		expect(overrideCleared).toBeTruthy();
		expect(sessionCleared).toBeTruthy();
	});

	it("no match returns not found", () => {
		const result = handleCommand("/switch nonexistent-xyz", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("No directory matching")).toBeTruthy();
	});
});

describe("findDirectories", () => {
	let tmpDir: string;

	// Create a temp directory tree for testing
	function setup(): void {
		tmpDir = mkdtempSync(join(tmpdir(), "iris-test-"));
		mkdirSync(join(tmpDir, "mile-code-argus"));
		mkdirSync(join(tmpDir, "mile", "mile-service"), { recursive: true });
		mkdirSync(join(tmpDir, "mile", "mile-mobile"));
		mkdirSync(join(tmpDir, "rd", "iris"), { recursive: true });
		mkdirSync(join(tmpDir, "node_modules", "pkg"), { recursive: true });
		mkdirSync(join(tmpDir, ".git"));
	}

	function teardown(): void {
		rmSync(tmpDir, { recursive: true, force: true });
	}

	it("finds directory by partial name", () => {
		setup();
		try {
			const results = findDirectories(tmpDir, "argus");
			expect(results.length).toBe(1);
			expect(results[0]!.includes("mile-code-argus")).toBeTruthy();
		} finally {
			teardown();
		}
	});

	it("finds nested directory", () => {
		setup();
		try {
			const results = findDirectories(tmpDir, "mile-service");
			expect(results.length).toBe(1);
			expect(results[0]!.includes("mile-service")).toBeTruthy();
		} finally {
			teardown();
		}
	});

	it("prefers exact match over partial", () => {
		setup();
		try {
			// "mile" matches "mile" (exact) and "mile-code-argus", "mile-service", "mile-mobile" (partial)
			const results = findDirectories(tmpDir, "mile");
			// Exact match: the "mile" directory itself
			expect(results.length).toBe(1);
			expect(basename(results[0]!)).toBe("mile");
		} finally {
			teardown();
		}
	});

	it("skips node_modules and .git", () => {
		setup();
		try {
			const nm = findDirectories(tmpDir, "node_modules");
			expect(nm.length).toBe(0);
			const git = findDirectories(tmpDir, ".git");
			expect(git.length).toBe(0);
		} finally {
			teardown();
		}
	});

	it("returns empty for no match", () => {
		setup();
		try {
			const results = findDirectories(tmpDir, "nonexistent");
			expect(results.length).toBe(0);
		} finally {
			teardown();
		}
	});

	it("case-insensitive search", () => {
		setup();
		try {
			const results = findDirectories(tmpDir, "ARGUS");
			expect(results.length).toBe(1);
			expect(results[0]!.includes("mile-code-argus")).toBeTruthy();
		} finally {
			teardown();
		}
	});
});
