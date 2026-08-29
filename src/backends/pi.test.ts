import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
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

// ── Per-project session-dir isolation ────────────────────────────────────────

describe("PiProcess session-dir isolation", () => {
	test("passing sessionDir adds --session-dir to argv", async () => {
		const argvPath = join(
			mkdtempSync(join(tmpdir(), "iris-argv-")),
			"argv.log",
		);
		const sessionDir = mkdtempSync(join(tmpdir(), "iris-sessdir-"));
		const resp = JSON.stringify({
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionId: "isolation-sess" },
		});
		const script = [
			`printf '%s\n' "$*" >> "${argvPath}"`,
			`printf '%s\n' '${resp}'`,
			"exec cat >/dev/null",
		].join("\n");
		const bin = createFakePi(script);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			sessionDir,
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		mgr.send("t1", "hi", noopHandlers);
		const ok = await waitFor(
			() => mgr.getSessionInfo("t1")?.sessionId === "isolation-sess",
		);
		expect(ok).toBe(true);

		const spawnLines = readFileSync(argvPath, "utf8")
			.split("\n")
			.filter((s) => s.includes("--mode"));
		expect(spawnLines.length).toBeGreaterThanOrEqual(1);
		expect(spawnLines[0]).toContain(`--session-dir ${sessionDir}`);
		expect(spawnLines[0]).toContain("--mode rpc");

		mgr.closeAll();
	});

	test("omitting sessionDir does not add --session-dir to argv", async () => {
		const argvPath = join(
			mkdtempSync(join(tmpdir(), "iris-argv-")),
			"argv.log",
		);
		const resp = JSON.stringify({
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionId: "no-dir-sess" },
		});
		const script = [
			`printf '%s\n' "$*" >> "${argvPath}"`,
			`printf '%s\n' '${resp}'`,
			"exec cat >/dev/null",
		].join("\n");
		const bin = createFakePi(script);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			// No sessionDir — should NOT add the flag.
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		mgr.send("t1", "hi", noopHandlers);
		const ok = await waitFor(
			() => mgr.getSessionInfo("t1")?.sessionId === "no-dir-sess",
		);
		expect(ok).toBe(true);

		const spawnLines = readFileSync(argvPath, "utf8")
			.split("\n")
			.filter((s) => s.includes("--mode"));
		expect(spawnLines.length).toBeGreaterThanOrEqual(1);
		expect(spawnLines[0]).not.toContain("--session-dir");

		mgr.closeAll();
	});

	test("sessionDir survives killSession + respawn (--session-dir + --session)", async () => {
		const argvPath = join(
			mkdtempSync(join(tmpdir(), "iris-argv-")),
			"argv.log",
		);
		const sessionDir = mkdtempSync(join(tmpdir(), "iris-sessdir-"));
		const resp = JSON.stringify({
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionId: "isolation-resume" },
		});
		const script = [
			`printf '%s\n' "$*" >> "${argvPath}"`,
			`printf '%s\n' '${resp}'`,
			"exec cat >/dev/null",
		].join("\n");
		const bin = createFakePi(script);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			sessionDir,
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		let exited = false;
		mgr.send("t1", "first", {
			...noopHandlers,
			onExit() {
				exited = true;
			},
		});
		const captured = await waitFor(
			() => mgr.getSessionInfo("t1")?.sessionId === "isolation-resume",
		);
		expect(captured).toBe(true);

		expect(mgr.killSession("t1")).toBe(true);
		await waitFor(() => exited);
		expect(mgr.getSessionInfo("t1")?.alive).toBe(false);

		mgr.send("t1", "second", noopHandlers);
		await waitFor(() => {
			const lines = readFileSync(argvPath, "utf8")
				.split("\n")
				.filter((s) => s.includes("--mode"));
			const last = lines[lines.length - 1];
			return Boolean(
				lines.length >= 2 &&
					last?.includes("--session") &&
					last?.includes(`--session-dir ${sessionDir}`),
			);
		});
		const spawnLines = readFileSync(argvPath, "utf8")
			.split("\n")
			.filter((s) => s.includes("--mode"));
		expect(spawnLines.length).toBeGreaterThanOrEqual(2);
		const lastSpawn = spawnLines[spawnLines.length - 1];
		expect(lastSpawn).toContain("--session isolation-resume");
		expect(lastSpawn).toContain(`--session-dir ${sessionDir}`);

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

	// The reliable capture path: Pi never emits its session id on its own, so
	// PiProcess pulls it via a get_state RPC right after spawn.
	test("captures session id from get_state response (data.sessionId)", async () => {
		const bin = createFakePi(
			`printf '%s\\n' '${JSON.stringify({
				type: "response",
				command: "get_state",
				success: true,
				data: { sessionId: "pi-getstate-789" },
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
			() => mgr.getSessionInfo("t1")?.sessionId === "pi-getstate-789",
		);
		expect(ok).toBe(true);

		mgr.closeAll();
	});

	// After a killSession the entry (and its captured session id) is kept, so the
	// next spawn must pass --session to resume the same conversation.
	test("resumes via --session after killSession (session id survives)", async () => {
		const logFile = join(mkdtempSync(join(tmpdir(), "iris-argv-")), "argv.log");
		// Record argv (one line per spawn, appended) then emit a get_state
		// response. $* joins positional args on a single line.
		const resp = JSON.stringify({
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionId: "resume-after-kill" },
		});
		const script = [
			`printf '%s\\n' "$*" >> "${logFile}"`,
			`printf '%s\\n' '${resp}'`,
			"exec cat >/dev/null",
		].join("\n");
		const bin = createFakePi(script);
		const mgr = new SessionManager({
			bin,
			workDir: process.cwd(),
			mode: "auto",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		// Kill the process and wait for it to actually die; the entry + its
		// captured session id are kept, so the next send resumes via --session.
		let exited = false;
		const killHandlers: ThreadHandlers = {
			...noopHandlers,
			onExit() {
				exited = true;
			},
		};
		mgr.send("t1", "first", killHandlers);
		const captured = await waitFor(
			() => mgr.getSessionInfo("t1")?.sessionId === "resume-after-kill",
		);
		expect(captured).toBe(true);

		expect(mgr.killSession("t1")).toBe(true);
		// Ensure the process has fully exited so the next send really respawns
		// (otherwise ensure() reuses the still-alive process and no new spawn
		// — carrying --session — occurs).
		await waitFor(() => exited);
		expect(mgr.getSessionInfo("t1")?.alive).toBe(false);

		// Next message must respawn with --session <id>.
		mgr.send("t1", "second", noopHandlers);
		await waitFor(() => {
			const lines = readFileSync(logFile, "utf8")
				.split("\n")
				.filter((s) => s.includes("--mode"));
			const last = lines[lines.length - 1];
			return Boolean(lines.length >= 2 && last?.includes("--session"));
		});
		expect(mgr.getSessionInfo("t1")?.alive).toBe(true);

		const spawnLines = readFileSync(logFile, "utf8")
			.split("\n")
			.filter((s) => s.includes("--mode"));
		// At least two spawns; the last one carries --session resume-after-kill.
		expect(spawnLines.length).toBeGreaterThanOrEqual(2);
		const lastSpawn = spawnLines[spawnLines.length - 1];
		expect(lastSpawn).toContain("--session resume-after-kill");

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

// ── Inbound attachments (images / files) ────────────────────────────────────

/**
 * Capture the `prompt` payload the backend writes to the child's stdin so we
 * can assert its exact shape. The fake binary emits a get_state response first
 * (so the session id lands); we then poll the log for the prompt before closeAll().
 */
describe("PiProcess attachments", () => {
	async function runWithStdin(
		attachments: { name: string; mimeType: string; data: Buffer }[],
		workDir = process.cwd(),
	): Promise<Record<string, unknown>> {
		const binDir = mkdtempSync(join(tmpdir(), "iris-fakepi-"));
		const stdinPath = join(binDir, "stdin.log");

		// Emit the get_state response FIRST so the session id lands, then drain
		// stdin to a log file. `cat` blocks on stdin, so the response must precede
		// it; closeAll() ends stdin so the child flushes and exits.
		const resp = JSON.stringify({
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionId: "attach-sess" },
		});
		const script = [`printf '%s\\n' '${resp}'`, `cat > "${stdinPath}"`].join(
			"\n",
		);
		const bin = createFakePi(script);
		const mgr = new SessionManager({
			bin,
			workDir,
			mode: "auto",
			createProcess: (opts, mode) => new PiProcess(opts, mode),
		});

		mgr.send("t1", "prompt with attachments", noopHandlers, attachments);
		await waitFor(() => mgr.getSessionInfo("t1")?.sessionId === "attach-sess");
		// Poll the log until the prompt body lands, *before* closeAll(): the
		// SIGTERM that ends the child can kill the blocking `cat` redirect before
		// it flushes, and reading after closeAll() truncates the log.
		const landed = await waitFor(() => {
			if (!existsSync(stdinPath)) return false;
			return readFileSync(stdinPath, "utf8").includes('"type":"prompt"');
		});
		expect(landed).toBe(true);
		const raw = existsSync(stdinPath)
			? readFileSync(stdinPath, "utf8").split("\n").filter(Boolean)
			: [];
		mgr.closeAll();
		const promptLine = raw.find((l) => l.includes("prompt"));
		if (promptLine === undefined)
			throw new Error("prompt not captured on stdin");
		return JSON.parse(promptLine) as Record<string, unknown>;
	}

	test("routes image as a separate images field with a string message", async () => {
		const prompt = await runWithStdin([
			{
				name: "shot.png",
				mimeType: "image/png",
				data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
			},
		]);
		// message must be a plain string (Pi runs text.startsWith on it).
		expect(typeof prompt.message).toBe("string");
		expect(Array.isArray(prompt.message)).toBe(false);
		// Images travel in a separate field in Pi's ImageContent shape.
		const images = prompt.images as Array<Record<string, unknown>>;
		expect(Array.isArray(images)).toBe(true);
		expect(images.length).toBe(1);
		expect(images[0]?.type).toBe("image");
		expect(images[0]?.mimeType).toBe("image/png");
		expect(typeof images[0]?.data).toBe("string");
		// followUp lets a prompt land mid-stream.
		expect(prompt.streamingBehavior).toBe("followUp");
	});

	test("non-image file is saved to .iris/attachments and referenced in message", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "iris-piw-"));
		const prompt = await runWithStdin(
			[
				{
					name: "report.pdf",
					mimeType: "application/pdf",
					data: Buffer.from("hello"),
				},
				{
					name: "shot.png",
					mimeType: "image/png",
					data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
				},
			],
			workDir,
		);
		// The image went to the separate images field.
		const images = prompt.images as Array<Record<string, unknown>>;
		expect(images.length).toBe(1);
		expect(images[0]?.mimeType).toBe("image/png");
		// The file path is referenced in the string message.
		expect(typeof prompt.message).toBe("string");
		expect(String(prompt.message)).toContain("report.pdf");
		// The file is actually on disk under <workDir>/.iris/attachments.
		const saved = readdirSync(join(workDir, ".iris", "attachments"));
		expect(saved.length).toBe(1);
		expect(saved[0] ?? "").toContain("report.pdf");
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
