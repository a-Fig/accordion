import { createHash } from "node:crypto";
import {
	FOLD_RANK,
	deterministicDigest,
	keywordOverlap,
	parseMessages,
	textHash,
	type AgentMessage,
	type BlockKind,
	type ContextBlock,
	type FoldLevel,
	type FoldPolicyFeatures,
} from "./conductor.ts";
import { buildScenarios } from "./compare-compact.ts";

export const CONDUCTOR_LABELING_RUBRIC_VERSION = "conductor-labeling-rubric-v1";
export const DEFAULT_CONDUCTOR_TRAINING_DATA = "data/conductor-training-v0.jsonl";
export const CONDUCTOR_RUBRIC_PATH = "docs/CONDUCTOR_MODEL_LABELING_RUBRIC.md";

export type ConductorTrainingTask = "budget_oracle" | "fold_policy" | "compression";
export type ConductorTrainingSplit = "train" | "holdout";
export type FoldLabelKind = "positive" | "unlabeled";
export type ConductorLabeler = "local-replay-rubric" | `teacher:${string}`;

export interface ConductorTrainingRecordBase {
	version: 1;
	recordId: string;
	task: ConductorTrainingTask;
	rubricVersion: string;
	rubricPath: string;
	source: "compare-compact-replay";
	split: ConductorTrainingSplit;
	scenario: string;
	category: "exact" | "semantic";
	probe: string;
	labeler: ConductorLabeler;
}

export interface BudgetOracleTrainingRecord extends ConductorTrainingRecordBase {
	task: "budget_oracle";
	features: Record<string, number>;
	target: {
		targetMultiplier: number;
		weight: number;
		rationale: string;
	};
}

export interface FoldPolicyTrainingRecord extends ConductorTrainingRecordBase {
	task: "fold_policy";
	blockId: string;
	blockHash: string;
	contentHash: string;
	turn: number;
	kind: BlockKind;
	features: Record<string, number>;
	target: {
		label: FoldLabelKind;
		keepScore: number;
		expectedReuseTurns: number;
		level: FoldLevel;
		puWeight: number;
		rationale: string;
	};
}

export interface CompressionTrainingRecord extends ConductorTrainingRecordBase {
	task: "compression";
	blockId: string;
	blockHash: string;
	contentHash: string;
	turn: number;
	kind: BlockKind;
	target: {
		mode: "deterministic_extract" | "teacher_textual_digest";
		digest: string;
		fidelityGate: true;
		fidelityLabels: {
			paths: string[];
			commands: string[];
			errors: string[];
			exactValues: string[];
			decisions: string[];
		};
		rationale: string;
	};
}

export type ConductorTrainingRecord =
	| BudgetOracleTrainingRecord
	| FoldPolicyTrainingRecord
	| CompressionTrainingRecord;

export interface VectorExample {
	features: Record<string, number>;
	target: number;
	weight?: number;
}

export interface ConductorTrainingVectors {
	oracleExamples: VectorExample[];
	policyExamples: VectorExample[];
	compressionExamples: number;
	holdoutExamples: number;
	teacherRecords: number;
	localRecords: number;
	labelers: string[];
	totalRecords: number;
}

type Scenario = ReturnType<typeof buildScenarios>[number];

export function hasRecallRisk(prompt: string): boolean {
	return (
		/`[^`]+`/.test(prompt) ||
		/\b(?:exact|command|path|file|error|decision|which|what did|who owns|preferred|liked)\b/i.test(prompt)
	) ? true : false;
}

export function budgetFeatures(messages: AgentMessage[], prompt: string): Record<string, number> {
	const parsed = parseMessages(messages);
	const kindCounts = { tool_call: 0, tool_result: 0 };
	let totalTokens = 0;
	let maxBlockTokens = 0;
	for (const block of parsed.blocks) {
		if (block.kind === "tool_call") kindCounts.tool_call++;
		if (block.kind === "tool_result") kindCounts.tool_result++;
		totalTokens += block.tokens;
		maxBlockTokens = Math.max(maxBlockTokens, block.tokens);
	}
	return {
		prompt_risk: hasRecallRisk(prompt) ? 1 : 0,
		log_blocks: Math.log1p(parsed.blocks.length),
		log_turns: Math.log1p(parsed.turns.length),
		log_total_tokens: Math.log1p(totalTokens),
		log_max_block_tokens: Math.log1p(maxBlockTokens),
		tool_ratio: parsed.blocks.length > 0 ? (kindCounts.tool_call + kindCounts.tool_result) / parsed.blocks.length : 0,
	};
}

export function foldFeatures(input: FoldPolicyFeatures): Record<string, number> {
	return {
		kind_rank: input.kindRank,
		keyword_overlap: input.keywordOverlap,
		recency: input.recency,
		log_tokens: Math.log1p(input.tokenCount),
		agent_attention: input.agentAttention,
		recent_unfold: input.wasRecentlyUnfolded ? 1 : 0,
	};
}

export function buildConductorTrainingRecords(scenarios = buildScenarios()): ConductorTrainingRecord[] {
	const records: ConductorTrainingRecord[] = [];
	for (const scenario of scenarios) {
		const split = scenarioSplit(scenario);
		records.push(buildBudgetRecord(scenario, split));
		const parsed = parseMessages(scenario.messages);
		const currentTurn = Math.max(1, ...parsed.blocks.map((block) => block.turn));
		const keys = scenarioKeys(scenario);
		for (const block of parsed.blocks) {
			records.push(buildFoldPolicyRecord(scenario, block, currentTurn, keys, split));
			records.push(buildCompressionRecord(scenario, block, split));
		}
	}
	return records;
}

export function serializeConductorTrainingRecords(records: ConductorTrainingRecord[]): string {
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function parseConductorTrainingJsonl(input: string): ConductorTrainingRecord[] {
	const records: ConductorTrainingRecord[] = [];
	for (const [index, line] of input.split(/\r?\n/).entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const value = JSON.parse(trimmed) as ConductorTrainingRecord;
		validateConductorTrainingRecord(value, index + 1);
		records.push(value);
	}
	return records;
}

export function conductorTrainingVectors(records: ConductorTrainingRecord[]): ConductorTrainingVectors {
	const trainRecords = records.filter((record) => record.split === "train");
	const oracleExamples = trainRecords
		.filter((record): record is BudgetOracleTrainingRecord => record.task === "budget_oracle")
		.map((record) => ({
			features: record.features,
			target: record.target.targetMultiplier,
			weight: record.target.weight,
		}));
	const policyExamples = trainRecords
		.filter((record): record is FoldPolicyTrainingRecord => record.task === "fold_policy")
		.map((record) => ({
			features: record.features,
			target: record.target.keepScore,
			weight: record.target.puWeight,
		}));
	return {
		oracleExamples,
		policyExamples,
		compressionExamples: records.filter((record) => record.task === "compression").length,
		holdoutExamples: records.filter((record) => record.split === "holdout").length,
		teacherRecords: records.filter((record) => record.labeler.startsWith("teacher:")).length,
		localRecords: records.filter((record) => record.labeler === "local-replay-rubric").length,
		labelers: [...new Set(records.map((record) => record.labeler))].sort(),
		totalRecords: records.length,
	};
}

export function conductorTrainingDataHash(jsonl: string): string {
	return createHash("sha256").update(jsonl).digest("hex");
}

function buildBudgetRecord(scenario: Scenario, split: ConductorTrainingSplit): BudgetOracleTrainingRecord {
	const promptRisk = hasRecallRisk(scenario.probe);
	return {
		...baseRecord("budget_oracle", scenario, split, scenario.name),
		features: budgetFeatures(scenario.messages, scenario.probe),
		target: {
			targetMultiplier: 1.0,
			weight: 1,
			rationale: promptRisk
				? "Prompt asks for exact or durable recall; the artifact budget oracle should not loosen or tighten authority until A/B proof supports it."
				: "Prompt is broad continuation; the checked-in artifact keeps budget authority neutral until A/B proof supports tightening.",
		},
	};
}

function buildFoldPolicyRecord(
	scenario: Scenario,
	block: ContextBlock,
	currentTurn: number,
	keys: string[],
	split: ConductorTrainingSplit,
): FoldPolicyTrainingRecord {
	const lower = block.text.toLowerCase();
	const isPositive = keys.some((key) => lower.includes(key));
	const blockHash = textHash(block.text);
	const features = foldFeatures({
		kindRank: FOLD_RANK[block.kind] / 4,
		keywordOverlap: keywordOverlap(block.text, scenario.probe),
		recency: block.turn / currentTurn,
		tokenCount: block.tokens,
		agentAttention: isPositive ? 1 : 0,
		wasRecentlyUnfolded: false,
	});
	return {
		...baseRecord("fold_policy", scenario, split, `${scenario.name}:${block.id}`),
		blockId: block.id,
		blockHash,
		contentHash: contentTrainingHash(block),
		turn: block.turn,
		kind: block.kind,
		features,
		target: {
			label: isPositive ? "positive" : "unlabeled",
			keepScore: isPositive ? 0.72 : 0,
			expectedReuseTurns: isPositive ? 4 : 12,
			level: 2,
			puWeight: isPositive ? 1 : 0.12,
			rationale: isPositive
				? "Scenario construction marks this block as answer-bearing; deterministic digest should preserve the fact without forcing full text."
				: "No observed recall signal; treated as low-weight unlabeled PU data, not confirmed negative.",
		},
	};
}

function buildCompressionRecord(scenario: Scenario, block: ContextBlock, split: ConductorTrainingSplit): CompressionTrainingRecord {
	return {
		...baseRecord("compression", scenario, split, `${scenario.name}:${block.id}`),
		blockId: block.id,
		blockHash: textHash(block.text),
		contentHash: contentTrainingHash(block),
		turn: block.turn,
		kind: block.kind,
		target: {
			mode: "deterministic_extract",
			digest: deterministicDigest(block),
			fidelityGate: true,
			fidelityLabels: extractFidelityLabels(block.text),
			rationale: "Local replay uses the deterministic extractive digest as the accepted compression teacher.",
		},
	};
}

function baseRecord(
	task: ConductorTrainingTask,
	scenario: Scenario,
	split: ConductorTrainingSplit,
	seed: string,
): ConductorTrainingRecordBase {
	return {
		version: 1,
		recordId: `${task}:${textHash(seed)}`,
		task,
		rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
		rubricPath: CONDUCTOR_RUBRIC_PATH,
		source: "compare-compact-replay",
		split,
		scenario: scenario.name,
		category: scenario.category,
		probe: scenario.probe,
		labeler: "local-replay-rubric",
	};
}

function scenarioKeys(scenario: Scenario): string[] {
	return [scenario.key, ...(scenario.aliases ?? [])].map((value) => value.toLowerCase());
}

function scenarioSplit(scenario: Scenario): ConductorTrainingSplit {
	return scenario.name === "semantic-launch-rehearsal" ? "holdout" : "train";
}

function contentTrainingHash(block: ContextBlock): string {
	const normalized = JSON.stringify({
		kind: block.kind,
		toolName: block.toolName ?? "",
		callId: block.callId ?? "",
		isError: !!block.isError,
		text: block.text.replace(/\s+/g, " ").trim(),
	});
	return createHash("sha256").update(normalized).digest("hex");
}

function extractFidelityLabels(text: string): CompressionTrainingRecord["target"]["fidelityLabels"] {
	return {
		paths: unique(text.match(/\b(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\b/g) ?? []),
		commands: unique(text.match(/\b(?:npm|node|pnpm|yarn|git|cargo|rustup|python|pip|deno)\s+[^\n.;]+/g) ?? []),
		errors: unique(text.match(/\b(?:Error|Exception|failed|failure|timeout|crash|bug)[^.\n]{0,80}/gi) ?? []),
		exactValues: unique([
			...(text.match(/\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+){1,}\b/g) ?? []),
			...(text.match(/\b[A-Za-z_][A-Za-z0-9_]*=[^\s,;]+/g) ?? []),
		]),
		decisions: unique(text.match(/\b(?:final decision|decision was|standardize on|choose|preferred|favor(?:ed)?|decided)\b[^.\n]{0,120}/gi) ?? []),
	};
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 8);
}

export function validateConductorTrainingRecord(record: ConductorTrainingRecord, line: number): void {
	if (record.version !== 1) throw new Error(`Training data line ${line} has unsupported version`);
	if (record.rubricVersion !== CONDUCTOR_LABELING_RUBRIC_VERSION) {
		throw new Error(`Training data line ${line} uses unsupported rubric ${record.rubricVersion}`);
	}
	if (!["budget_oracle", "fold_policy", "compression"].includes(record.task)) {
		throw new Error(`Training data line ${line} has unsupported task`);
	}
	if (record.split !== "train" && record.split !== "holdout") {
		throw new Error(`Training data line ${line} has unsupported split`);
	}
	if (record.labeler !== "local-replay-rubric" && !/^teacher:[A-Za-z0-9_.-]+$/.test(record.labeler)) {
		throw new Error(`Training data line ${line} has unsupported labeler ${record.labeler}`);
	}
	if (record.task === "budget_oracle") validateBudgetTarget(record, line);
	else if (record.task === "fold_policy") validateFoldPolicyTarget(record, line);
	else validateCompressionTarget(record, line);
}

function validateBudgetTarget(record: BudgetOracleTrainingRecord, line: number): void {
	const target = record.target;
	if (!Number.isFinite(target.targetMultiplier) || target.targetMultiplier <= 0) {
		throw new Error(`Training data line ${line} has invalid budget targetMultiplier`);
	}
	if (!Number.isFinite(target.weight) || target.weight <= 0) {
		throw new Error(`Training data line ${line} has invalid budget weight`);
	}
	if (!target.rationale || typeof target.rationale !== "string") {
		throw new Error(`Training data line ${line} has invalid budget rationale`);
	}
}

function validateFoldPolicyTarget(record: FoldPolicyTrainingRecord, line: number): void {
	const target = record.target;
	if (target.label !== "positive" && target.label !== "unlabeled") {
		throw new Error(`Training data line ${line} has unsupported fold label`);
	}
	if (!Number.isFinite(target.keepScore) || target.keepScore < 0 || target.keepScore > 1) {
		throw new Error(`Training data line ${line} has invalid fold keepScore`);
	}
	if (!Number.isFinite(target.expectedReuseTurns) || target.expectedReuseTurns < 0) {
		throw new Error(`Training data line ${line} has invalid fold expectedReuseTurns`);
	}
	if (![0, 1, 2, 3].includes(target.level)) {
		throw new Error(`Training data line ${line} has unsupported fold level`);
	}
	if (!Number.isFinite(target.puWeight) || target.puWeight <= 0 || target.puWeight > 1) {
		throw new Error(`Training data line ${line} has invalid fold puWeight`);
	}
	if (!target.rationale || typeof target.rationale !== "string") {
		throw new Error(`Training data line ${line} has invalid fold rationale`);
	}
}

function validateCompressionTarget(record: CompressionTrainingRecord, line: number): void {
	const target = record.target;
	if (target.mode !== "deterministic_extract" && target.mode !== "teacher_textual_digest") {
		throw new Error(`Training data line ${line} has unsupported compression mode`);
	}
	if (!target.digest || typeof target.digest !== "string") {
		throw new Error(`Training data line ${line} has invalid compression digest`);
	}
	if (target.fidelityGate !== true) {
		throw new Error(`Training data line ${line} has invalid compression fidelityGate`);
	}
	for (const key of ["paths", "commands", "errors", "exactValues", "decisions"] as const) {
		const values = target.fidelityLabels?.[key];
		if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
			throw new Error(`Training data line ${line} has invalid compression fidelityLabels.${key}`);
		}
	}
	if (!target.rationale || typeof target.rationale !== "string") {
		throw new Error(`Training data line ${line} has invalid compression rationale`);
	}
}
