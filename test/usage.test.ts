import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { combineUsage } from "../src/usage.ts";

function usage(multiplier: number): Usage {
	return {
		input: 10 * multiplier,
		output: 5 * multiplier,
		cacheRead: 2 * multiplier,
		cacheWrite: multiplier,
		cacheWrite1h: multiplier,
		reasoning: 3 * multiplier,
		totalTokens: 18 * multiplier,
		cost: {
			input: 0.1 * multiplier,
			output: 0.2 * multiplier,
			cacheRead: 0.01 * multiplier,
			cacheWrite: 0.02 * multiplier,
			total: 0.33 * multiplier,
			totalFromProvider: true,
		},
	};
}

test("combines summarization and advisor usage", () => {
	assert.deepEqual(combineUsage(usage(1), usage(2)), {
		...usage(3),
		cost: { ...usage(3).cost, totalFromProvider: true },
	});
});

test("does not claim a combined provider-reported total when one side is estimated", () => {
	const estimated = usage(1);
	estimated.cost.totalFromProvider = false;
	assert.equal(combineUsage(usage(1), estimated).cost.totalFromProvider, false);
});
