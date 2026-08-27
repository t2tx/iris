import { expect, test } from "vitest";

import { isLogLevel, log, setLogLevel } from "./log.js";

test("isLogLevel accepts valid levels, rejects others", () => {
	expect(isLogLevel("debug")).toBeTruthy();
	expect(isLogLevel("info")).toBeTruthy();
	expect(isLogLevel("warn")).toBeTruthy();
	expect(isLogLevel("error")).toBeTruthy();
	expect(isLogLevel("verbose")).toBe(false);
	expect(isLogLevel("")).toBe(false);
});

/** Capture console.log/error output during fn(). */
function capture(fn: () => void): { out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const origLog = console.log;
	const origErr = console.error;
	console.log = (m?: unknown) => out.push(String(m));
	console.error = (m?: unknown) => err.push(String(m));
	try {
		fn();
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { out, err };
}

test("level filtering: warn level drops debug/info", () => {
	setLogLevel("warn");
	const { out, err } = capture(() => {
		log.debug("d");
		log.info("i");
		log.warn("w");
		log.error("e");
	});
	// debug/info suppressed; warn/error go to stderr.
	expect(out.length).toBe(0);
	expect(err.length).toBe(2);
	expect(err[0]!.includes("WARN w")).toBeTruthy();
	expect(err[1]!.includes("ERROR e")).toBeTruthy();
	setLogLevel("info"); // restore default
});

test("level filtering: debug level shows everything", () => {
	setLogLevel("debug");
	const { out, err } = capture(() => {
		log.debug("d");
		log.info("i");
	});
	expect(out.length).toBe(2);
	expect(err.length).toBe(0);
	expect(out[0]!.includes("DEBUG d")).toBeTruthy();
	setLogLevel("info");
});
