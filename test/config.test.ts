import assert from "node:assert/strict";
import test from "node:test";
import { parseModelReference, validateSettings } from "../src/config.ts";

test("approval and tools default to safe values", () => {
	assert.deepEqual(validateSettings({}), { requireApproval: true, models: {}, tools: [] });
});

test("validates descriptions, per-model thinking, yolo mode, and tool permissions", () => {
	assert.deepEqual(validateSettings({
		requireApproval: false,
		tools: ["read", "grep", "read"],
		models: {
			"openai/gpt-5.2": "  Ask this model for very difficult questions.  ",
			"openrouter/anthropic/claude-opus": {
				description: "Review architecture and subtle bugs",
				thinking: "max",
			},
		},
	}), {
		requireApproval: false,
		tools: ["read", "grep"],
		models: {
			"openai/gpt-5.2": { description: "Ask this model for very difficult questions.", thinking: "high" },
			"openrouter/anthropic/claude-opus": {
				description: "Review architecture and subtle bugs",
				thinking: "max",
			},
		},
	});
});

test("splits model references at the first slash", () => {
	assert.deepEqual(parseModelReference("openrouter/anthropic/claude-opus"), {
		provider: "openrouter",
		modelId: "anthropic/claude-opus",
	});
});

test("rejects malformed settings", () => {
	for (const value of [null, [], "settings", { requireApproval: "yes" }, { models: [] }]) {
		assert.throws(() => validateSettings(value));
	}
});

test("rejects invalid tool permissions", () => {
	for (const tools of ["read", [""], [" read"], [42], ["advisor"]]) {
		assert.throws(() => validateSettings({ tools }));
	}
});

test("rejects invalid model keys, descriptions, and thinking levels", () => {
	for (const models of [
		{ "gpt-5.2": "Missing provider" },
		{ "/gpt-5.2": "Missing provider" },
		{ "openai/": "Missing model" },
		{ " openai/gpt-5.2": "Whitespace" },
		{ "openai/gpt-5.2": "   " },
		{ "openai/gpt-5.2": 42 },
		{ "openai/gpt-5.2": { description: "Valid", thinking: "extreme" } },
		{ "openai/gpt-5.2": { thinking: "high" } },
	]) {
		assert.throws(() => validateSettings({ models }));
	}
});
