import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CONDUCTOR_LABELING_RUBRIC_VERSION,
	buildConductorTrainingRecords,
	conductorTrainingDataHash,
	conductorTrainingVectors,
	parseConductorTrainingJsonl,
	serializeConductorTrainingRecords,
	type CompressionTrainingRecord,
} from "./conductor-training-data.ts";
import {
	FOLD_TARGET_INITIAL,
	FOLD_TARGET_MAX,
	contentHash,
	createAccordionState,
	createArtifactBudgetOracleProvider,
	createArtifactCompressionProvider,
	createArtifactConductorModelProviders,
	createLocalConductorModelProviders,
	deterministicDigest,
	extractConductorTraceLabels,
	mmrRedundancyPenalty,
	parseMessages,
	parseConductorModelArtifact,
	reuseDistanceToFoldLevel,
	runConductor,
	textHash,
	warmConductorModel,
	type AgentMessage,
	type BudgetOracleRequest,
	type ConductorModelArtifact,
	type ConductorModelAuthority,
	type FoldLevel,
} from "./conductor.ts";
import { buildArtifact } from "./train-conductor-model.ts";
import { buildMiniLmPolicyArtifact } from "./train-conductor-minilm-policy.ts";
import { buildTextualCompressorArtifact } from "./train-conductor-textual-compressor.ts";

const txt = (text: string) => ({ type: "text", text });
const user = (id: string, text: string): AgentMessage => ({ id, role: "user", content: [txt(text)] });
const assistant = (id: string, text: string): AgentMessage => ({ id, role: "assistant", content: [txt(text)] });

function big(label: string, words = 260): string {
	return Array.from({ length: words }, (_, i) => `${label}_${i}`).join(" ");
}

function textOf(messages: AgentMessage[]): string {
	return messages
		.map((message: any) =>
			typeof message.content === "string"
				? message.content
				: (message.content ?? []).map((part: any) => part.text ?? part.thinking ?? "").join("\n"),
		)
		.join("\n");
}

function pressureFixture() {
	const messages: AgentMessage[] = [
		user("u1", "Record the cache plan."),
		assistant("a1", `Important cache plan lives in src/cache.ts.\n${big("keep_block")}`),
		user("u2", "Record filler."),
		assistant("a2", `Disposable filler notes.\n${big("fold_block")}`),
		user("u3", "continue"),
	];
	const parsed = parseMessages(messages);
	const keep = parsed.blocks.find((block) => block.text.includes("src/cache.ts"));
	const filler = parsed.blocks.find((block) => block.text.includes("Disposable filler"));
	assert.ok(keep);
	assert.ok(filler);
	return { messages, parsed, keep, filler };
}

function runPressure(messages: AgentMessage[], state: ReturnType<typeof createAccordionState>, deps = {}, budgetTokens = 520) {
	return runConductor(
		{
			messages,
			incomingPrompt: "continue",
			lastCompletedTurn: null,
			budgetTokens,
			workingTailTokens: 0,
			state,
		},
		deps,
	);
}

function authorityFixture(mode: "shadow_only" | "cost_guarded" | "live"): ConductorModelAuthority {
	return {
		version: 1,
		generatedAt: "2026-06-12T00:00:00.000Z",
		artifact: "fixture.json",
		evidence: {},
		authority: {
			budgetOracle: { mode, maxTargetMultiplier: 1 },
			foldPolicy: { mode: "shadow_only" },
			compression: { mode: "digest_only" },
		},
	};
}

function permissiveArtifactFixture(): ConductorModelArtifact {
	return {
		version: 1,
		createdAt: "2026-06-12T00:00:00.000Z",
		source: "authority-test",
		training: {
			examples: 1,
			oracleExamples: 1,
			foldPolicyExamples: 1,
			datasetHash: "fixture",
			rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
		},
		budgetOracle: { intercept: 1.4, weights: {}, confidence: 1, min: 0.5, max: 2 },
		foldPolicy: { intercept: 0, weights: {}, confidence: 1, reuseHorizonTurns: 12 },
		compression: { mode: "deterministic_extract", confidence: 1, fidelityGate: true },
	};
}

const budgetRequestFixture: BudgetOracleRequest = {
	prompt: "continue",
	promptHash: "prompt",
	currentTurn: 1,
	calibratedTarget: 0.8,
	stats: {
		blockCount: 2,
		turnCount: 1,
		totalTokens: 500,
		maxBlockTokens: 300,
		kindCounts: { user: 1, text: 1, thinking: 0, tool_call: 0, tool_result: 0 },
	},
};

test("shadow fold policy is invoked and logged but does not alter live decisions", async () => {
	const { messages, parsed } = pressureFixture();
	const baseline = runPressure(messages, createAccordionState());
	const state = createAccordionState();
	let providerCalls = 0;

	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages, state },
		{
			shadowMode: true,
			foldPolicyProvider: async (request) => {
				providerCalls++;
				return {
					predictions: request.items.map((item) => ({
						value: {
							blockId: item.block.id,
							blockHash: item.blockHash,
							expectedReuseTurns: 0,
							keepScore: 1,
							level: 0,
						},
						confidence: 1,
					})),
				};
			},
		},
	);
	const shadow = runPressure(messages, state, { shadowMode: true });

	assert.equal(providerCalls, 1);
	assert.deepEqual(
		shadow.decisions.map((decision) => [decision.blockId, decision.action, decision.level]),
		baseline.decisions.map((decision) => [decision.blockId, decision.action, decision.level]),
	);
	assert.ok(state.model.shadowTraces.some((trace) => trace.kind === "fold_policy" && trace.modelDecision));
});

test("trace extraction emits manual, decision, NIAH, and compact labels", () => {
	const state = createAccordionState({
		manualChanges: [
			{ blockId: "b1", action: "fold", actor: "conductor", turn: 2 },
			{ blockId: "b1", action: "unfold", actor: "agent", turn: 5 },
		],
	});
	const labels = extractConductorTraceLabels({
		state,
		decisions: [{
			blockId: "b2",
			action: "fold",
			actor: "conductor",
			reason: ["budget_pressure", "not_pinned"],
			turn: 3,
			kind: "text",
			level: 2,
		}],
		niahNeedles: [{ blockId: "needle-block", turn: 4, needle: "CANARY-NEEDLE" }],
		compactSweeps: [{
			scenario: "semantic-preference-late",
			budgetTokens: 1500,
			accordionScore: 100,
			compactScore: 40,
			tokenSpend: 1000,
			cacheHitRate: 0.8,
		}],
	});

	assert.equal(labels.manualChanges[1].reuseDistanceTurns, 3);
	assert.deepEqual(labels.foldDecisions[0].reason, ["budget_pressure", "not_pinned"]);
	assert.equal(labels.niahHoldouts[0].shouldKeep, true);
	assert.equal(labels.compactSweeps[0].jointScore, 0.08);
});

test("local conductor model providers generate shadow traces without external weights", async () => {
	const { messages, parsed } = pressureFixture();
	const state = createAccordionState();
	const emitted: unknown[] = [];

	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages, state },
		{
			...createLocalConductorModelProviders(),
			shadowMode: true,
			onShadowTrace: (trace) => emitted.push(trace),
		},
	);
	runPressure(messages, state, { shadowMode: true });

	assert.ok(state.model.budgetOracle);
	assert.ok(Object.keys(state.model.foldPolicyCache).length > 0);
	assert.ok(Object.keys(state.model.compressionCache).length > 0);
	assert.ok(state.model.shadowTraces.some((trace) => trace.kind === "budget_oracle"));
	assert.ok(state.model.shadowTraces.some((trace) => trace.kind === "fold_policy"));
	assert.ok(state.model.shadowTraces.some((trace) => trace.kind === "compression"));
	assert.ok(emitted.length >= 3);
});

test("artifact conductor model providers load trained JSON and warm all caches", async () => {
	const { messages, parsed } = pressureFixture();
	const artifact = parseConductorModelArtifact(readFileSync("models/conductor-local-v1.json", "utf8"));
	const state = createAccordionState();

	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages, state },
		{ ...createArtifactConductorModelProviders(artifact), shadowMode: false },
	);

	assert.equal(artifact.version, 1);
	assert.ok(artifact.training.foldPolicyExamples > 0);
	assert.equal(artifact.training.rubricVersion, CONDUCTOR_LABELING_RUBRIC_VERSION);
	assert.ok(artifact.training.datasetHash);
	assert.ok(state.model.budgetOracle?.reason?.includes("artifact:"));
	assert.ok(Object.keys(state.model.foldPolicyCache).length > 0);
	assert.ok(Object.keys(state.model.compressionCache).length > 0);
});

test("artifact budget authority is enforced at provider boundary", async () => {
	const artifact = permissiveArtifactFixture();
	const shadow = await createArtifactBudgetOracleProvider(artifact, authorityFixture("shadow_only"))(budgetRequestFixture);
	const guarded = await createArtifactBudgetOracleProvider(artifact, authorityFixture("cost_guarded"))(budgetRequestFixture);
	const live = await createArtifactBudgetOracleProvider(artifact, authorityFixture("live"))(budgetRequestFixture);

	assert.equal(shadow.value.targetMultiplier, 1);
	assert.equal(guarded.value.targetMultiplier, 1);
	assert.equal(live.value.targetMultiplier, 1.4);
	assert.equal(shadow.authority, "shadow_only");
	assert.equal(guarded.authority, "cost_guarded");
	assert.equal(live.authority, "live");
});

test("training data export emits versioned PU labels and compression records", () => {
	const records = buildConductorTrainingRecords();
	const jsonl = serializeConductorTrainingRecords(records);
	const parsed = parseConductorTrainingJsonl(jsonl);
	const vectors = conductorTrainingVectors(parsed);
	const positive = parsed.find((record: any) => record.task === "fold_policy" && record.target.label === "positive") as any;
	const unlabeled = parsed.find((record: any) => record.task === "fold_policy" && record.target.label === "unlabeled") as any;
	const compression = parsed.find((record) => record.task === "compression") as any;

	assert.equal(parsed.length, records.length);
	assert.ok(parsed.every((record) => record.rubricVersion === CONDUCTOR_LABELING_RUBRIC_VERSION));
	assert.ok(positive);
	assert.ok(unlabeled);
	assert.ok(positive.target.keepScore > unlabeled.target.keepScore);
	assert.equal(positive.target.level, 2);
	assert.ok(unlabeled.target.puWeight < 1);
	assert.ok(compression.target.digest.length > 0);
	assert.equal(compression.target.fidelityGate, true);
	assert.ok(vectors.oracleExamples.length > 0);
	assert.ok(vectors.policyExamples.length > 0);
	assert.ok(vectors.compressionExamples > 0);
	assert.equal(conductorTrainingDataHash(jsonl).length, 64);
});

test("trainer consumes exported labels and records dataset provenance", () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-conductor-data-"));
	try {
		const dataFile = join(dir, "labels.jsonl");
		const jsonl = serializeConductorTrainingRecords(buildConductorTrainingRecords());
		writeFileSync(dataFile, jsonl);
		const artifact = buildArtifact(dataFile);

		assert.equal(artifact.training.rubricVersion, CONDUCTOR_LABELING_RUBRIC_VERSION);
		assert.equal(artifact.training.datasetSource, dataFile);
		assert.equal(artifact.training.datasetHash, conductorTrainingDataHash(jsonl));
		assert.equal(artifact.training.datasetRecords, parseConductorTrainingJsonl(jsonl).length);
		assert.equal(artifact.foldPolicy.architecture, "linear_replay");
		assert.equal(artifact.training.distillation?.teacherRecords, 0);
		assert.equal(artifact.training.distillation?.readyForLiveAuthority, false);
		assert.ok(artifact.training.distillation?.missing.includes("teacher_labels"));
		assert.ok((artifact.training.compressionExamples ?? 0) > 0);
		assert.ok(artifact.training.examples > 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("trainer preserves teacher-distillation provenance when teacher labels are present", () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-teacher-data-"));
	try {
		const dataFile = join(dir, "teacher-labels.jsonl");
		const records = buildConductorTrainingRecords().map((record, index) =>
			index < 3 ? { ...record, labeler: "teacher:claude-sonnet-4" as const } : record,
		);
		const jsonl = serializeConductorTrainingRecords(records);
		writeFileSync(dataFile, jsonl);
		const artifact = buildArtifact(dataFile);

		assert.equal(artifact.training.distillation?.teacherRecords, 3);
		assert.equal(artifact.training.distillation?.readyForLiveAuthority, true);
		assert.deepEqual(artifact.training.distillation?.missing, []);
		assert.ok(artifact.training.distillation?.labelers.includes("teacher:claude-sonnet-4"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("MiniLM fold-policy artifact requires teacher labels and declares encoder metadata", () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-minilm-policy-"));
	try {
		const noTeacherFile = join(dir, "local.jsonl");
		const localJsonl = serializeConductorTrainingRecords(buildConductorTrainingRecords());
		writeFileSync(noTeacherFile, localJsonl);
		assert.throws(
			() => buildMiniLmPolicyArtifact({ dataFile: noTeacherFile }),
			/Teacher records 0 < required 1/,
		);

		const teacherFile = join(dir, "teacher.jsonl");
		const records = buildConductorTrainingRecords().map((record, index) =>
			index < 3 ? { ...record, labeler: "teacher:claude-sonnet-4" as const } : record,
		);
		writeFileSync(teacherFile, serializeConductorTrainingRecords(records));
		const artifact = buildMiniLmPolicyArtifact({ dataFile: teacherFile });
		const parsed = parseConductorModelArtifact(JSON.stringify(artifact));

		assert.equal(parsed.foldPolicy.architecture, "minilm_cross_encoder_distilled");
		assert.equal(parsed.foldPolicy.encoder?.modelFamily, "MiniLM");
		assert.match(parsed.foldPolicy.encoder?.modelId ?? "", /MiniLM/i);
		assert.ok(parsed.foldPolicy.encoder?.pairTemplate.includes("{prompt}"));
		assert.ok(parsed.foldPolicy.encoder?.pairTemplate.includes("{block}"));
		assert.equal(parsed.foldPolicy.crossEncoderHead?.type, "hashed_pair_regressor");
		assert.equal(parsed.foldPolicy.crossEncoderHead?.teacherPairs, 1);
		assert.equal(parsed.foldPolicy.crossEncoderHead?.weights.length, parsed.foldPolicy.crossEncoderHead?.featureDimension);
		assert.equal(parsed.foldPolicy.distillation?.teacherRecords, 1);
		assert.ok((parsed.foldPolicy.distillation?.trainingPairs ?? 0) > 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("MiniLM fold-policy artifact provider uses the runnable cross-encoder head", async () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-minilm-provider-"));
	try {
		const dataFile = join(dir, "teacher.jsonl");
		const records = buildConductorTrainingRecords().map((record, index) =>
			index < 3 ? { ...record, labeler: "teacher:claude-sonnet-4" as const } : record,
		);
		writeFileSync(dataFile, serializeConductorTrainingRecords(records));
		const artifact = buildMiniLmPolicyArtifact({ dataFile });
		const { messages, parsed } = pressureFixture();
		const state = createAccordionState();

		await warmConductorModel(
			{ blocks: parsed.blocks, prompt: "Where is the cache plan?", messages, state },
			{ ...createArtifactConductorModelProviders(artifact), shadowMode: true },
		);

		const predictions = Object.values(state.model.foldPolicyCache);
		assert.ok(predictions.length > 0);
		assert.ok(predictions.every((prediction) => prediction.reason?.includes(":cross_encoder_head")));
		assert.ok(predictions.every((prediction) => Number.isFinite(prediction.value.keepScore)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("textual compressor artifact requires teacher compression labels and declares digest table", () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-textual-compressor-"));
	try {
		const localFile = join(dir, "local.jsonl");
		writeFileSync(localFile, serializeConductorTrainingRecords(buildConductorTrainingRecords()));
		assert.throws(
			() => buildTextualCompressorArtifact({ dataFile: localFile }),
			/Teacher compression records 0 < required 1/,
		);

		const base = buildConductorTrainingRecords();
		const compression = base.find((record): record is CompressionTrainingRecord => record.task === "compression");
		assert.ok(compression);
		const teacherCompression: CompressionTrainingRecord = {
			...compression,
			recordId: `${compression.recordId}:teacher:test`,
			labeler: "teacher:claude-sonnet-4",
			target: {
				...compression.target,
				mode: "teacher_textual_digest",
				digest: compression.target.digest,
				rationale: "Teacher accepted this grounded textual digest under the frozen rubric.",
			},
		};
		const teacherFile = join(dir, "teacher-compression.jsonl");
		writeFileSync(teacherFile, serializeConductorTrainingRecords([...base, teacherCompression]));
		const artifact = buildTextualCompressorArtifact({ dataFile: teacherFile });
		const parsed = parseConductorModelArtifact(JSON.stringify(artifact));

		assert.equal(parsed.compression.mode, "teacher_textual_digest_table");
		assert.equal(parsed.compression.baseModel?.modelFamily, "Qwen2.5");
		assert.equal(parsed.compression.adapter?.type, "digest_table");
		assert.equal(parsed.compression.distillation?.compressionRecords, 1);
		assert.ok(parsed.compression.promptTemplate?.includes("{block}"));
		assert.ok(parsed.compression.digestTable?.[compression.contentHash]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("textual compressor artifact provider uses teacher digest table with deterministic fallback", async () => {
	const { parsed, keep, filler } = pressureFixture();
	const teacherDigest = "Teacher digest: cache plan remains in src/cache.ts.";
	const artifact: ConductorModelArtifact = {
		...permissiveArtifactFixture(),
		source: "textual-compressor-test",
		compression: {
			mode: "teacher_textual_digest_table",
			confidence: 1,
			fidelityGate: true,
			baseModel: { modelFamily: "Qwen2.5", modelId: "Qwen/Qwen2.5-0.5B-Instruct" },
			adapter: { type: "digest_table" },
			promptTemplate: "Digest block: {block}",
			distillation: { teacherRecords: 1, compressionRecords: 1, source: "test" },
			digestTable: {
				[contentHash(keep)]: {
					digest: teacherDigest,
					labeler: "teacher:claude-sonnet-4",
					fidelityLabels: {
						paths: ["src/cache.ts"],
						commands: [],
						errors: [],
						exactValues: [],
						decisions: [],
					},
				},
			},
		},
	};
	const provider = createArtifactCompressionProvider(parseConductorModelArtifact(JSON.stringify(artifact)));
	const hit = await provider({
		block: keep,
		hash: contentHash(keep),
		deterministicDigest: deterministicDigest(keep),
	});
	const fallback = await provider({
		block: filler,
		hash: contentHash(filler),
		deterministicDigest: deterministicDigest(filler),
	});

	assert.equal(parsed.blocks.includes(keep), true);
	assert.equal(hit.value.digest, teacherDigest);
	assert.match(hit.reason ?? "", /teacher_digest/);
	assert.equal(fallback.value.digest, deterministicDigest(filler));
	assert.match(fallback.reason ?? "", /deterministic_fallback/);
});

test("artifact model warm-up stays inside the CPU latency envelope for 300 blocks", async () => {
	const artifact = parseConductorModelArtifact(readFileSync("models/conductor-local-v1.json", "utf8"));
	const messages: AgentMessage[] = [user("u-start", "Begin the latency fixture.")];
	for (let i = 0; i < 150; i++) {
		messages.push(assistant(`a-${i}`, `Latency fixture block ${i} uses src/file-${i}.ts.\n${big(`latency_${i}`, 20)}`));
		messages.push(user(`u-${i}`, `Continue latency fixture ${i}.`));
	}
	const parsed = parseMessages(messages);
	const state = createAccordionState();
	const deps = { ...createArtifactConductorModelProviders(artifact), shadowMode: false };

	const warmStart = performance.now();
	await warmConductorModel({ blocks: parsed.blocks, prompt: "continue latency fixture", messages, state }, deps);
	const warmMs = performance.now() - warmStart;
	const runStart = performance.now();
	runConductor({
		messages,
		incomingPrompt: "continue latency fixture",
		lastCompletedTurn: null,
		budgetTokens: 2_000,
		workingTailTokens: 0,
		state,
	}, deps);
	const runMs = performance.now() - runStart;

	assert.ok(parsed.blocks.length >= 300);
	assert.ok(warmMs < 500, `warmConductorModel took ${warmMs.toFixed(1)}ms`);
	assert.ok(runMs < 200, `runConductor full run+assembly took ${runMs.toFixed(1)}ms`);
});

test("model state and salience metadata survive JSON restoration", async () => {
	const { messages, parsed } = pressureFixture();
	const state = createAccordionState();
	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages, state },
		{ ...createLocalConductorModelProviders(), shadowMode: true },
	);
	state.salienceMetadata.seed = {
		paths: ["src/model.ts"],
		commands: [],
		errors: [],
		exact_values: [],
		decisions: [],
		sourceHash: "seed",
	};
	const restored = createAccordionState(JSON.parse(JSON.stringify(state)));

	assert.deepEqual(Object.keys(restored.model.foldPolicyCache), Object.keys(state.model.foldPolicyCache));
	assert.equal(restored.model.shadowTraces.length, state.model.shadowTraces.length);
	assert.deepEqual(Object.keys(restored.salienceMetadata), Object.keys(state.salienceMetadata));
});

test("budget oracle applies a clamped target multiplier only with confident live authority", async () => {
	const { messages, parsed } = pressureFixture();
	const state = createAccordionState();

	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages, state },
		{
			budgetOracle: async () => ({
				value: { targetMultiplier: 2 },
				confidence: 1,
			}),
		},
	);
	const output = runPressure(messages, state, {}, 1_500);

	assert.equal(output.foldTarget, FOLD_TARGET_MAX);
});

test("budget oracle falls back on low confidence and in shadow mode", async () => {
	const { messages, parsed } = pressureFixture();
	const lowConfidence = createAccordionState();
	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages, state: lowConfidence },
		{ budgetOracle: async () => ({ value: { targetMultiplier: 2 }, confidence: 0.1 }) },
	);
	assert.equal(runPressure(messages, lowConfidence).foldTarget, FOLD_TARGET_INITIAL);

	const shadowState = createAccordionState();
	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages, state: shadowState },
		{ shadowMode: true, budgetOracle: async () => ({ value: { targetMultiplier: 2 }, confidence: 1 }) },
	);
	assert.equal(runPressure(messages, shadowState, { shadowMode: true }).foldTarget, FOLD_TARGET_INITIAL);
	assert.ok(shadowState.model.shadowTraces.some((trace) => trace.kind === "budget_oracle"));
});

test("fold policy cache can keep an imminent block while folding colder redundant material", async () => {
	const { messages, parsed, keep, filler } = pressureFixture();
	const state = createAccordionState();

	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages, state },
		{
			foldPolicyProvider: async (request) => ({
				predictions: request.items.map((item) => {
					const shouldKeep = item.block.id === keep.id;
					return {
						value: {
							blockId: item.block.id,
							blockHash: item.blockHash,
							expectedReuseTurns: shouldKeep ? 0 : 12,
							keepScore: shouldKeep ? 1 : 0,
							level: shouldKeep ? 0 : 2,
						},
						confidence: 1,
					};
				}),
			}),
		},
	);
	const output = runPressure(messages, state, {}, 1_500);
	const keepDecision = output.decisions.find((decision) => decision.blockId === keep.id);
	const fillerDecision = output.decisions.find((decision) => decision.blockId === filler.id);

	assert.equal(keepDecision, undefined);
	assert.equal(fillerDecision?.action, "fold");
	assert.equal(fillerDecision?.level, 2);
});

test("fold policy warm-up caches by block hash and ignores low-confidence authority", async () => {
	const { messages, parsed } = pressureFixture();
	const state = createAccordionState();
	let calls = 0;
	const provider = async (request: any) => {
		calls++;
		return {
			predictions: request.items.map((item: any) => ({
				value: {
					blockId: item.block.id,
					blockHash: item.blockHash,
					expectedReuseTurns: 0,
					keepScore: 1,
					level: 0,
				},
				confidence: 0.1,
			})),
		};
	};

	await warmConductorModel({ blocks: parsed.blocks, prompt: "continue", messages, state }, { foldPolicyProvider: provider });
	await warmConductorModel({ blocks: parsed.blocks, prompt: "continue", messages, state }, { foldPolicyProvider: provider });
	const lowConfidence = runPressure(messages, state, {}, 1_500);
	const baseline = runPressure(messages, createAccordionState(), {}, 1_500);

	assert.equal(calls, 1);
	assert.deepEqual(
		lowConfidence.decisions.map((decision) => [decision.blockId, decision.action, decision.level]),
		baseline.decisions.map((decision) => [decision.blockId, decision.action, decision.level]),
	);
});

test("fold policy features include agent attention from recent assistant references", async () => {
	const { messages, parsed, keep } = pressureFixture();
	const state = createAccordionState();
	const referencedMessages = [
		...messages.slice(0, -1),
		assistant("a-recent", "I will keep using src/cache.ts in the next step."),
		messages[messages.length - 1],
	];
	let attention = 0;

	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages: referencedMessages, state },
		{
			foldPolicyProvider: async (request) => {
				const item = request.items.find((candidate) => candidate.block.id === keep.id);
				attention = item?.features.agentAttention ?? 0;
				return {
					predictions: request.items.map((candidate) => ({
						value: {
							blockId: candidate.block.id,
							blockHash: candidate.blockHash,
							expectedReuseTurns: 5,
							level: 2,
						},
						confidence: 1,
					})),
				};
			},
		},
	);

	assert.equal(attention, 1);
});

test("MMR redundancy penalty uses existing embedding vectors", () => {
	assert.equal(mmrRedundancyPenalty([1, 0], [[1, 0]]), 0.15);
	assert.equal(mmrRedundancyPenalty([1, 0], [[0, 1]]), 0);
});

test("reuse-distance policy maps directly to graduated fold levels", () => {
	const cases: Array<[number, FoldLevel]> = [
		[0, 0],
		[1, 0],
		[2, 1],
		[6, 2],
		[20, 3],
	];
	for (const [distance, level] of cases) {
		assert.equal(reuseDistanceToFoldLevel(distance), level);
	}
});

test("compression provider uses accepted grounded digests from cache", async () => {
	const sourceText = `We chose src/cache.ts and command npm run build for validation.\n${big("compression_source", 220)}`;
	const messages = [user("u1", "remember validation"), assistant("a1", sourceText), user("u2", "continue")];
	const parsed = parseMessages(messages);
	const target = parsed.blocks.find((block) => block.text.includes("src/cache.ts"));
	assert.ok(target);
	const state = createAccordionState({ foldedBlockIds: [target.id], foldLevels: { [target.id]: 2 } });
	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages, state },
		{
			compressionProvider: async ({ hash }) => ({
				value: {
					digest: "Grounded digest: src/cache.ts uses npm run build.",
					salience: { paths: ["src/cache.ts"], commands: ["npm run build"] },
				},
				confidence: 1,
				reason: hash,
			}),
		},
	);

	const output = runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: 180,
		workingTailTokens: 0,
		state,
	});

	assert.ok(textOf(output.messages).includes("Grounded digest: src/cache.ts uses npm run build."));
	assert.equal(state.model.compressionCache[contentHash(target)].accepted, true);
	assert.ok(state.salienceMetadata[contentHash(target)].paths.includes("src/cache.ts"));
});

test("compression provider rejects ungrounded digests and falls back deterministically", async () => {
	const sourceText = `We chose src/cache.ts for validation.\n${big("compression_source", 220)}`;
	const messages = [
		user("u1", "remember validation"),
		assistant("a1", sourceText),
		user("u2", "continue"),
	];
	const parsed = parseMessages(messages);
	const target = parsed.blocks.find((block) => block.text.includes("src/cache.ts"));
	assert.ok(target);
	const state = createAccordionState({ foldedBlockIds: [target.id], foldLevels: { [target.id]: 2 } });

	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages, state },
		{
			compressionProvider: async () => ({
				value: {
					digest: "Hallucinated digest: src/made-up.ts",
					salience: { paths: ["src/made-up.ts"] },
				},
				confidence: 1,
			}),
		},
	);
	const output = runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: 180,
		workingTailTokens: 0,
		state,
	});

	assert.equal(state.model.compressionCache[contentHash(target)].accepted, false);
	assert.equal(textOf(output.messages).includes("src/made-up.ts"), false);
	assert.ok(textOf(output.messages).includes(deterministicDigest(target)));
});

test("shadow compression logs but does not change assembled digests", async () => {
	const sourceText = `We chose src/cache.ts for validation.\n${big("compression_source", 220)}`;
	const messages = [
		user("u1", "remember validation"),
		assistant("a1", sourceText),
		user("u2", "continue"),
	];
	const parsed = parseMessages(messages);
	const target = parsed.blocks.find((block) => block.text.includes("src/cache.ts"));
	assert.ok(target);
	const state = createAccordionState({ foldedBlockIds: [target.id], foldLevels: { [target.id]: 2 } });

	await warmConductorModel(
		{ blocks: parsed.blocks, prompt: "continue", messages, state },
		{
			shadowMode: true,
			compressionProvider: async () => ({
				value: { digest: "Grounded shadow digest: src/cache.ts" },
				confidence: 1,
			}),
		},
	);
	const output = runConductor(
		{
			messages,
			incomingPrompt: "continue",
			lastCompletedTurn: null,
			budgetTokens: 180,
			workingTailTokens: 0,
			state,
		},
		{ shadowMode: true },
	);

	assert.equal(textOf(output.messages).includes("Grounded shadow digest"), false);
	assert.ok(textOf(output.messages).includes(deterministicDigest(target)));
	assert.ok(state.model.shadowTraces.some((trace) => trace.kind === "compression"));
	assert.equal(textHash(target.text), state.salienceMetadata[contentHash(target)].sourceHash);
});

test("group folding preserves the union of structured salience metadata", () => {
	const messages: AgentMessage[] = [user("u1", "record grouped facts")];
	for (let i = 0; i < 4; i++) {
		messages.push(assistant(`a${i + 1}`, `Grouped fact ${i} for src/member-${i}.ts.\n${big(`group_member_${i}`, 260)}`));
	}
	messages.push(user("u-last", "continue"));
	const parsed = parseMessages(messages);
	const state = createAccordionState();
	const member = parsed.blocks.find((block) => block.text.includes("src/member-2.ts"));
	assert.ok(member);
	state.salienceMetadata[contentHash(member)] = {
		paths: ["src/member-2.ts"],
		commands: ["npm run member-two"],
		errors: [],
		exact_values: [],
		decisions: [],
		sourceHash: textHash(member.text),
	};

	const output = runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: 80,
		workingTailTokens: 0,
		state,
	});
	const assembled = textOf(output.messages);

	assert.ok(assembled.includes("group"));
	assert.ok(assembled.includes("npm run member-two"));
});
