import assert from "node:assert/strict";
import { test } from "node:test";
import { auditConductorTrainingLabels } from "./audit-conductor-labels.ts";
import { buildConductorTrainingRecords, type FoldPolicyTrainingRecord } from "./conductor-training-data.ts";

test("label audit duplicate-labels the exported replay records with full self-agreement", () => {
	const records = buildConductorTrainingRecords();
	const report = auditConductorTrainingLabels(records, records);

	assert.equal(report.records, records.length);
	assert.equal(report.duplicateRecords, records.length);
	assert.equal(report.agreement, 1);
	assert.equal(report.disagreements.length, 0);
	assert.ok(report.byTask.budget_oracle.checked > 0);
	assert.ok(report.byTask.fold_policy.checked > 0);
	assert.ok(report.byTask.compression.checked > 0);
});

test("label audit reports rubric drift in task-level labels", () => {
	const canonical = buildConductorTrainingRecords();
	const exported = canonical.map((record) => structuredClone(record));
	const fold = exported.find((record): record is FoldPolicyTrainingRecord => record.task === "fold_policy");
	assert.ok(fold);
	fold.target.keepScore = 0.01;

	const report = auditConductorTrainingLabels(exported, canonical);

	assert.ok(report.agreement < 1);
	assert.equal(report.disagreements.length, 1);
	assert.equal(report.disagreements[0].task, "fold_policy");
	assert.equal(report.disagreements[0].reason, "label_mismatch");
});

test("label audit can allow appended teacher records without weakening baseline agreement", () => {
	const canonical = buildConductorTrainingRecords();
	const fold = canonical.find((record): record is FoldPolicyTrainingRecord => record.task === "fold_policy");
	assert.ok(fold);
	const teacher = {
		...structuredClone(fold),
		recordId: `${fold.recordId}:teacher:test`,
		labeler: "teacher:test",
		target: {
			...fold.target,
			keepScore: 0.95,
			rationale: "Teacher override appended to the baseline export.",
		},
	} satisfies FoldPolicyTrainingRecord;

	const strict = auditConductorTrainingLabels([...canonical, teacher], canonical);
	const allowed = auditConductorTrainingLabels([...canonical, teacher], canonical, {
		allowExtraTeacherRecords: true,
	});

	assert.equal(strict.disagreements.length, 1);
	assert.equal(strict.disagreements[0].reason, "unexpected_exported_record");
	assert.equal(allowed.agreement, 1);
	assert.equal(allowed.disagreements.length, 0);
	assert.equal(allowed.records, canonical.length + 1);
});
