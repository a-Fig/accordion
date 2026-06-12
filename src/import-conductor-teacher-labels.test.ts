import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CONDUCTOR_LABELING_RUBRIC_VERSION,
	buildConductorTrainingRecords,
	conductorTrainingVectors,
	parseConductorTrainingJsonl,
	serializeConductorTrainingRecords,
	type FoldPolicyTrainingRecord,
} from "./conductor-training-data.ts";
import {
	importConductorTeacherLabels,
	parseConductorTeacherLabels,
	type ConductorTeacherLabel,
} from "./import-conductor-teacher-labels.ts";
import { buildArtifact } from "./train-conductor-model.ts";

function teacherFoldLabel(record: FoldPolicyTrainingRecord): ConductorTeacherLabel {
	return {
		version: 1,
		recordId: record.recordId,
		task: "fold_policy",
		rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
		labeler: "teacher:claude-sonnet-4",
		target: {
			label: "positive",
			keepScore: 0.91,
			expectedReuseTurns: 0,
			level: 0,
			puWeight: 1,
			rationale: "Teacher marked this block as immediately reusable under the frozen rubric.",
		},
	};
}

test("teacher label import appends validated teacher records without mutating local labels", () => {
	const base = buildConductorTrainingRecords();
	const fold = base.find((record): record is FoldPolicyTrainingRecord => record.task === "fold_policy");
	assert.ok(fold);
	const labels = parseConductorTeacherLabels(`${JSON.stringify(teacherFoldLabel(fold))}\n`);

	const { records, report } = importConductorTeacherLabels(base, labels);
	const vectors = conductorTrainingVectors(records);
	const imported = records.find((record) => record.recordId.startsWith(`${fold.recordId}:teacher:`));

	assert.equal(report.importedRecords, 1);
	assert.equal(report.byTask.fold_policy, 1);
	assert.equal(records.length, base.length + 1);
	assert.equal(vectors.teacherRecords, 1);
	assert.equal(vectors.localRecords, base.length);
	assert.ok(imported);
	assert.equal(imported.labeler, "teacher:claude-sonnet-4");
	assert.equal((imported as FoldPolicyTrainingRecord).target.keepScore, 0.91);
	assert.equal(fold.labeler, "local-replay-rubric");
});

test("teacher-augmented training data makes the artifact distillation-ready", () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-teacher-import-"));
	try {
		const base = buildConductorTrainingRecords();
		const fold = base.find((record): record is FoldPolicyTrainingRecord => record.task === "fold_policy");
		assert.ok(fold);
		const { records } = importConductorTeacherLabels(base, [teacherFoldLabel(fold)]);
		const dataFile = join(dir, "teacher.jsonl");
		writeFileSync(dataFile, serializeConductorTrainingRecords(records));

		const parsed = parseConductorTrainingJsonl(serializeConductorTrainingRecords(records));
		const artifact = buildArtifact(dataFile);

		assert.equal(parsed.length, base.length + 1);
		assert.equal(artifact.training.distillation?.teacherRecords, 1);
		assert.equal(artifact.training.distillation?.readyForLiveAuthority, true);
		assert.ok(artifact.training.distillation?.labelers.includes("teacher:claude-sonnet-4"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("teacher label import rejects mismatched tasks and unsupported labelers", () => {
	const base = buildConductorTrainingRecords();
	const fold = base.find((record): record is FoldPolicyTrainingRecord => record.task === "fold_policy");
	assert.ok(fold);
	const label = teacherFoldLabel(fold);

	assert.throws(
		() => parseConductorTeacherLabels(`${JSON.stringify({ ...label, labeler: "local-replay-rubric" })}\n`),
		/must use a teacher:\* labeler/,
	);
	assert.throws(
		() => importConductorTeacherLabels(base, [{ ...label, task: "compression" }]),
		/task compression does not match base task fold_policy/,
	);
	assert.throws(
		() => importConductorTeacherLabels(base, [{ ...label, target: { ...(label.target as any), keepScore: 2 } }]),
		/invalid fold keepScore/,
	);
});
