import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentOptions, PermissionMode } from "../agent.js";
import { CopilotProcess } from "./copilot.js";

/**
 * copilot.ts — fake `copilot --acp` binary strategy (mirrors hermes.test.ts):
 * the fake is a PURE SHELL script that emits canned ACP JSON-RPC lines read from
 * stdin (no node subprocess, so the handshake is deterministic and CI-stable).
 * Emits are piped through `cat` so a block-buffered pipe stdout is flushed per
 * line. Copilot's ACP shape (verified against v1.0.82): a `session/new` result
 * carrying `sessionId`; a `session/prompt` response carrying `stopReason` + a
 * `usage` payload with `cachedReadTokens`/`cachedWriteTokens` (no `costUSD`).
 */

// The body is deliberately free of `${...}`/backticks so it can live inside a JS
// template literal verbatim; variables are interpolated via %s.
const FAKE_COPILOT_BODY = `
emit() { printf '%s\\n' "$1" | cat; }

# record the argv the process was launched with (for the permission-flag tests)
if [ -n "$FAKE_COPILOT_ARGS_OUT" ]; then
  args=""
  for a in "$@"; do args="$args|[$a]"; done
  printf '%s' "$args" > "$FAKE_COPILOT_ARGS_OUT" 2>/dev/null || true
fi

SID=$FAKE_COPILOT_SID
[ -n "$SID" ] || SID=sess-copilot-123

# Proper ACP request/response: read each JSON-RPC request from stdin and reply
# with the SAME id, in send order.
while IFS= read -r line; do
  rid=$(printf '%s' "$line" | grep -o '"id":[0-9][0-9]*' | head -n1 | sed 's/^"id"://')
  case "$line" in
	*initialize*)
		emit "$(printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":{},"agentInfo":{"name":"copilot","version":"0.x"},"authMethods":[],"models":{"availableModels":[],"currentModelId":"default"},"modes":{"availableModes":[],"currentModeId":"default"},"configOptions":[]}}' "$rid")"
		;;
	*session/list*)
      emit "$(printf '{"jsonrpc":"2.0","id":%s,"result":{"sessions":[{"sessionId":"%s","cwd":"/proj","title":"hello there","updatedAt":"2026-01-02T00:00:00.000Z"}]}}' "$rid" "$SID")"
        ;;
        *session/new*)
      emit "$(printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"%s","models":{"availableModels":[],"currentModelId":"default"},"modes":{"availableModes":[],"currentModeId":"default"},"configOptions":[]}}' "$rid" "$SID")"
        ;;
        *session/prompt*)
      emit "$(printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"%s","update":{"content":{"text":"copilot-say","type":"text"},"sessionUpdate":"agent_message_chunk"}}}' "$SID")"
      emit "$(printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"%s","update":{"id":"tc-1","title":"Copilot","kind":"execute","status":"in_progress","content":[],"sessionUpdate":"tool_call"}}}' "$SID")"
      emit "$(printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn","usage":{"inputTokens":5,"outputTokens":2,"totalTokens":7,"thoughtTokens":0,"cachedReadTokens":4,"cachedWriteTokens":3}}}' "$rid")"
        ;;
   esac
done
`;

function escapeShell(v: string | undefined): string {
	// POSIX single-quote-escape: wrap in '...' and replace an embedded ' with '\''.
	return (v ?? "").replace(/'/g, "'\\''");
}

function createFakeCopilot(env: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "iris-fakecopilot-"));
	const entry = join(dir, "copilot.sh");
	const envLines = [
		`FAKE_COPILOT_SID='${escapeShell(env.FAKE_COPILOT_SID)}'`,
		`FAKE_COPILOT_ARGS_OUT='${escapeShell(env.FAKE_COPILOT_ARGS_OUT)}'`,
	];
	writeFileSync(
		entry,
		`#!/bin/sh\n` + envLines.join("\n") + `\n\n` + FAKE_COPILOT_BODY + "\n",
		{ mode: 0o755 },
	);
	return entry;
}

function newProc(
	bin: string,
	mode: PermissionMode,
	opts: Partial<AgentOptions> = {},
): CopilotProcess {
	return new CopilotProcess(
		{
			bin,
			workDir: opts.workDir ?? process.cwd(),
			sessionKey: opts.sessionKey,
			appendSystemPrompt: opts.appendSystemPrompt,
			resume: opts.resume,
		} as AgentOptions,
		mode,
	);
}

/**
 * Wait for a CopilotProcess event. 30s budget absorbs CI fork-parallel jitter
 * (a genuine deadlock still surfaces via the slightly higher outer testTimeout).
 */
function waitFor(
	proc: CopilotProcess,
	ev: string,
	ms = 30_000,
): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(
			() => reject(new Error(`timeout waiting for ${ev}`)),
			ms,
		);
		proc.on(ev, (...args: unknown[]) => {
			clearTimeout(t);
			resolve(args);
		});
	});
}

// ── Basic spawn + capture ────────────────────────────────────────────────

describe("CopilotProcess basic", () => {
	test("captures session id from session/new result", async () => {
		const proc = newProc(
			createFakeCopilot({ FAKE_COPILOT_SID: "sess-copilot-abc-999" }),
			"manual",
			{ sessionKey: "1" },
		);
		const [sid] = (await waitFor(proc, "session")) as [string];
		expect(sid).toBe("sess-copilot-abc-999");
		proc.close();
	});

	test("emits a text event from an agent_message_chunk", async () => {
		const proc = newProc(createFakeCopilot(), "manual", { sessionKey: "1" });
		const textP = waitFor(proc, "text");
		proc.send("hi");
		const [text] = (await textP) as [string];
		expect(text).toBe("copilot-say");
		proc.close();
	});

	test("emits a result event and maps copilot usage → UsageInfo", async () => {
		const proc = newProc(createFakeCopilot(), "manual", { sessionKey: "1" });
		const resultP = waitFor(proc, "result");
		proc.send("hi");
		const [raw, usage] = (await resultP) as [
			Record<string, unknown>,
			{
				cacheCreationTokens?: number;
				inputTokens?: number;
				outputTokens?: number;
			},
		];
		expect(raw.id).toBeDefined();
		// cachedWriteTokens → cacheCreationTokens is the key copilot mapping.
		expect(usage?.cacheCreationTokens).toBe(3);
		expect(usage?.inputTokens).toBe(5);
		expect(usage?.outputTokens).toBe(2);
		proc.close();
	});
});

// ── Permission flag mapping (launch-time gating, R2) ───────────────────────

describe("CopilotProcess permission flag mapping", () => {
	test("auto → --allow-all in argv", async () => {
		const argsOut = join(mkdtempSync(join(tmpdir(), "iris-cp1-")), "args");
		const proc = newProc(
			createFakeCopilot({ FAKE_COPILOT_ARGS_OUT: argsOut }),
			"auto",
			{ sessionKey: "1" },
		);
		await waitFor(proc, "session");
		proc.send("hi");
		await waitFor(proc, "result");
		proc.close();
		await new Promise((r) => setTimeout(r, 100));
		const argv = readFileSync(argsOut, "utf-8");
		expect(argv).toContain("|[--allow-all]");
		expect(argv).not.toContain("|[--allow-tool]");
		expect(argv).toContain("|[--acp]");
	});

	test("acceptEdits → --allow-tool write in argv", async () => {
		const argsOut = join(mkdtempSync(join(tmpdir(), "iris-cp2-")), "args");
		const proc = newProc(
			createFakeCopilot({ FAKE_COPILOT_ARGS_OUT: argsOut }),
			"acceptEdits",
			{ sessionKey: "1" },
		);
		await waitFor(proc, "session");
		proc.send("hi");
		await waitFor(proc, "result");
		proc.close();
		await new Promise((r) => setTimeout(r, 100));
		const argv = readFileSync(argsOut, "utf-8");
		expect(argv).toContain("|[--allow-tool]");
		expect(argv).toContain("|[write]");
		expect(argv).not.toContain("|[--allow-all]");
	});

	test("manual → no permission flag added", async () => {
		const argsOut = join(mkdtempSync(join(tmpdir(), "iris-cp3-")), "args");
		const proc = newProc(
			createFakeCopilot({ FAKE_COPILOT_ARGS_OUT: argsOut }),
			"manual",
			{ sessionKey: "1" },
		);
		await waitFor(proc, "session");
		proc.send("hi");
		await waitFor(proc, "result");
		proc.close();
		await new Promise((r) => setTimeout(r, 100));
		const argv = readFileSync(argsOut, "utf-8");
		expect(argv).not.toContain("--allow-all");
		expect(argv).not.toContain("--allow-tool");
	});
});

// ── --resume plumbing ─────────────────────────────────────────────────────

describe("CopilotProcess --resume", () => {
	test("resume session id is forwarded as --resume argv", async () => {
		const argsOut = join(mkdtempSync(join(tmpdir(), "iris-cp4-")), "args");
		const proc = newProc(
			createFakeCopilot({
				FAKE_COPILOT_ARGS_OUT: argsOut,
				FAKE_COPILOT_SID: "resume-sid",
			}),
			"manual",
			{ sessionKey: "1", resume: "resume-sid" },
		);
		// The fake writes its argv at spawn (before the read loop); the resume id is
		// pre-seeded so copilot.ts does NOT re-emit a `session` event for it — poll
		// the args file instead of waiting for an event.
		const start = Date.now();
		while (!existsSync(argsOut) && Date.now() - start < 5_000) {
			await new Promise((r) => setTimeout(r, 25));
		}
		const argv = existsSync(argsOut) ? readFileSync(argsOut, "utf-8") : "";
		// Drain the in-flight handshake before closing so rejectPending has no open
		// request to reject (a mid-flight close leaves an unhandled rejection).
		await new Promise((r) => setTimeout(r, 250));
		proc.close();
		expect(argv).toContain("|[--resume]");
		expect(argv).toContain("|[resume-sid]");
		expect(argv).toContain("|[--acp]");
		expect(argv).toContain("|[--log-level]");
	});
});

// ── close() reaps the process group ───────────────────────────────────────

describe("CopilotProcess lifecycle", () => {
	test("close() stops the process (isAlive → false)", async () => {
		const proc = newProc(createFakeCopilot(), "manual", { sessionKey: "1" });
		await waitFor(proc, "session");
		expect(proc.isAlive()).toBe(true);
		proc.close();
		await new Promise((r) => setTimeout(r, 150));
		expect(proc.isAlive()).toBe(false);
	});

	test("isAlive is false after the fake exits on its own", async () => {
		const proc = newProc(createFakeCopilot(), "manual", { sessionKey: "1" });
		await waitFor(proc, "session");
		proc.send("hi");
		await waitFor(proc, "result");
		// The fake's `while read` loop ends when stdin closes; SIGTERM reaps it.
		proc.close();
		await new Promise((r) => setTimeout(r, 200));
		expect(proc.isAlive()).toBe(false);
	});
});

// guard: ensure a bogus bin surfaces as an error rather than a hang
describe("CopilotProcess error", () => {
	test("a non-existent bin surfaces as an error event", async () => {
		const proc = newProc("/nonexistent/copilot-binary-xyz", "manual", {
			sessionKey: "1",
		});
		const errP = waitFor(proc, "error", 5_000);
		const procErr = await errP;
		expect(procErr[0]).toBeInstanceOf(Error);
		expect(proc.isAlive()).toBe(false);
	});
});
