import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveConductorModelAuthority, promotionFailures } from "./promote-conductor-model.ts";

function goodEvaluation() {
	return {
		summary: {
			heuristicScore: 1,
			learnedScore: 1,
			compactScore: 0.5,
			learnedQualityDelta: 0,
			learnedTokenDelta: 0,
			heuristicWins: 0,
			tokenRegressionConversations: 0,
			learnedBudgetViolations: 0,
			bootstrapQualityDelta: { probabilityNonNegative: 1 },
		},
	};
}

test("promotion failures require label agreement and non-regressive evaluation", () => {
	assert.deepEqual(
		promotionFailures(
			{ agreement: 1, disagreements: [], byTask: { fold_policy: { agreement: 1 } } },
			goodEvaluation(),
		),
		[],
	);

	const failures = promotionFailures(
		{ agreement: 0.99, disagreements: [{}], byTask: { fold_policy: { agreement: 1 } } },
		{ summary: { ...goodEvaluation().summary, learnedTokenDelta: -1, tokenRegressionConversations: 1 } },
	);
	assert.ok(failures.some((failure) => failure.includes("label agreement")));
	assert.ok(failures.some((failure) => failure.includes("token-regression")));
});

test("promotion can require teacher-distillation provenance before live authority", () => {
	const failures = promotionFailures(
		{ agreement: 1, disagreements: [], byTask: { fold_policy: { agreement: 1 } } },
		goodEvaluation(),
		{
			requireTeacherDistillation: true,
			distillation: {
				teacherRecords: 0,
				readyForLiveAuthority: false,
				missing: ["teacher_labels"],
			},
		},
	);
	assert.ok(failures.some((failure) => failure.includes("teacher distillation not ready")));
	assert.ok(failures.some((failure) => failure.includes("teacher distillation records")));

	assert.deepEqual(
		promotionFailures(
			{ agreement: 1, disagreements: [], byTask: { fold_policy: { agreement: 1 } } },
			goodEvaluation(),
			{
				requireTeacherDistillation: true,
				distillation: {
					teacherRecords: 8,
					readyForLiveAuthority: true,
					missing: [],
				},
			},
		),
		[],
	);
});

test("promotion can require a MiniLM-class fold-policy artifact", () => {
	const audit = { agreement: 1, disagreements: [], byTask: { fold_policy: { agreement: 1 } } };
	const evaluation = goodEvaluation();

	assert.ok(
		promotionFailures(audit, evaluation, {
			requireMiniLmFoldPolicy: true,
			foldPolicy: { architecture: "linear_replay" },
		}).some((failure) => failure.includes("architecture linear_replay")),
	);

	assert.deepEqual(
		promotionFailures(audit, evaluation, {
			requireMiniLmFoldPolicy: true,
			foldPolicy: {
				architecture: "minilm_cross_encoder_distilled",
				encoder: { modelFamily: "MiniLM", modelId: "sentence-transformers/all-MiniLM-L6-v2" },
				distillation: { teacherRecords: 2, trainingPairs: 10 },
				crossEncoderHead: { type: "hashed_pair_regressor", teacherPairs: 2, trainingPairs: 10 },
			},
		}),
		[],
	);
});

test("promotion can require a teacher textual compressor artifact", () => {
	const audit = { agreement: 1, disagreements: [], byTask: { compression: { agreement: 1 } } };
	const evaluation = goodEvaluation();

	assert.ok(
		promotionFailures(audit, evaluation, {
			requireTextualCompressor: true,
			compression: { mode: "deterministic_extract", fidelityGate: true },
		}).some((failure) => failure.includes("compression mode deterministic_extract")),
	);

	assert.deepEqual(
		promotionFailures(audit, evaluation, {
			requireTextualCompressor: true,
			compression: {
				mode: "teacher_textual_digest_table",
				fidelityGate: true,
				baseModel: { modelFamily: "Qwen2.5", modelId: "Qwen/Qwen2.5-0.5B-Instruct" },
				adapter: { type: "digest_table" },
				distillation: { teacherRecords: 3, compressionRecords: 2 },
				digestTable: {
					abc: { digest: "Grounded digest", labeler: "teacher:claude-sonnet-4" },
				},
			},
		}),
		[],
	);
});

test("deriveConductorModelAuthority writes conservative authority from passing evidence", () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-authority-"));
	try {
		const artifactFile = join(dir, "artifact.json");
		const labelAuditFile = join(dir, "labels.json");
		const modelEvaluationFile = join(dir, "evaluation.json");
		writeFileSync(artifactFile, JSON.stringify({
			version: 1,
			createdAt: "2026-06-12T00:00:00.000Z",
			source: "test",
			training: {
				examples: 1,
				oracleExamples: 1,
				foldPolicyExamples: 1,
				datasetHash: "abc123",
				rubricVersion: "conductor-labeling-rubric-v1",
				distillation: {
					teacherRecords: 0,
					localRecords: 1,
					labelers: ["local-replay-rubric"],
					readyForLiveAuthority: false,
					missing: ["teacher_labels", "teacher_labeler"],
				},
			},
			budgetOracle: { intercept: 1, weights: {}, confidence: 1 },
			foldPolicy: { intercept: 0, weights: {}, confidence: 1, reuseHorizonTurns: 12 },
			compression: { mode: "deterministic_extract", confidence: 1, fidelityGate: true },
		}));
		writeFileSync(labelAuditFile, JSON.stringify({
			agreement: 1,
			disagreements: [],
			byTask: {
				budget_oracle: { agreement: 1 },
				fold_policy: { agreement: 1 },
				compression: { agreement: 1 },
			},
		}));
		writeFileSync(modelEvaluationFile, JSON.stringify(goodEvaluation()));

		const authority = deriveConductorModelAuthority({
			artifactFile,
			labelAuditFile,
			modelEvaluationFile,
			generatedAt: "2026-06-12T00:00:00.000Z",
		});

		assert.equal(authority.artifactDatasetHash, "abc123");
		assert.equal(authority.authority.budgetOracle.mode, "cost_guarded");
		assert.equal(authority.authority.foldPolicy.mode, "shadow_only");
		assert.equal(authority.authority.compression.mode, "digest_only");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
