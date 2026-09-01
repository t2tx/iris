import { defineConfig } from "vitest/config";

// The hermes backend test (src/backends/hermes.test.ts) spawns a real `sh`
// subprocess and drives a full ACP handshake, so under heavy CI fork-parallel
// load its per-test runtime can exceed vitest's default 5s and the suite flakes
// (verify/coverage). Raise the failure ceilings to give generous headroom — this
// only lengthens the timeout on a real hang, not pass speed (every other test
// finishes in well under a second).
export default defineConfig({
	test: {
		testTimeout: 35_000,
		hookTimeout: 35_000,
	},
});
