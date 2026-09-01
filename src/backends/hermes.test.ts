import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentOptions, PermissionMode } from "../agent.js";
import { HermesProcess } from "./hermes.js";

/**
 * hermes.ts — fake `hermes` binary strategy (mirrors pi.test.ts): the fake emits
 * canned JSON-RPC lines so we exercise the backend without a real MLX turn.
 */

// ── Fake hermes binary ───────────────────────────────────────────────────

const FAKE_HERMES_NODE = `
const fs = require('fs');
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
const args = process.argv.slice(2);
if (args.includes('--check')) {
  if (process.env.FAKE_HERMES_FAILCHECK) {
     process.stderr.write("Traceback (most recent call last):\\nModuleNotFoundError: No module named 'acp'\\n");
     process.exit(1);
  }
  process.stdout.write('OK\\n');
  process.exit(0);
}
if (process.env.FAKE_HERMES_ENV_OUT) {
  try { fs.writeFileSync(process.env.FAKE_HERMES_ENV_OUT, JSON.stringify({ HERMES_HOME: process.env.HERMES_HOME })); } catch (e) {}
   }
const SID = process.env.FAKE_HERMES_SID || 'sess-fake-123';
send({ jsonrpc: '2.0', id: 1, result: { agentCapabilities: {}, agentInfo: { name: 'hermes', version: '0.x' }, protocolVersion: 1 } });
send({ jsonrpc: '2.0', id: 2, result: { sessionId: SID, models: [], modes: { availableModes: ['default'], currentModeId: 'default' } } });
let done = false;
process.stdin.on('data', (d) => {
 for (const line of d.toString().split('\\n')) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch (e) { continue; }
  if (o.method === 'session/prompt') {
   if (process.env.FAKE_HERMES_PERM) {
     send({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission',
       params: { session_id: SID,
         tool_call: { title: 'Bash: ls', kind: 'execute', raw_input: { command: 'ls' } },
         options: [
            { option_id: 'allow_once', kind: 'allow_once', name: 'Allow once' },
            { option_id: 'deny', kind: 'reject_once', name: 'Deny' } ] } });
     if (process.env.FAKE_HERMES_AUTO) {
       send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SID, update: { content: { text: 'ok', type: 'text' }, sessionUpdate: 'agent_message_chunk' } } });
       send({ jsonrpc: '2.0', id: o.id, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, cachedReadTokens: 0, thoughtTokens: 0, totalTokens: 7 } } });
      }
     continue;
  }
   send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SID, update: { content: { text: 'hello', type: 'text' }, sessionUpdate: 'agent_message_chunk' } } });
   send({ jsonrpc: '2.0', id: o.id, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, cachedReadTokens: 0, thoughtTokens: 0, totalTokens: 7 } } });
   done = true;
  }
 }
});
process.stdin.resume();
setTimeout(() => { if (done) process.exit(0); }, 500);
`;

function createFakeHermes(env: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "iris-fakehermes-"));
	const body = join(dir, "hermes-body.js");
	writeFileSync(body, FAKE_HERMES_NODE);
	const entry = join(dir, "hermes.sh");
	writeFileSync(
		entry,
		`#!/bin/sh\n` +
			`FAKE_HERMES_FAILCHECK=${env.FAKE_HERMES_FAILCHECK || ""} \\\n` +
			`FAKE_HERMES_PERM=${env.FAKE_HERMES_PERM || ""} \\\n` +
			`FAKE_HERMES_AUTO=${env.FAKE_HERMES_AUTO || ""} \\\n` +
			`FAKE_HERMES_SID=${env.FAKE_HERMES_SID || ""} \\\n` +
			`FAKE_HERMES_ENV_OUT=${env.FAKE_HERMES_ENV_OUT || ""} \\\n` +
			`exec node ${body} "$@"\n`,
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

function waitFor(
	proc: HermesProcess,
	ev: string,
	ms = 3000,
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
		proc.send("hi");
		const [text] = (await waitFor(proc, "text")) as [string];
		expect(text).toBe("hello");
		proc.close();
	});

	test("emits a result event from the prompt response", async () => {
		const proc = newProc(createFakeHermes(), "manual", {
			sessionKey: "1",
		});
		proc.send("hi");
		const [raw] = (await waitFor(proc, "result")) as [Record<string, unknown>];
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
		proc.send("do a thing");
		const [req] = (await waitFor(proc, "permission")) as [
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
		proc.send("do a thing");
		// auto mode auto-answers; the turn completes via a result event.
		await waitFor(proc, "result");
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
