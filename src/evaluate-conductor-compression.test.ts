import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildScenarios } from "./compare-compact.ts";
import {
	CONDUCTOR_LABELING_RUBRIC_VERSION,
	buildConductorTrainingRecords,
	serializeConductorTrainingRecords,
	type CompressionTrainingRecord,
} from "./conductor-training-data.ts";
import {
	contentHash,
	parseMessages,
	type ConductorModelArtifact,
} from "./conductor.ts";
import {
	compressionGateFailures,
	evaluateCompressionArtifact,
} from "./evaluate-conductor-compression.ts";
import { importConductorTeacherLabels, type ConductorTeacherLabel } from "./import-conductor-teacher-labels.ts";
import { buildArtifact } from "./train-conductor-model.ts";
import { buildTextualCompressorArtifact } from "./train-conductor-textual-compressor.ts";

function teacherCompressionLabel(record: CompressionTrainingRecord): ConductorTeacherLabel {
	return {
		version: 1,
		recordId: record.recordId,
		task: "compression",
		rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
		labeler: "teacher:test",
		target: {
			mode: "teacher_textual_digest",
			digest: record.target.digest,
			fidelityGate: true,
			fidelityLabels: record.target.fidelityLabels,
			rationale: "Teacher accepts the grounded deterministic digest for this proof fixture.",
		},
	};
}

test("compression evaluation accepts teacher digest table with deterministic fallback parity", async () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-compression-eval-"));
	try {
		const base = buildConductorTrainingRecords();
		const compression = base.find((record): record is CompressionTrainingRecord => record.task === "compression");
		assert.ok(compression);
		const { records } = importConductorTeacherLabels(base, [teacherCompressionLabel(compression)]);
		const dataFile = join(dir, "teacher.jsonl");
		writeFileSync(dataFile, serializeConductorTrainingRecords(records));
		const artifact = buildTextualCompressorArtifact({ dataFile });

		const report = await evaluateCompressionArtifact(artifact, { artifactFile: "fixture.json" });

		assert.equal(report.summary.fidelityEscapes, 0);
		assert.equal(report.summary.recallDelta, 0);
		assert.equal(report.summary.teacherDigestHits, 1);
		assert.equal(report.failures.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compression evaluation rejects ungrounded teacher salience markers", async () => {
	const scenario = buildScenarios()[0]!;
	const block = parseMessages(scenario.messages).blocks[0]!;
	const artifact: ConductorModelArtifact = {
		...buildArtifact(),
		compression: {
			mode: "teacher_textual_digest_table",
			confidence: 1,
			fidelityGate: true,
			baseModel: { modelFamily: "local_textual", modelId: "fixture" },
			adapter: { type: "digest_table", path: "fixture" },
			promptTemplate: "Block: {block}",
			distillation: {
				teacherRecords: 1,
				compressionRecords: 1,
				source: "fixture",
			},
			digestTable: {
				[contentHash(block)]: {
					digest: "Hallucinated path src/not-real.ts",
					fidelityLabels: {
						paths: ["src/not-real.ts"],
						commands: [],
						errors: [],
						exactValues: [],
						decisions: [],
					},
					labeler: "teacher:test",
				},
			},
		},
	};

	const report = await evaluateCompressionArtifact(artifact, { artifactFile: "fixture.json" });

	assert.equal(report.summary.teacherDigestHits, 1);
	assert.equal(report.summary.fidelityEscapes, 1);
	assert.ok(compressionGateFailures(report.summary).some((failure) => failure.includes("fidelity escapes")));
});
