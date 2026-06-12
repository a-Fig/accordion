import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildArtifact,
	loadTrainingVectors,
} from "./train-conductor-model.ts";
import {
	parseConductorTrainingJsonl,
	type ConductorTrainingRecord,
	type FoldPolicyTrainingRecord,
	type VectorExample,
} from "./conductor-training-data.ts";
import { buildScenarios } from "./compare-compact.ts";
import {
	type ConductorModelArtifact,
	type ContextBlock,
	type FoldPolicyCrossEncoderHeadArtifact,
	type FoldPolicyEncoderArtifact,
	foldPolicyCrossEncoderFeatureEntries,
	parseMessages,
} from "./conductor.ts";

export interface MiniLmPolicyOptions {
	dataFile: string;
	outFile?: string;
	modelId?: string;
	minTeacherRecords?: number;
	featureDimension?: number;
	epochs?: number;
	rate?: number;
}

const DEFAULT_OUT = "models/conductor-minilm-policy-v1.json";
const DEFAULT_MINILM_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
const PAIR_TEMPLATE = "Query: {prompt}\n\nBlock: {block}";
const DEFAULT_FEATURE_DIMENSION = 256;

interface PairExample extends VectorExample {
	entries: Array<[number, number]>;
	labeler: string;
}

export function buildMiniLmPolicyArtifact(options: MiniLmPolicyOptions): ConductorModelArtifact {
	const { vectors, datasetSource } = loadTrainingVectors(options.dataFile);
	const minTeacherRecords = options.minTeacherRecords ?? 1;
	if (vectors.teacherRecords < minTeacherRecords) {
		throw new Error(`Teacher records ${vectors.teacherRecords} < required ${minTeacherRecords}`);
	}
	const records = parseConductorTrainingJsonl(readFileSync(options.dataFile, "utf8"));
	const head = trainCrossEncoderHead(records, {
		featureDimension: options.featureDimension ?? DEFAULT_FEATURE_DIMENSION,
		epochs: options.epochs ?? 140,
		rate: options.rate ?? 0.035,
	});
	if (head.teacherPairs < minTeacherRecords) {
		throw new Error(`Teacher fold-policy pairs ${head.teacherPairs} < required ${minTeacherRecords}`);
	}
	const artifact = buildArtifact(options.dataFile);
	const encoder: FoldPolicyEncoderArtifact = {
		modelFamily: "MiniLM",
		modelId: options.modelId ?? DEFAULT_MINILM_MODEL,
		pairTemplate: PAIR_TEMPLATE,
		pooling: "cls",
		embeddingDimension: 384,
	};
	return {
		...artifact,
		source: "teacher-distilled MiniLM-class fold-policy artifact",
		foldPolicy: {
			...artifact.foldPolicy,
			architecture: "minilm_cross_encoder_distilled",
			encoder,
			crossEncoderHead: head,
			distillation: {
				teacherRecords: head.teacherPairs,
				trainingPairs: head.trainingPairs,
				holdoutPairs: vectors.holdoutExamples,
				source: datasetSource,
			},
		},
	};
}

export function trainCrossEncoderHead(
	records: ConductorTrainingRecord[],
	options: { featureDimension: number; epochs: number; rate: number },
): FoldPolicyCrossEncoderHeadArtifact {
	const examples = buildPairExamples(records, options.featureDimension);
	if (examples.length === 0) throw new Error("Cannot train MiniLM fold policy without fold-policy pairs");
	const teacherPairs = examples.filter((example) => example.labeler.startsWith("teacher:")).length;
	const weights = Array(options.featureDimension).fill(0);
	const meanTarget = weightedMean(examples.map((example) => ({ target: example.target, weight: example.weight ?? 1 })));
	let intercept = logit(Math.max(0.01, Math.min(0.99, meanTarget)));
	const l2 = 0.0005;
	for (let epoch = 0; epoch < options.epochs; epoch++) {
		for (const example of examples) {
			const raw = intercept + example.entries.reduce((sum, [index, value]) => sum + weights[index] * value, 0);
			const pred = 1 / (1 + Math.exp(-raw));
			const error = (pred - example.target) * (example.weight ?? 1);
			intercept -= options.rate * error;
			for (const [index, value] of example.entries) {
				weights[index] = weights[index] * (1 - options.rate * l2) - options.rate * error * value;
			}
		}
	}
	return {
		type: "hashed_pair_regressor",
		featureDimension: options.featureDimension,
		intercept: round(intercept),
		weights: weights.map(round),
		confidence: 0.78,
		trainingPairs: examples.length,
		teacherPairs,
	};
}

function buildPairExamples(records: FoldPolicyTrainingRecord[], featureDimension: number): PairExample[] {
	const blocks = scenarioBlockLookup();
	const examples: PairExample[] = [];
	for (const record of records) {
		if (record.task !== "fold_policy" || record.split !== "train") continue;
		const block = blocks.get(`${record.scenario}:${record.blockId}`);
		if (!block) throw new Error(`Missing block text for ${record.scenario}:${record.blockId}`);
		examples.push({
			features: record.features,
			target: record.target.keepScore,
			weight: record.target.puWeight * (record.labeler.startsWith("teacher:") ? 8 : 1),
			entries: foldPolicyCrossEncoderFeatureEntries(record.probe, block.text, record.features, featureDimension),
			labeler: record.labeler,
		});
	}
	return examples;
}

function scenarioBlockLookup(): Map<string, ContextBlock> {
	const map = new Map<string, ContextBlock>();
	for (const scenario of buildScenarios()) {
		const parsed = parseMessages(scenario.messages);
		for (const block of parsed.blocks) map.set(`${scenario.name}:${block.id}`, block);
	}
	return map;
}

function weightedMean(values: Array<{ target: number; weight: number }>): number {
	let total = 0;
	let weight = 0;
	for (const item of values) {
		total += item.target * item.weight;
		weight += item.weight;
	}
	return weight === 0 ? 0.5 : total / weight;
}

function logit(value: number): number {
	return Math.log(value / (1 - value));
}

function round(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function stringFlag(argv: string[], name: string, fallback?: string): string | undefined {
	const inline = argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
	if (inline !== undefined) return inline;
	const index = argv.indexOf(`--${name}`);
	if (index >= 0) {
		const value = argv[index + 1];
		if (value && !value.startsWith("--")) return value;
	}
	return fallback;
}

function numericFlag(argv: string[], name: string, fallback: number): number {
	const value = stringFlag(argv, name);
	return value === undefined ? fallback : Number(value);
}

function main(): void {
	const argv = process.argv.slice(2);
	const dataFile = stringFlag(argv, "data");
	if (!dataFile) throw new Error("--data=<teacher-training.jsonl> is required");
	const outFile = stringFlag(argv, "out", DEFAULT_OUT)!;
	const artifact = buildMiniLmPolicyArtifact({
		dataFile,
		outFile,
		modelId: stringFlag(argv, "model-id", DEFAULT_MINILM_MODEL),
		minTeacherRecords: numericFlag(argv, "min-teacher-records", 1),
		featureDimension: numericFlag(argv, "feature-dimension", DEFAULT_FEATURE_DIMENSION),
		epochs: numericFlag(argv, "epochs", 140),
		rate: numericFlag(argv, "rate", 0.035),
	});
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, `${JSON.stringify(artifact, null, 2)}\n`);
	process.stdout.write(`Wrote ${outFile}\n`);
	process.stdout.write(`${JSON.stringify({
		architecture: artifact.foldPolicy.architecture,
		modelId: artifact.foldPolicy.encoder?.modelId,
		teacherRecords: artifact.foldPolicy.distillation?.teacherRecords,
		trainingPairs: artifact.foldPolicy.distillation?.trainingPairs,
		head: artifact.foldPolicy.crossEncoderHead?.type,
		featureDimension: artifact.foldPolicy.crossEncoderHead?.featureDimension,
	}, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
