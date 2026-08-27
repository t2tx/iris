import { expect, test } from "vitest";

import {
	PermissionActionIds,
	PermissionRegistry,
	permissionActionKey,
	permissionBlocks,
} from "./permission.js";
import type { PermissionRequest } from "./protocol.js";

const req = (requestId: string): PermissionRequest => ({
	requestId,
	toolName: "Bash",
	input: { command: "ls" },
});

test("register returns the action key and resolve returns the entry once", () => {
	const reg = new PermissionRegistry();
	const key = reg.register("C1", "T1", req("r1"), "T1", "work", 1);
	expect(key).toBe(permissionActionKey(1, "r1"));

	const got = reg.resolve(key);
	expect(got?.channel).toBe("C1");
	expect(got?.sessionKey).toBe("T1");
	expect(got?.threadTs).toBe("T1");
	expect(got?.project).toBe("work");
	expect(got?.requestId).toBe("r1");
	expect(got?.input).toEqual({ command: "ls" });

	// second resolve is empty (consumed)
	expect(reg.resolve(key)).toBe(undefined);
});

test("DM registration has no threadTs but a channel-id session key", () => {
	const reg = new PermissionRegistry();
	const key = reg.register("D1", "D1", req("r2"), undefined, "work", 7);

	const got = reg.resolve(key);
	expect(got?.channel).toBe("D1");
	expect(got?.sessionKey).toBe("D1");
	expect(got?.threadTs).toBe(undefined);
	expect(got?.project).toBe("work");
	expect(got?.instanceId).toBe(7);
});

test("resolve of unknown key returns undefined", () => {
	const reg = new PermissionRegistry();
	expect(reg.resolve("nope")).toBe(undefined);
});

// Regression: keying by an opaque instanceId:requestId guards against a stale
// button. If a request_id is reused by a respawned process, the old button
// (carrying the old generation's key) must NOT resolve the new pending entry.
test("a stale button cannot resolve a new entry that reused the request id", () => {
	const reg = new PermissionRegistry();
	const oldKey = reg.register("C1", "T1", req("dup"), "T1", "work", 1);
	reg.resolve(oldKey); // old request handled/expired
	// New process generation reuses the same request_id.
	const newKey = reg.register("C1", "T1", req("dup"), "T1", "work", 2);
	expect(oldKey).not.toBe(newKey);
	// Clicking the stale button (oldKey) finds nothing.
	expect(reg.resolve(oldKey)).toBe(undefined);
	// The current button still works.
	expect(reg.resolve(newKey)?.instanceId).toBe(2);
});

test("drainSession removes only that session", () => {
	const reg = new PermissionRegistry();
	const a = reg.register("C1", "T1", req("a"), "T1", "work", 1);
	reg.register("C1", "T1", req("b"), "T1", "work", 1);
	const c = reg.register("C1", "T2", req("c"), "T2", "work", 2);

	const drained = reg.drainSession("T1");
	expect(drained.length).toBe(2);
	expect(drained.map((d) => d.requestId).sort()).toEqual(["a", "b"]);

	// T2 still resolvable, T1 ids gone
	expect(reg.resolve(a)).toBe(undefined);
	expect(reg.resolve(c)?.requestId).toBe("c");
});

test("drainSession with an instanceId drains only that generation", () => {
	const reg = new PermissionRegistry();
	// Same session key, two process generations (e.g. old proc + respawn).
	const oldKey = reg.register("C1", "T1", req("old"), "T1", "work", 1);
	const newKey = reg.register("C1", "T1", req("new"), "T1", "work", 2);

	// A delayed exit from the old process must not drop the new one's request.
	const drained = reg.drainSession("T1", 1);
	expect(drained.map((d) => d.requestId)).toEqual(["old"]);
	expect(reg.has(oldKey)).toBe(false);
	expect(reg.has(newKey)).toBe(true);
});

test("has reflects registration and is cleared by resolve/drain", () => {
	const reg = new PermissionRegistry();
	const key = reg.register("C1", "T1", req("x"), "T1", "work", 1);
	expect(reg.has(key)).toBe(true);
	reg.resolve(key);
	expect(reg.has(key)).toBe(false);
});

test("permissionBlocks embeds the action key in both button values", () => {
	const key = permissionActionKey(3, "r9");
	const blocks = permissionBlocks(req("r9"), key);
	const actions = blocks.find((b) => b["type"] === "actions") as {
		elements: Array<{ action_id: string; value: string }>;
	};
	const byAction = new Map(actions.elements.map((e) => [e.action_id, e.value]));
	expect(byAction.get(PermissionActionIds.allow)).toBe(key);
	expect(byAction.get(PermissionActionIds.deny)).toBe(key);
});
