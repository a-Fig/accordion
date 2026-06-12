import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapMean, summarizeCells } from "./evaluate-conductor-model.ts";

function score(score: number, tokens: number) {
	return { score, tokens, withinBudget: tokens <= 1_500, hasAnswer: score > 0 };
}

test("paired bootstrap is computed over conversation deltas", () => {
	const cells = [
		{
			scenario: "a",
			category: "exact",
			budget: 1_500,
			heuristic: score(1, 1_200),
			learned: score(1, 1_100),
			compact: score(0, 700),
		},
		{
			scenario: "a",
			category: "exact",
			budget: 2_500,
			heuristic: score(1, 1_900),
			learned: score(1, 1_800),
			compact: score(0, 700),
		},
		{
			scenario: "b",
			category: "semantic",
			budget: 1_500,
			heuristic: score(0, 1_200),
			learned: score(1, 1_150),
			compact: score(0, 700),
		},
	] as any;

	const { summary, conversations } = summarizeCells(cells, 200);

	assert.equal(conversations.length, 2);
	assert.equal(conversations.find((item) => item.scenario === "a")?.learnedQualityDelta, 0);
	assert.equal(conversations.find((item) => item.scenario === "b")?.learnedQualityDelta, 1);
	assert.equal(summary.learnedWins, 1);
	assert.equal(summary.heuristicWins, 0);
	assert.equal(summary.bootstrapQualityDelta.probabilityNonNegative, 1);
	assert.ok(summary.bootstrapTokenDelta.mean > 0);
});

test("bootstrapMean is deterministic and reports confidence bounds", () => {
	const first = bootstrapMean([0, 1, 1], 100);
	const second = bootstrapMean([0, 1, 1], 100);

	assert.deepEqual(first, second);
	assert.equal(first.mean, 0.667);
	assert.ok(first.lower95 >= 0);
	assert.ok(first.upper95 <= 1);
});
