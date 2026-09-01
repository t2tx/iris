import { describe, expect, test } from "vitest";

import { resolvePermissionOption } from "./hermes-permission.js";

// Realistic option sets from acp_adapter (permissions.py / edit_approval.py):
const EDIT_OPTIONS = ["allow_once", "deny"]; // edit path: fixed 2-choice
const DANGEROUS_FULL = [
	"allow_once",
	"allow_session",
	"allow_always",
	"deny",
	"deny_always",
];
const ONCE_ONLY = ["allow_once", "deny"]; // smart_denied / allow_session=False

// ── manual: always surface ────────────────────────────────────────────────

describe("manual", () => {
	test("surfaces edit requests", () => {
		expect(resolvePermissionOption("manual", EDIT_OPTIONS, true)).toEqual({
			action: "surface",
		});
	});
	test("surfaces dangerous requests", () => {
		expect(resolvePermissionOption("manual", DANGEROUS_FULL, false)).toEqual({
			action: "surface",
		});
	});
	test("surfaces even with no options", () => {
		expect(resolvePermissionOption("manual", [], false)).toEqual({
			action: "surface",
		});
	});
});

// ── acceptEdits: auto-allow edits, surface dangerous ─────────────────────

describe("acceptEdits", () => {
	test("auto-resolves edit to allow_once (no scope expansion)", () => {
		expect(resolvePermissionOption("acceptEdits", EDIT_OPTIONS, true)).toEqual({
			action: "resolve",
			optionId: "allow_once",
		});
	});
	test("surfaces a dangerous command even though acceptEdits is on", () => {
		expect(
			resolvePermissionOption("acceptEdits", DANGEROUS_FULL, false),
		).toEqual({ action: "surface" });
	});
	test("an edit with no allow_once offered falls back to surfacing", () => {
		expect(resolvePermissionOption("acceptEdits", ["deny"], true)).toEqual({
			action: "surface",
		});
	});
});

// ── auto: resolve to the widest thread-scoped grant ──────────────────────

describe("auto", () => {
	test("resolves a dangerous command to allow_session when offered", () => {
		expect(resolvePermissionOption("auto", DANGEROUS_FULL, false)).toEqual({
			action: "resolve",
			optionId: "allow_session",
		});
	});
	test("falls back to allow_always when allow_session is not offered", () => {
		expect(
			resolvePermissionOption(
				"auto",
				["allow_once", "allow_always", "deny"],
				false,
			),
		).toEqual({ action: "resolve", optionId: "allow_always" });
	});
	test("falls back to allow_once when only the 2-choice set is offered", () => {
		expect(resolvePermissionOption("auto", ONCE_ONLY, false)).toEqual({
			action: "resolve",
			optionId: "allow_once",
		});
	});
	test("resolves an edit to allow_once (2-choice edit set)", () => {
		expect(resolvePermissionOption("auto", EDIT_OPTIONS, true)).toEqual({
			action: "resolve",
			optionId: "allow_once",
		});
	});
	test("with no allow option at all, surfaces", () => {
		expect(resolvePermissionOption("auto", ["deny"], false)).toEqual({
			action: "surface",
		});
	});
});

// ── "other" collapses to non-edit on Hermes (no separate category) ──────

test("`other` is treated as non-edit (kind=execute aggregate)", () => {
	// There is no separate "other" category; a non-edit dangerous call.
	expect(resolvePermissionOption("auto", DANGEROUS_FULL, false)).toEqual({
		action: "resolve",
		optionId: "allow_session",
	});
});
