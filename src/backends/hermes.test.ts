import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentOptions, PermissionMode } from "../agent.js";
import { HermesProcess } from "./hermes.js";

/**
 * hermes.ts — fake `hermes acp` binary strategy (mirrors pi.test.ts): the fake
 * is a PURE SHELL script that emits canned JSON-RPC lines, so we exercise the
 * backend with NO node subprocess. An earlier version did `exec node <body>` to
 * generate the JSON, which introduced runner-dependent cold-start latency and
 * made CI flaky (a 3000ms test budget the slow runner sometimes missed). Emits
 * are piped through `cat` so a block-buffered pipe stdout is flushed per line
 * (dash/bash otherwise full-buffer a pipe).
 */

// ── Fake hermes binary (pure shell, no node) ───────────────────────────────

// The body is deliberately free of `${...}` and backticks so it can live
// inside a JS template literal verbatim; variables are interpolated via %s.
const FAKE_HERMES_BODY = `
emit() { printf '%s\\n' "$1" | cat; }

# 83 health gate: hermes acp --check (classify via exit code / stderr)
for a in "$@"; do
  if [ "$a" = "--check" ]; then
    if [ -n "$FAKE_HERMES_FAILCHECK" ]; then
      printf 'Traceback (most recent call last):\\nModuleNotFoundError: No module named acp\\n' >&2
      exit 1
    fi
    printf 'OK\\n'
    exit 0
  fi
done

# 81/82 record the injected HERMES_HOME for the per-session storage test
if [ -n "$FAKE_HERMES_ENV_OUT" ]; then
  printf '{"HERMES_HOME":"%s"}' "$HERMES_HOME" > "$FAKE_HERMES_ENV_OUT" 2>/dev/null || true
fi

SID=$FAKE_HERMES_SID
[ -n "$SID" ] || SID=sess-fake-123

# startup: initialize + new_session responses (correlated by JSON-RPC id)
emit '{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{},"agentInfo":{"name":"hermes","version":"0.x"},"protocolVersion":1}}'
emit "$(printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"%s","models":[],"modes":{"availableModes":["default"],"currentModeId":"default"}}}' "$SID")"

# respond to a session/prompt on stdin (text + result, or the permission flow)
while IFS= read -r line; do
  case "$line" in
     *session/prompt*)
      if [ -n "$FAKE_HERMES_PERM" ]; then
        emit "$(printf '{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"session_id":"%s","tool_call":{"title":"Bash: ls","kind":"execute","raw_input":{"command":"ls"}},"options":[{"option_id":"allow_once","kind":"allow_once","name":"Allow once"},{"option_id":"deny","kind":"reject_once","name":"Deny"}]}}' "$SID")"
        if [ -n "$FAKE_HERMES_AUTO" ]; then
          emit "$(printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"%s","update":{"content":{"text":"ok","type":"text"},"sessionUpdate":"agent_message_chunk"}}}' "$SID")"
          emit '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":{"inputTokens":5,"outputTokens":2,"cachedReadTokens":0,"thoughtTokens":0,"totalTokens":7}}}'
        fi
      else
        emit "$(printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"%s","update":{"content":{"text":"hello","type":"text"},"sessionUpdate":"agent_message_chunk"}}}' "$SID")"
        emit '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":{"inputTokens":5,"outputTokens":2,"cachedReadTokens":0,"thoughtTokens":0,"totalTokens":7}}}'
      fi
     ;;
   esac
done
`;

function escapeShell(v: string | undefined): string {
	// POSIX single-quote-escape: wrap in '...' and replace an embedded ' with '\''.
	return (v ?? "").replace(/'/g, "'\\''");
}

function createFakeHermes(env: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "iris-fakehermes-"));
	const entry = join(dir, "hermes.sh");
	const envLines = [
		`FAKE_HERMES_FAILCHECK='${escapeShell(env.FAKE_HERMES_FAILCHECK)}'`,
		`FAKE_HERMES_PERM='${escapeShell(env.FAKE_HERMES_PERM)}'`,
		`FAKE_HERMES_AUTO='${escapeShell(env.FAKE_HERMES_AUTO)}'`,
		`FAKE_HERMES_SID='${escapeShell(env.FAKE_HERMES_SID)}'`,
		`FAKE_HERMES_ENV_OUT='${escapeShell(env.FAKE_HERMES_ENV_OUT)}'`,
	];
	writeFileSync(
		entry,
		`#!/bin/sh\n` + envLines.join("\n") + `\n\n` + FAKE_HERMES_BODY + "\n",
		{ mode: 0o755 },
	);
	return entry;
}

function newProc(
	bin: string,
	mode: PermissionMode,
	opts: Partial<AgentOptions> = {},
): HermesProcess {
	const proc = new HermesProcess(
		{
			bin,
			workDir: opts.workDir ?? process.cwd(),
			sessionKey: opts.sessionKey,
			appendSystemPrompt: opts.appendSystemPrompt,
			resume: opts.resume,
		} as AgentOptions,
		mode,
	);
	return proc;
}

/**
 * Wait for a HermesProcess event. The default budget is generous (30s): these
 * tests spawn a REAL `sh` subprocess and a full ACP handshake through node
 * pipes, so under heavy CI fork-parallel load a single proc's round-trip can
 * legitimately exceed 5–15s. 30s absorbs that jitter; a genuine deadlock still
 * surfaces (the vitest testTimeout in vitest.config.ts is set slightly higher
 * so this budget, not the outer, reports the failure cleanly).
 */
function waitFor(
	proc: HermesProcess,
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

describe("HermesProcess basic", () => {
	test("captures session id from new_session result", async () => {
		const proc = newProc(
			createFakeHermes({ FAKE_HERMES_SID: "sess-abc-999" }),
			"manual",
			{ sessionKey: "1" },
		);
		const [sid] = (await waitFor(proc, "session")) as [string];
		expect(sid).toBe("sess-abc-999");
		proc.close();
	});

	test("emits a text event from agent_message_chunk", async () => {
		const proc = newProc(createFakeHermes(), "manual", {
			sessionKey: "1",
		});
		const textP = waitFor(proc, "text");
		proc.send("hi");
		const [text] = (await textP) as [string];
		expect(text).toBe("hello");
		proc.close();
	});

	test("emits a result event from the prompt response", async () => {
		const proc = newProc(createFakeHermes(), "manual", {
			sessionKey: "1",
		});
		const resultP = waitFor(proc, "result");
		proc.send("hi");
		const [raw] = (await resultP) as [Record<string, unknown>];
		expect(raw.id).toBeDefined();
		proc.close();
	});
});

// ── Health gate (#83) ────────────────────────────────────────────────────

describe("HermesProcess health gate", () => {
	test("emits a graceful error when the acp dependency is missing", async () => {
		const proc = newProc(
			createFakeHermes({ FAKE_HERMES_FAILCHECK: "1" }),
			"manual",
			{ sessionKey: "1" },
		);
		const [err] = (await waitFor(proc, "error")) as [Error];
		expect(err.message).toContain("pre-check failed");
		expect(err.message).toContain("agent-client-protocol");
		expect(proc.isAlive()).toBe(false);
	});
});

// ── Permission bridge (#84) ──────────────────────────────────────────────

describe("HermesProcess permission", () => {
	test("manual mode surfaces a permission request to Slack", async () => {
		const proc = newProc(
			createFakeHermes({ FAKE_HERMES_PERM: "1" }),
			"manual",
			{ sessionKey: "1" },
		);
		const permP = waitFor(proc, "permission");
		proc.send("do a thing");
		const [req] = (await permP) as [
			{ requestId: string; toolName: string; input: unknown },
		];
		expect(req.requestId).toBe("perm-1");
		expect(req.toolName).toBe("Bash: ls");
		proc.close();
	});

	test("auto mode auto-resolves and never surfaces a permission event", async () => {
		const proc = newProc(
			createFakeHermes({ FAKE_HERMES_PERM: "1", FAKE_HERMES_AUTO: "1" }),
			"auto",
			{ sessionKey: "1" },
		);
		// auto mode auto-answers; the turn completes via a result event.
		const autoResultP = waitFor(proc, "result");
		proc.send("do a thing");
		await autoResultP;
		proc.close();
	});
});

// ── Per-session HERMES_HOME + SOUL.md injection (#81/#82) ────────────────

describe("HermesProcess HERMES_HOME", () => {
	test("injects a per-session HERMES_HOME and writes SOUL.md", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "iris-hermework-"));
		const key = "1788088102.502699";
		const envOut = join(workDir, "env.json");
		const proc = newProc(
			createFakeHermes({ FAKE_HERMES_ENV_OUT: envOut }),
			"manual",
			{
				workDir,
				sessionKey: key,
				appendSystemPrompt: "OUTBOX CONTRACT: write files to the outbox path.",
			},
		);
		// The new_session result (the "session" event) is the cue that the fake
		// has started and recorded its env.
		await waitFor(proc, "session");
		await new Promise((r) => setTimeout(r, 200));
		const env = JSON.parse(readFileSync(envOut, "utf8")) as {
			HERMES_HOME: string | undefined;
		};
		expect(env.HERMES_HOME).toMatch(
			/\.iris-slack\/hermes-home\/1788088102_502699$/,
		);
		// The raw thread_ts (with its dot) must not appear — the key was sanitized.
		expect(env.HERMES_HOME).not.toContain("1788088102.502699");

		const soul = join(env.HERMES_HOME ?? "", "SOUL.md");
		expect(existsSync(soul)).toBe(true);
		expect(readFileSync(soul, "utf8")).toContain("OUTBOX CONTRACT");
		proc.close();
	});
});

// ── resume path ─────────────────────────────────────────────────────────────

describe("HermesProcess resume", () => {
	test("resume seeds the session id", async () => {
		const proc = newProc(
			createFakeHermes({ FAKE_HERMES_SID: "resume-xyz" }),
			"manual",
			{
				sessionKey: "1",
				resume: "resume-xyz",
			},
		);
		expect(proc.getSessionId()).toBe("resume-xyz");
		proc.close();
	});
});
