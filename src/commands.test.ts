import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CommandContext,
	findDirectories,
	handleCommand,
} from "./commands.js";
import type { AgentKind } from "./config.js";
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
		setWorkDirOverride: async () => {},
		clearWorkDirOverride: async () => {},
		setResumeId: async () => {},
		getModelOverride: () => undefined,
		clearModelOverride: () => {},
		setSessionModel: () => {},
		listModelsFor: async () => undefined,
		currentModelFor: () => undefined,
	} as unknown as SessionManager;

	return {
		sessionKey: "thread-1",
		manager: mockManager,
		allManagers: new Map([["work", mockManager]]),
		projectName: "work",
		baseWorkDir: "/mock/work",
		agentKind: "claude",
		...overrides,
	};
}

describe("handleCommand", async () => {
	it("returns null for non-command messages", async () => {
		expect(await handleCommand("hello world", makeCtx())).toBe(null);
		expect(await handleCommand("not a command", makeCtx())).toBe(null);
	});

	it("bare unknown /command returns an Unknown-command notice", async () => {
		const result = await handleCommand("/sessoins", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("Unknown command")).toBeTruthy();
		expect(result?.text.includes("/sessoins")).toBeTruthy();
	});

	it('non-slash text and "/path with spaces" pass through to Claude', async () => {
		expect(await handleCommand("!unknown", makeCtx())).toBe(null);
		// A slash token followed by more words is a normal prompt, not a command.
		expect(await handleCommand("/path/to/file を説明して", makeCtx())).toBe(
			null,
		);
	});

	it("/help returns command list", async () => {
		const result = await handleCommand("/help", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("/help")).toBeTruthy();
		expect(result?.text.includes("/status")).toBeTruthy();
	});

	it("!help is not a command (! prefix removed)", async () => {
		expect(await handleCommand("!help", makeCtx())).toBe(null);
	});

	it("/cc:<command> forwards /<command> to Claude", async () => {
		const result = await handleCommand("/cc:mycommand", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBe("/mycommand");
	});

	it("/cc:<command> with args forwards the whole command line", async () => {
		const result = await handleCommand("/cc:review src/index.ts", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBe("/review src/index.ts");
	});

	it("/cc: does not collide with Iris own commands (e.g. /cc:help → Claude)", async () => {
		const result = await handleCommand("/cc:help", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBe("/help"); // forwarded, not Iris /help
	});

	it("bare /cc: shows usage and does not forward", async () => {
		const result = await handleCommand("/cc:", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBe(undefined);
		expect(result?.text.includes("/cc:")).toBeTruthy();
	});

	it("/cc:<command> forwards the stripped remainder as a prompt on the pi backend", async () => {
		const result = await handleCommand(
			"/cc:mycommand",
			makeCtx({ agentKind: "pi" }),
		);
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBe("mycommand");
		expect(result?.text).toBe("");
	});

	it("/cc:<command> forwards the stripped remainder as a prompt on the hermes backend", async () => {
		const result = await handleCommand(
			"/cc:mycommand",
			makeCtx({ agentKind: "hermes" }),
		);
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBe("mycommand");
		expect(result?.text).toBe("");
	});

	it("/cc:<command> still forwards on the claude backend", async () => {
		const result = await handleCommand(
			"/cc:mycommand",
			makeCtx({ agentKind: "claude" }),
		);
		expect(result?.forwardToClaude).toBe("/mycommand");
	});

	it("leading space + /help works (Slack DM workaround)", async () => {
		const result = await handleCommand("  /help", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("/help")).toBeTruthy();
	});

	it("/status returns session info", async () => {
		const result = await handleCommand("/status", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("123")).toBeTruthy();
		expect(result?.text.includes("sid-abc")).toBeTruthy();
	});

	it("/status with no session", async () => {
		const ctx = makeCtx({
			manager: {
				getSessionInfo: () => null,
			} as unknown as SessionManager,
		});
		const result = await handleCommand("/status", ctx);
		expect(result).toBeTruthy();
		expect(result?.text.includes("No active session")).toBeTruthy();
	});

	it("/sessions lists all sessions", async () => {
		const result = await handleCommand("/sessions", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("thread-1")).toBeTruthy();
		expect(result?.text.includes("thread-2")).toBeTruthy();
	});

	it("/restart restarts the process (resume)", async () => {
		const result = await handleCommand("/restart", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.toLowerCase().includes("resume")).toBeTruthy();
	});

	it("/clear resets the conversation", async () => {
		const result = await handleCommand("/clear", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.toLowerCase().includes("cleared")).toBeTruthy();
	});

	it("/new is an alias for /clear", async () => {
		const result = await handleCommand("/new", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.toLowerCase().includes("cleared")).toBeTruthy();
	});

	it("commands are case-insensitive", async () => {
		expect(await handleCommand("/HELP", makeCtx())).toBeTruthy();
		expect(await handleCommand("/Status", makeCtx())).toBeTruthy();
	});

	it("/help includes /switch", async () => {
		const result = await handleCommand("/help", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("/switch")).toBeTruthy();
	});

	it("/help includes /resume", async () => {
		const result = await handleCommand("/help", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("/resume")).toBeTruthy();
	});
});

describe("/resume command", async () => {
	it("no arg with no sessions reports none found", async () => {
		const result = await handleCommand("/resume", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("No past Claude sessions")).toBeTruthy();
	});

	it("unknown id reports no match", async () => {
		const result = await handleCommand("/resume nonexistent-id", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("No session matching")).toBeTruthy();
	});

	it("no arg on the pi backend is unsupported (points at /sessions + /resume <id>)", async () => {
		const result = await handleCommand("/resume", makeCtx({ agentKind: "pi" }));
		expect(result).toBeTruthy();
		expect(result?.text).toContain("pi");
		expect(result?.text).toContain("/sessions");
		expect(result?.text).toContain("/resume <id>");
	});

	it("no arg on the hermes backend is unsupported", async () => {
		const result = await handleCommand(
			"/resume",
			makeCtx({ agentKind: "hermes" }),
		);
		expect(result).toBeTruthy();
		expect(result?.text).toContain("hermes");
	});

	it("/resume <id> reattaches by id on the pi backend without a claude store lookup", async () => {
		let captured: string | undefined;
		const manager = makeCtx().manager;
		(
			manager as unknown as { setResumeId: (k: string, id: string) => void }
		).setResumeId = (k: string, id: string) => {
			captured = id;
		};
		const result = await handleCommand(
			"/resume sess-pi-42",
			makeCtx({ agentKind: "pi", manager }),
		);
		expect(result).toBeTruthy();
		expect(result?.text).toContain("sess-pi-42");
		expect(captured).toBe("sess-pi-42");
	});

	it("/resume <id> reattaches by id on the hermes backend", async () => {
		let captured: string | undefined;
		const manager = makeCtx().manager;
		(
			manager as unknown as { setResumeId: (k: string, id: string) => void }
		).setResumeId = (k: string, id: string) => {
			captured = id;
		};
		const result = await handleCommand(
			"/resume sess-h-7",
			makeCtx({ agentKind: "hermes", manager }),
		);
		expect(result).toBeTruthy();
		expect(captured).toBe("sess-h-7");
	});
});

describe("/summary command", async () => {
	it("no arg forwards the default handover prompt to Claude", async () => {
		const result = await handleCommand("/summary", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.forwardToClaude).toBeTruthy();
		// The default prompt is handover-oriented (mentions 引き継ぎ).
		expect(result?.forwardToClaude?.includes("引き継")).toBeTruthy();
		expect(result?.forwardToClaude?.includes("【次の一手】")).toBeTruthy();
		// And asks for a fenced code block so the result is easy to copy.
		expect(result?.forwardToClaude?.includes("```")).toBeTruthy();
	});

	it("forwards a custom request, with the code-block wrap appended", async () => {
		const result = await handleCommand(
			"/summary 未解決の問題だけ箇条書きで",
			makeCtx(),
		);
		expect(result).toBeTruthy();
		expect(
			result?.forwardToClaude?.startsWith("未解決の問題だけ箇条書きで"),
		).toBeTruthy();
		expect(result?.forwardToClaude?.includes("```")).toBeTruthy();
	});

	it("is listed in /help", async () => {
		const result = await handleCommand("/help", makeCtx());
		expect(result?.text?.includes("/summary")).toBeTruthy();
	});
});

describe("/switch command", async () => {
	it("no arg shows current workDir (default)", async () => {
		const result = await handleCommand("/switch", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("/mock/work")).toBeTruthy();
		expect(result?.text.includes("default")).toBeTruthy();
	});

	it("no arg shows (switched) when overridden", async () => {
		const result = await handleCommand(
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

	it("/switch - when already at default", async () => {
		const result = await handleCommand("/switch -", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("Already at default")).toBeTruthy();
	});

	it("/switch - reverts override and clears session (no resume)", async () => {
		let overrideCleared = false;
		let sessionCleared = false;
		const result = await handleCommand(
			"/switch -",
			makeCtx({
				manager: {
					...makeCtx().manager,
					getWorkDirOverride: () => "/mock/work/argus",
					clearWorkDirOverride: async () => {
						overrideCleared = true;
					},
					clearSession: async () => {
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

	it("no match returns not found", async () => {
		const result = await handleCommand("/switch nonexistent-xyz", makeCtx());
		expect(result).toBeTruthy();
		expect(result?.text.includes("No directory matching")).toBeTruthy();
	});
});

describe("/model command", () => {
	// A context backed by a model-capable (Pi-style) stub manager, with the
	// switch/clear RPCs under observation and a configurable model + live set.
	function modelCtx(
		opts: {
			model?: string;
			agentKind?: AgentKind;
			alive?: boolean;
			models?: Array<{
				provider: string;
				id: string;
				name?: string;
				reasoning?: boolean;
			}>;
			current?: {
				provider: string;
				id: string;
				name?: string;
				reasoning?: boolean;
			};
			override?: { provider: string; modelId: string };
		} = {},
	): {
		ctx: CommandContext;
		spies: { set: boolean; clear: boolean };
		applied: { provider?: string; modelId?: string };
	} {
		const spies = { set: false, clear: false };
		const applied: { provider?: string; modelId?: string } = {};
		const manager = {
			getSessionInfo: () => ({
				pid: 1,
				sessionId: "s",
				alive: opts.alive ?? false,
			}),
			getModelOverride: () => opts.override,
			clearModelOverride: () => {
				spies.clear = true;
			},
			setSessionModel: (_k: string, p: string, m: string) => {
				spies.set = true;
				applied.provider = p;
				applied.modelId = m;
			},
			listModelsFor: async () => opts.models,
			currentModelFor: () => opts.current,
		} as unknown as SessionManager;
		return {
			ctx: {
				sessionKey: "t1",
				manager,
				allManagers: new Map(),
				projectName: "p",
				baseWorkDir: "/w",
				agentKind: opts.agentKind ?? "pi",
				model: opts.model,
			} as CommandContext,
			spies,
			applied,
		};
	}

	it("/model - reverts to the project default when an override is set", async () => {
		const { ctx, spies, applied } = modelCtx({
			model: "an/def",
			override: { provider: "prov", modelId: "m1" },
		});
		const r = await handleCommand("/model -", ctx);
		expect(r?.text).toContain("Reverted");
		expect(spies.clear).toBe(true);
		expect(spies.set).toBe(false);
		expect(applied.provider).toBeUndefined();
	});

	it("/model - with no override reports the default in effect", async () => {
		const { ctx, spies } = modelCtx({ model: "an/def" });
		const r = await handleCommand("/model -", ctx);
		expect(r?.text).toContain("in effect");
		expect(r?.text).toContain("an/def");
		expect(spies.clear).toBe(false);
	});

	it("switches a live Pi session and reports a live switch", async () => {
		const { ctx, spies, applied } = modelCtx({
			agentKind: "pi",
			alive: true,
			models: [
				{ provider: "anthropic", id: "sonnet" },
				{ provider: "deepseek-official", id: "deepseek-v4-flash" },
			],
		});
		const r = await handleCommand(
			"/model deepseek-official/deepseek-v4-flash",
			ctx,
		);
		expect(r?.text).toContain("Switched");
		expect(r?.text).toContain("deepseek-official/deepseek-v4-flash");
		expect(spies.set).toBe(true);
		expect(applied.provider).toBe("deepseek-official");
		expect(applied.modelId).toBe("deepseek-v4-flash");
	});

	it("rejects a model not in the live list, listing what is available", async () => {
		const { ctx, spies } = modelCtx({
			alive: true,
			models: [{ provider: "anthropic", id: "sonnet" }],
		});
		const r = await handleCommand("/model anthropic/bogus", ctx);
		expect(r?.text).toContain("not available");
		expect(r?.text).toContain("anthropic/sonnet");
		expect(spies.set).toBe(false);
	});

	it("rejects a bare model id (requires provider/id shape)", async () => {
		const { ctx, spies } = modelCtx({ alive: false });
		const r = await handleCommand("/model deepseek-v4-flash", ctx);
		expect(r?.text).toContain("provider/id");
		expect(spies.set).toBe(false);
	});

	it("lists available models with a current ✓ on a live session", async () => {
		const { ctx } = modelCtx({
			alive: true,
			models: [
				{ provider: "anthropic", id: "sonnet", name: "Sonnet" },
				{ provider: "openai", id: "gpt", reasoning: true },
			],
			current: { provider: "anthropic", id: "sonnet" },
		});
		const r = await handleCommand("/model", ctx);
		expect(r?.text).toContain("anthropic/sonnet");
		expect(r?.text).toContain("openai/gpt");
		expect(r?.text).toContain("✓");
		// current model gets the ✓ marker
		expect(r?.text).toContain("anthropic/sonnet");
	});

	it("no arg on an unstarted session shows the default + usage (no spawn)", async () => {
		const { ctx } = modelCtx({ alive: false, model: "an/def" });
		const r = await handleCommand("/model", ctx);
		expect(r?.text).toContain("an/def");
		expect(r?.text.toLowerCase()).toContain("next message");
	});
});

describe("findDirectories", async () => {
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

	it("finds directory by partial name", async () => {
		setup();
		try {
			const results = findDirectories(tmpDir, "argus");
			expect(results.length).toBe(1);
			expect(results[0]!.includes("mile-code-argus")).toBeTruthy();
		} finally {
			teardown();
		}
	});

	it("finds nested directory", async () => {
		setup();
		try {
			const results = findDirectories(tmpDir, "mile-service");
			expect(results.length).toBe(1);
			expect(results[0]!.includes("mile-service")).toBeTruthy();
		} finally {
			teardown();
		}
	});

	it("prefers exact match over partial", async () => {
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

	it("skips node_modules and .git", async () => {
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

	it("returns empty for no match", async () => {
		setup();
		try {
			const results = findDirectories(tmpDir, "nonexistent");
			expect(results.length).toBe(0);
		} finally {
			teardown();
		}
	});

	it("case-insensitive search", async () => {
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
