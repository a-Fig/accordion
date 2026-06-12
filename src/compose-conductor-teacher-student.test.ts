import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CONDUCTOR_LABELING_RUBRIC_VERSION,
	buildConductorTrainingRecords,
	serializeConductorTrainingRecords,
	type CompressionTrainingRecord,
	type FoldPolicyTrainingRecord,
} from "./conductor-training-data.ts";
import { composeTeacherStudentArtifact } from "./compose-conductor-teacher-student.ts";
import { importConductorTeacherLabels, type ConductorTeacherLabel } from "./import-conductor-teacher-labels.ts";
import { buildMiniLmPolicyArtifact } from "./train-conductor-minilm-policy.ts";
import { buildArtifact } from "./train-conductor-model.ts";
import { buildTextualCompressorArtifact } from "./train-conductor-textual-compressor.ts";

function teacherLabels(): ConductorTeacherLabel[] {
	const base = buildConductorTrainingRecords();
	const fold = base.find((record): record is FoldPolicyTrainingRecord => record.task === "fold_policy");
	const compression = base.find((record): record is CompressionTrainingRecord => record.task === "compression");
	assert.ok(fold);
	assert.ok(compression);
	return [
		{
			version: 1,
			recordId: fold.recordId,
			task: "fold_policy",
			rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
			labeler: "teacher:test",
			target: {
				label: "positive",
				keepScore: 0.91,
				expectedReuseTurns: 0,
				level: 0,
				puWeight: 1,
				rationale: "Teacher fold label.",
			},
		},
		{
			version: 1,
			recordId: compression.recordId,
			task: "compression",
			rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
			labeler: "teacher:test",
			target: {
				mode: "teacher_textual_digest",
				digest: "Teacher grounded digest.",
				fidelityGate: true,
				fidelityLabels: {
					paths: [],
					commands: [],
					errors: [],
					exactValues: [],
					decisions: [],
				},
				rationale: "Teacher compression label.",
			},
		},
	];
}

test("compose teacher student artifact combines MiniLM policy and textual compressor from one dataset", () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-compose-teacher-"));
	try {
		const baseRecords = buildConductorTrainingRecords();
		const { records } = importConductorTeacherLabels(baseRecords, teacherLabels());
		const dataFile = join(dir, "teacher.jsonl");
		const baseFile = join(dir, "base.json");
		const foldFile = join(dir, "fold.json");
		const compressionFile = join(dir, "compression.json");
		writeFileSync(dataFile, serializeConductorTrainingRecords(records));
		writeFileSync(baseFile, `${JSON.stringify(buildArtifact(dataFile), null, 2)}\n`);
		writeFileSync(foldFile, `${JSON.stringify(buildMiniLmPolicyArtifact({ dataFile }), null, 2)}\n`);
		writeFileSync(compressionFile, `${JSON.stringify(buildTextualCompressorArtifact({ dataFile }), null, 2)}\n`);

		const artifact = composeTeacherStudentArtifact({
			baseFile,
			foldPolicyFile: foldFile,
			compressionFile,
		});

		assert.equal(artifact.foldPolicy.architecture, "minilm_cross_encoder_distilled");
		assert.equal(artifact.compression.mode, "teacher_textual_digest_table");
		assert.equal(artifact.training.distillation?.teacherRecords, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compose teacher student artifact rejects mismatched dataset hashes", () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-compose-mismatch-"));
	try {
		const baseRecords = buildConductorTrainingRecords();
		const { records } = importConductorTeacherLabels(baseRecords, teacherLabels());
		const dataFile = join(dir, "teacher.jsonl");
		const baseFile = join(dir, "base.json");
		const foldFile = join(dir, "fold.json");
		const compressionFile = join(dir, "compression.json");
		writeFileSync(dataFile, serializeConductorTrainingRecords(records));
		const base = buildArtifact(dataFile);
		const fold = buildMiniLmPolicyArtifact({ dataFile });
		fold.training.datasetHash = "different";
		writeFileSync(baseFile, `${JSON.stringify(base, null, 2)}\n`);
		writeFileSync(foldFile, `${JSON.stringify(fold, null, 2)}\n`);
		writeFileSync(compressionFile, `${JSON.stringify(buildTextualCompressorArtifact({ dataFile }), null, 2)}\n`);

		assert.throws(
			() => composeTeacherStudentArtifact({ baseFile, foldPolicyFile: foldFile, compressionFile }),
			/different datasets/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
