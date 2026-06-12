import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONDUCTOR_LABELING_RUBRIC_VERSION,
	buildConductorTrainingRecords,
	type CompressionTrainingRecord,
	type FoldPolicyTrainingRecord,
} from "./conductor-training-data.ts";
import {
	buildConductorTeacherLabelJobs,
	type ConductorTeacherLabelJob,
} from "./export-conductor-teacher-label-jobs.ts";
import {
	buildTeacherLabelMessages,
	parseTeacherLabelResponse,
	requestConductorTeacherLabels,
	teacherLabelerForModel,
	type FetchLike,
} from "./request-conductor-teacher-labels.ts";

function foldJob(): ConductorTeacherLabelJob {
	const records = buildConductorTrainingRecords();
	const fold = records.find((record): record is FoldPolicyTrainingRecord => record.task === "fold_policy");
	assert.ok(fold);
	return buildConductorTeacherLabelJobs([fold], {
		tasks: ["fold_policy"],
		labeler: "teacher:queued-export-labeler",
	})[0]!;
}

function compressionJob(): ConductorTeacherLabelJob {
	const records = buildConductorTrainingRecords();
	const compression = records.find((record): record is CompressionTrainingRecord => record.task === "compression");
	assert.ok(compression);
	return buildConductorTeacherLabelJobs([compression], {
		tasks: ["compression"],
		labeler: "teacher:queued-export-labeler",
	})[0]!;
}

test("teacher labeler provenance is derived from the runtime model name", () => {
	assert.equal(teacherLabelerForModel("openai/gpt-4.1"), "teacher:openai-gpt-4.1");
	assert.equal(teacherLabelerForModel(""), "teacher:model");
});

test("teacher label request sends rubric-bound chat request and validates the response", async () => {
	const job = foldJob();
	const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
	const fetchImpl: FetchLike = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url, body, headers: init.headers });
		const user = JSON.parse(body.messages[1].content);
		const label = {
			version: 1,
			recordId: user.recordId,
			task: "fold_policy",
			rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
			labeler: "teacher:gpt-4.1",
			target: {
				label: "positive",
				keepScore: 0.92,
				expectedReuseTurns: 0,
				level: 0,
				puWeight: 1,
				rationale: "The block carries an answer-bearing fact under the supplied rubric.",
			},
		};
		return {
			ok: true,
			status: 200,
			async text() {
				return JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify(label),
							},
						},
					],
				});
			},
		};
	};

	const { labels, report } = await requestConductorTeacherLabels([job], {
		apiKey: "test-key",
		model: "gpt-4.1",
		baseUrl: "https://example.test/v1",
		rubricText: "Frozen rubric body",
	}, fetchImpl);

	assert.equal(labels.length, 1);
	assert.equal(labels[0]!.labeler, "teacher:gpt-4.1");
	assert.equal(labels[0]!.recordId, job.recordId);
	assert.equal(report.labels, 1);
	assert.equal(report.labeler, "teacher:gpt-4.1");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "https://example.test/v1/chat/completions");
	assert.equal(calls[0]!.headers.authorization, "Bearer test-key");
	assert.equal(calls[0]!.body.model, "gpt-4.1");
	assert.equal(calls[0]!.body.response_format.type, "json_object");
	assert.equal(calls[0]!.body.messages[1].role, "user");
	const userPayload = JSON.parse(calls[0]!.body.messages[1].content);
	assert.equal(userPayload.rubricText, "Frozen rubric body");
	assert.equal(userPayload.requestedLabeler, "teacher:gpt-4.1");
	assert.equal(userPayload.labelTemplate.labeler, "teacher:gpt-4.1");
	assert.equal(userPayload.input.blockId, job.input.blockId);
});

test("teacher label parser rejects mismatched job identity", () => {
	const job = foldJob();
	const content = JSON.stringify({
		version: 1,
		recordId: "wrong-record",
		task: "fold_policy",
		rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
		labeler: job.requestedLabeler,
		target: {
			label: "positive",
			keepScore: 0.9,
			expectedReuseTurns: 0,
			level: 0,
			puWeight: 1,
			rationale: "Wrong identity should be rejected.",
		},
	});

	assert.throws(() => parseTeacherLabelResponse(job, content), /does not match job/);
});

test("teacher label request retries after malformed teacher JSON", async () => {
	const job = foldJob();
	let calls = 0;
	const fetchImpl: FetchLike = async (_url, init) => {
		calls++;
		const body = JSON.parse(init.body);
		const user = JSON.parse(body.messages[1].content);
		const content = calls === 1
			? "{version:1}"
			: JSON.stringify({
				version: 1,
				recordId: user.recordId,
				task: "fold_policy",
				rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
				labeler: "teacher:gpt-4.1",
				target: {
					label: "positive",
					keepScore: 0.9,
					expectedReuseTurns: 0,
					level: 0,
					puWeight: 1,
					rationale: "Second attempt returns valid JSON after repair feedback.",
				},
			});
		return {
			ok: true,
			status: 200,
			async text() {
				return JSON.stringify({
					choices: [
						{
							message: {
								content,
							},
						},
					],
				});
			},
		};
	};

	const { labels } = await requestConductorTeacherLabels([job], {
		apiKey: "test-key",
		model: "gpt-4.1",
		maxRetries: 1,
	}, fetchImpl);

	assert.equal(calls, 2);
	assert.equal(labels[0]!.target.rationale, "Second attempt returns valid JSON after repair feedback.");
});

test("teacher label parser requires grounded textual compression targets", () => {
	const job = compressionJob();
	const messages = buildTeacherLabelMessages(job, { rubricText: "Rubric" });
	const user = JSON.parse(messages[1].content);
	const content = JSON.stringify({
		version: 1,
		recordId: job.recordId,
		task: "compression",
		rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
		labeler: job.requestedLabeler,
		target: {
			mode: "deterministic_extract",
			digest: "Not acceptable as a teacher textual digest.",
			fidelityGate: true,
			fidelityLabels: {
				paths: [],
				commands: [],
				errors: [],
				exactValues: [],
				decisions: [],
			},
			rationale: "Wrong mode.",
		},
	});

	assert.equal(user.outputSchema.mode, "teacher_textual_digest");
	assert.throws(() => parseTeacherLabelResponse(job, content), /teacher_textual_digest mode/);
});
