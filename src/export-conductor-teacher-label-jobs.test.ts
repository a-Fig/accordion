import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildConductorTrainingRecords,
	type CompressionTrainingRecord,
	type FoldPolicyTrainingRecord,
} from "./conductor-training-data.ts";
import {
	buildConductorTeacherLabelJobs,
	serializeConductorTeacherLabelJobs,
} from "./export-conductor-teacher-label-jobs.ts";

test("teacher label jobs include import-compatible label templates", () => {
	const records = buildConductorTrainingRecords();
	const jobs = buildConductorTeacherLabelJobs(records, {
		tasks: ["fold_policy"],
		limit: 1,
		labeler: "teacher:claude-sonnet-4",
	});
	const [job] = jobs;

	assert.equal(jobs.length, 1);
	assert.equal(job.task, "fold_policy");
	assert.equal(job.requestedLabeler, "teacher:claude-sonnet-4");
	assert.equal(job.labelTemplate.version, 1);
	assert.equal(job.labelTemplate.recordId, job.recordId);
	assert.equal(job.labelTemplate.task, "fold_policy");
	assert.equal(job.labelTemplate.labeler, "teacher:claude-sonnet-4");
	assert.match(job.instructions.join("\n"), /positive-unlabeled/);
	assert.equal(typeof job.input.blockText, "string");
	assert.ok((job.input.blockText as string).length > 0);
});

test("teacher label jobs can target compression records with grounded digest schema", () => {
	const records = buildConductorTrainingRecords();
	const compression = records.find((record): record is CompressionTrainingRecord => record.task === "compression");
	assert.ok(compression);
	const [job] = buildConductorTeacherLabelJobs([compression], {
		tasks: ["compression"],
		labeler: "teacher:claude-sonnet-4",
	});

	assert.equal(job.task, "compression");
	assert.equal((job.outputSchema as any).mode, "teacher_textual_digest");
	assert.equal((job.labelTemplate.target as any).mode, "teacher_textual_digest");
	assert.equal(job.input.blockId, compression.blockId);
	assert.equal(job.input.blockHash, compression.blockHash);
	assert.ok((job.input.blockText as string).length > 0);
	assert.match(job.instructions.join("\n"), /grounded in blockText/);
});

test("teacher label job serialization is jsonl and respects task filters", () => {
	const records = buildConductorTrainingRecords();
	const fold = records.find((record): record is FoldPolicyTrainingRecord => record.task === "fold_policy");
	assert.ok(fold);
	const jobs = buildConductorTeacherLabelJobs(records, {
		tasks: ["budget_oracle"],
		limit: 2,
		labeler: "teacher:claude-sonnet-4",
	});
	const jsonl = serializeConductorTeacherLabelJobs(jobs);
	const parsed = jsonl.trim().split("\n").map((line) => JSON.parse(line));

	assert.equal(jobs.length, 2);
	assert.equal(parsed.length, 2);
	assert.ok(parsed.every((job) => job.task === "budget_oracle"));
	assert.ok(jsonl.endsWith("\n"));
});
