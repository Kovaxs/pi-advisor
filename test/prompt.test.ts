import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildAdvicePrompt, buildSummaryInstructions, buildToolDescription, extractAdvice } from "../src/prompt.ts";

test("builds a focused request from the question and compacted summary", () => {
	const prompt = buildAdvicePrompt("How should I fix the lock ordering?", "Thread B holds the registry lock.");
	assert.match(prompt, /<question>\nHow should I fix the lock ordering\?\n<\/question>/);
	assert.match(prompt, /<compacted_context>\nThread B holds the registry lock\.\n<\/compacted_context>/);
	assert.doesNotMatch(prompt, /executor_transcript|executor_system_prompt/);
});

test("focuses compaction on the advisor question", () => {
	const instructions = buildSummaryInstructions("Which cache key is safe?");
	assert.match(instructions, /Which cache key is safe\?/);
	assert.match(instructions, /Preserve the user's goal, constraints, current approach, important evidence/);
	assert.match(instructions, /Omit unrelated history/);
});

test("describes the compact-then-advise pipeline", () => {
	const description = buildToolDescription({
		"openai/gpt-5.2": { description: "Difficult questions", thinking: "high" },
		"anthropic/claude-opus": { description: "Architecture review", thinking: "max" },
	}, ["read", "grep"]);
	assert.match(description, /openai\/gpt-5\.2 \(thinking: high\): Difficult questions/);
	assert.match(description, /anthropic\/claude-opus \(thinking: max\): Architecture review/);
	assert.match(description, /compact the conversation into a summary focused on your question/);
	assert.match(description, /sends only that summary and question/);
	assert.match(description, /Advisor tool allowlist: read, grep/);
});

test("defaults the advertised advisor tool access to none", () => {
	assert.match(
		buildToolDescription({ "mock/model": { description: "Testing", thinking: "off" } }, []),
		/The advisor has no tool access/,
	);
});

test("extracts only final text content", () => {
	const content = [
		{ type: "thinking", thinking: "private reasoning" },
		{ type: "text", text: "First recommendation." },
		{ type: "text", text: "Second recommendation." },
	] as AssistantMessage["content"];
	assert.equal(extractAdvice(content), "First recommendation.\nSecond recommendation.");
});
