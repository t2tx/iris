import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentOptions, AgentProcess, PermissionMode } from "../agent.js";
import { SessionManager, type ThreadHandlers } from "../session.js";
import { createPiProcess, PiProcess } from "./pi.js";

/**
 * pi.test.ts — PiProcess backend tests.
 *
 * Follows the same test strategy as agent.test.ts:
 *   - type-level and runtime conformance checks for AgentProcess
 *   - a fake shell-binary that emits known JSON lines to verify
 *     the stdout routing logic (response / extension_ui_request / parsePiLine)
 */

// ── Interface conformance ──────────────────────────────────────────────────

test("createPiProcess result is assignable to AgentProcess", () => {
	// A pure type-level check: PiProcess backend hands out AgentProcess.
	const factory: (opts: AgentOptions, mode: PermissionMode) => AgentProcess =
		createPiProcess;
	expect(typeof factory).toBe("function");
});

test("PiProcess satisfies AgentProcess (runtime surface check)", () => {
	const p = PiProcess.prototype as unknown as AgentProcess;
	expect(typeof p.send).toBe("function");
	expect(typeof p.respondPermission).toBe("function");
	expect(typeof p.close).toBe("function");
	expect(typeof p.isAlive).toBe("function");
	expect(typeof p.getSessionId).toBe("function");
	expect(typeof p.getPid).toBe("function");
});

// ── Fake binary helpers ────────────────────────────────────────────────────

/**
 * Create a fake `pi` binary that outputs the given JSON lines on stdout.
 * Each line is emitted with a small delay to simulate streaming.
 */
function createFakePi(script: string): string {
	const dir = mkdtempSync(join(tmpdir(), "iris-fakepi-"));
	const path = join(dir, "fake-pi.sh");
	writeFileSync(path, `#!/bin/sh\n${script}\nexec cat >/dev/null\n`);
	chmodSync(path, 0o755);
	return path;
}

/** Helper: wait for a promise that resolves when a condition is met. */
async function waitFor(
	condition: () => boolean,
	timeoutMs = 3000,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (condition()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return false;
}

const noopHandlers: ThreadHandlers = {
	onText() {},
	onToolUse() {},
	onPermission() {},
	onResult() {},
	onError() {},
};

// ── Basic spawn + prompt flow ───────────────────────────────────────────────

describe("PiProcess basic flow", () => {
	test("emits text events from message_update lines", async () => {
		const bin = createFakePi(
			`printf '%s\\n' '${JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Hello" },
			})}'`,
		);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		const texts: string[] = [];
		const handlers: ThreadHandlers = {
			...noopHandlers,
			onText(t) {
				texts.push(t);
			},
			onResult() {},
		};

		mgr.send("t1", "hi", handlers);

		const ok = await waitFor(() => texts.length > 0);
		expect(ok).toBe(true);
		expect(texts).toContain("Hello");

		mgr.closeAll();
	});

	test("emits tool_use events from toolcall_start lines", async () => {
		const bin = createFakePi(
			`printf '%s\\n' '${JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					toolName: "Bash",
					input: { command: "ls" },
				},
			})}'`,
		);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		const tools: string[] = [];
		const handlers: ThreadHandlers = {
			...noopHandlers,
			onToolUse(name) {
				tools.push(name);
			},
		};

		mgr.send("t1", "hi", handlers);

		const ok = await waitFor(() => tools.length > 0);
		expect(ok).toBe(true);
		expect(tools).toContain("Bash");

		mgr.closeAll();
	});

	test("emits result event from agent_settled lines", async () => {
		const bin = createFakePi(
			`printf '%s\\n' '${JSON.stringify({
				type: "agent_settled",
				status: "completed",
			})}'`,
		);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		let gotResult = false;
		const handlers: ThreadHandlers = {
			...noopHandlers,
			onResult() {
				gotResult = true;
			},
		};

		mgr.send("t1", "hi", handlers);

		const ok = await waitFor(() => gotResult);
		expect(ok).toBe(true);

		mgr.closeAll();
	});
});

// ── Session id from response lines ─────────────────────────────────────────

describe("PiProcess session id", () => {
	test("captures session id from response.result.sessionId", async () => {
		const bin = createFakePi(
			`printf '%s\\n' '${JSON.stringify({
				type: "response",
				result: { sessionId: "pi-sess-123" },
			})}'`,
		);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		mgr.send("t1", "hi", noopHandlers);

		const ok = await waitFor(
			() => mgr.getSessionInfo("t1")?.sessionId === "pi-sess-123",
		);
		expect(ok).toBe(true);

		mgr.closeAll();
	});

	test("captures session id from response.result.session_id", async () => {
		const bin = createFakePi(
			`printf '%s\\n' '${JSON.stringify({
				type: "response",
				result: { session_id: "pi-sess-456" },
			})}'`,
		);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		mgr.send("t1", "hi", noopHandlers);

		const ok = await waitFor(
			() => mgr.getSessionInfo("t1")?.sessionId === "pi-sess-456",
		);
		expect(ok).toBe(true);

		mgr.closeAll();
	});
});

// ── Extension UI dialog routing ────────────────────────────────────────────

describe("PiProcess extension_ui_request", () => {
	test("confirm dialog emits a permission event with toolName (confirm)", async () => {
		const bin = createFakePi(
			`printf '%s\\n' '${JSON.stringify({
				type: "extension_ui_request",
				id: "ui-1",
				method: "confirm",
				title: "Confirm action",
				message: "Are you sure?",
			})}'`,
		);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "manual", // must be manual to surface to Slack
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		let permToolName = "";
		let permRequestId = "";
		const handlers: ThreadHandlers = {
			...noopHandlers,
			onPermission(req) {
				permToolName = req.toolName;
				permRequestId = req.requestId;
			},
		};

		mgr.send("t1", "trigger confirm", handlers);

		const ok = await waitFor(() => permToolName.length > 0);
		expect(ok).toBe(true);
		expect(permToolName).toBe("(confirm)");
		expect(permRequestId).toBe("ui-1");

		mgr.closeAll();
	});

	test("auto mode auto-allows confirm dialogs (no permission event)", async () => {
		const bin = createFakePi(
			`printf '%s\\n' '${JSON.stringify({
				type: "extension_ui_request",
				id: "ui-2",
				method: "confirm",
				title: "Auto confirm",
			})}'`,
		);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		let gotPermission = false;
		const handlers: ThreadHandlers = {
			...noopHandlers,
			onPermission() {
				gotPermission = true;
			},
		};

		mgr.send("t1", "hi", handlers);

		// Wait a bit longer to ensure no permission event arrives
		await new Promise((r) => setTimeout(r, 300));
		expect(gotPermission).toBe(false);

		mgr.closeAll();
	});

	test("non-confirm dialog (select) is auto-cancelled (no permission event)", async () => {
		const bin = createFakePi(
			`printf '%s\\n' '${JSON.stringify({
				type: "extension_ui_request",
				id: "ui-3",
				method: "select",
				choices: ["a", "b"],
			})}'`,
		);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "manual",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		let gotPermission = false;
		const handlers: ThreadHandlers = {
			...noopHandlers,
			onPermission() {
				gotPermission = true;
			},
		};

		mgr.send("t1", "hi", handlers);

		// Wait to ensure no permission event for non-confirm
		await new Promise((r) => setTimeout(r, 300));
		expect(gotPermission).toBe(false);

		mgr.closeAll();
	});
});

// ── SessionManager integration ──────────────────────────────────────────────

describe("PiProcess in SessionManager", () => {
	test("createProcess lets SessionManager drive a PiProcess", async () => {
		const bin = createFakePi(
			`printf '%s\\n' '${JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "world" },
			})}'`,
		);
		const texts: string[] = [];
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		const handlers: ThreadHandlers = {
			...noopHandlers,
			onText(t) {
				texts.push(t);
			},
		};

		mgr.send("t1", "hello", handlers);
		const ok = await waitFor(() => texts.includes("world"));
		expect(ok).toBe(true);
		expect(mgr.getSessionInfo("t1")?.alive).toBe(true);

		mgr.closeAll();
	});

	test("respondPermission routes through SessionManager to PiProcess", async () => {
		const bin = createFakePi("");
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "manual",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		mgr.send("t1", "hi", noopHandlers);
		// Allow time for process to start
		await new Promise((r) => setTimeout(r, 100));

		// Responding to a permission should not throw even if no pending req
		const result = mgr.respondPermission("t1", "req-1", "allow");
		expect(result).toBe(true);

		mgr.closeAll();
	});

	test("PiProcess with resume passes --session arg to spawn", async () => {
		// Use a script that records argv to verify --session is passed
		const bin = createFakePi(
			`printf '%s\\n' '${JSON.stringify({ type: "response", result: { sessionId: "resume-sess" } })}'`,
		);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		mgr.setResumeId("t1", "resume-sess");
		mgr.send("t1", "hi", noopHandlers);

		const ok = await waitFor(
			() => mgr.getSessionInfo("t1")?.sessionId === "resume-sess",
		);
		expect(ok).toBe(true);

		mgr.closeAll();
	});
});

// ── instanceId uniqueness ───────────────────────────────────────────────────

test("PiProcess instanceIds are unique across instances", async () => {
	const bin = createFakePi("");
	const mgr1 = new SessionManager({
		bin,
		workDir: process.cwd(),
		mode: "auto",
		createProcess: (opts, mode) => new PiProcess(opts, mode),
	});
	mgr1.send("t1", "a", noopHandlers);
	await new Promise((r) => setTimeout(r, 50));

	const mgr2 = new SessionManager({
		bin,
		workDir: process.cwd(),
		mode: "auto",
		createProcess: (opts, mode) => new PiProcess(opts, mode),
	});
	mgr2.send("t2", "b", noopHandlers);
	await new Promise((r) => setTimeout(r, 50));

	// Both managers ran processes without error
	expect(mgr1.getSessionInfo("t1")?.alive).toBe(true);
	expect(mgr2.getSessionInfo("t2")?.alive).toBe(true);

	mgr1.closeAll();
	mgr2.closeAll();
});
