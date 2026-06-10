import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport, validateReport } from "./judge-report.ts";

const gate = {
	label: "test proof",
	file: "missing-proof.json",
	command: "npm run proof:test",
	expectedMeta: { budgets: [1500, 2500], compactMode: "deterministic", embeddings: true, withAnswers: true },
	maxAgeHours: 24,
	minCells: 6,
	minAdvantage: 50,
	minAccordionScore: 100,
	maxCompactWins: 0,
	maxAccordionBudgetViolations: 0,
};

function report(overrides = {}) {
	return {
		meta: {
			budgets: [1500, 2500],
			compactMode: "deterministic",
			date: "2026-06-09T00:00:00.000Z",
			embeddings: true,
			model: "test-model",
			withAnswers: true,
		},
		retrievability: { "recency-truncation": 0, compact: 0.25, accordion: 1 },
		proofSummary: {
			cells: 6,
			accordionScore: 1,
			compactScore: 0.25,
			accordionWinsVsCompact: 4,
			compactWinsVsAccordion: 0,
			tiesVsCompact: 2,
			accordionBudgetViolations: 0,
			compactBudgetViolations: 0,
			accordionAdvantagePoints: 75,
			representativeWins: [],
			...overrides,
		},
	};
}

test("judge report validation accepts reports that satisfy proof gates", () => {
	assert.deepEqual(validateReport(gate, report(), new Date("2026-06-09T12:00:00.000Z")), []);
});

test("judge report validation rejects weak or missing evidence", () => {
	const now = new Date("2026-06-09T12:00:00.000Z");
	assert.deepEqual(validateReport(gate, null, now), ["Missing missing-proof.json; run `npm run proof:test`."]);

	const failures = validateReport(gate, report({
		cells: 5,
		accordionScore: 0.9,
		compactWinsVsAccordion: 1,
		accordionBudgetViolations: 1,
		accordionAdvantagePoints: 40,
	}), now);

	assert.deepEqual(failures, [
		"test proof: cells 5 < 6",
		"test proof: advantage 40pp < 50pp",
		"test proof: Accordion score 90% < 100%",
		"test proof: compact wins 1 > 0",
		"test proof: Accordion budget violations 1 > 0",
	]);
});

test("judge report validation rejects stale, missing, and future proof dates", () => {
	assert.deepEqual(
		validateReport(gate, report(), new Date("2026-06-10T01:00:01.000Z")),
		["test proof: proof age 25h > 24h"],
	);
	assert.deepEqual(
		validateReport(gate, report({}), new Date("2026-06-08T22:00:00.000Z")),
		["test proof: proof date is 2h in the future"],
	);
	assert.deepEqual(
		validateReport(gate, {
			...report(),
			meta: {
				budgets: [1500, 2500],
				compactMode: "deterministic",
				embeddings: true,
				model: "test-model",
				withAnswers: true,
			},
		}, new Date("2026-06-09T12:00:00.000Z")),
		["test proof: missing or invalid proof date"],
	);
});

test("judge report validation rejects reports from the wrong benchmark configuration", () => {
	const now = new Date("2026-06-09T12:00:00.000Z");
	assert.deepEqual(
		validateReport(gate, { ...report(), meta: { ...report().meta, compactMode: "llm" } }, now),
		['test proof: meta.compactMode "llm" !== "deterministic"'],
	);
	assert.deepEqual(
		validateReport(gate, { ...report(), meta: { ...report().meta, budgets: [1500] } }, now),
		["test proof: meta.budgets [1500] !== [1500,2500]"],
	);
});

test("judge report includes gate status and missing report failures", () => {
	const output = renderReport([gate]);
	assert.equal(output.failures.length, 1);
	assert.match(output.markdown, /## Proof Gate Status/);
	assert.match(output.markdown, /Missing missing-proof\.json/);
	assert.match(output.markdown, /npm run proof:refresh/);
});

test("optional host compact report is visible when missing but does not fail", () => {
	const output = renderReport([{ ...gate, optional: true }]);
	assert.deepEqual(output.failures, []);
	assert.match(output.markdown, /## Optional Host \/compact Capture/);
	assert.match(output.markdown, /Not captured yet/);
});

test("optional host compact report is validated when present", () => {
	const now = new Date("2026-06-09T12:00:00.000Z");
	assert.deepEqual(
		validateReport({ ...gate, optional: true }, report({ compactWinsVsAccordion: 1 }), now),
		["test proof: compact wins 1 > 0"],
	);
});
