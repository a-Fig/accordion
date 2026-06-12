import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CONDUCTOR_LABELING_RUBRIC_VERSION,
	CONDUCTOR_RUBRIC_PATH,
	buildConductorTrainingRecords,
	conductorTrainingDataHash,
	conductorTrainingVectors,
	parseConductorTrainingJsonl,
	serializeConductorTrainingRecords,
	type ConductorTrainingVectors,
	type VectorExample,
} from "./conductor-training-data.ts";
import {
	type ConductorModelArtifact,
	type LinearModelArtifact,
} from "./conductor.ts";

const DEFAULT_OUT = "models/conductor-local-v1.json";

function fitLinear(examples: VectorExample[], options: { epochs: number; rate: number; clamp?: [number, number] }): LinearModelArtifact {
	if (examples.length === 0) throw new Error("Cannot train linear model without examples");
	const names = [...new Set(examples.flatMap((example) => Object.keys(example.features)))].sort();
	let intercept = examples.reduce((sum, example) => sum + example.target, 0) / examples.length;
	const weights = Object.fromEntries(names.map((name) => [name, 0]));
	for (let epoch = 0; epoch < options.epochs; epoch++) {
		for (const example of examples) {
			const pred = intercept + names.reduce((sum, name) => sum + (example.features[name] ?? 0) * weights[name], 0);
			const error = (pred - example.target) * (example.weight ?? 1);
			intercept -= options.rate * error;
			for (const name of names) {
				weights[name] -= options.rate * error * (example.features[name] ?? 0);
			}
		}
	}
	return {
		intercept: Number(intercept.toFixed(6)),
		weights: Object.fromEntries(Object.entries(weights).map(([name, value]) => [name, Number(value.toFixed(6))])),
		confidence: 0.72,
		min: options.clamp?.[0],
		max: options.clamp?.[1],
	};
}

function distillationMetadata(vectors: ConductorTrainingVectors): NonNullable<ConductorModelArtifact["training"]["distillation"]> {
	const missing: string[] = [];
	if (vectors.teacherRecords === 0) missing.push("teacher_labels");
	if (!vectors.labelers.some((labeler) => /^teacher:/i.test(labeler))) missing.push("teacher_labeler");
	return {
		teacherRecords: vectors.teacherRecords,
		localRecords: vectors.localRecords,
		labelers: vectors.labelers,
		readyForLiveAuthority: missing.length === 0,
		missing,
	};
}

export function loadTrainingVectors(dataFile?: string): {
	vectors: ConductorTrainingVectors;
	datasetHash: string;
	datasetSource: string;
} {
	const jsonl = dataFile
		? readFileSync(dataFile, "utf8")
		: serializeConductorTrainingRecords(buildConductorTrainingRecords());
	const records = parseConductorTrainingJsonl(jsonl);
	return {
		vectors: conductorTrainingVectors(records),
		datasetHash: conductorTrainingDataHash(jsonl),
		datasetSource: dataFile ?? "generated:compare-compact-replay",
	};
}

export function buildArtifact(dataFile?: string): ConductorModelArtifact {
	const { vectors, datasetHash, datasetSource } = loadTrainingVectors(dataFile);
	const oracle = fitLinear(vectors.oracleExamples, { epochs: 120, rate: 0.0004, clamp: [0.88, 1.12] });
	const policy = fitLinear(vectors.policyExamples, { epochs: 160, rate: 0.002 });
	const distillation = distillationMetadata(vectors);
	return {
		version: 1,
		createdAt: "2026-06-12T00:00:00.000Z",
		source: distillation.readyForLiveAuthority
			? "teacher-distilled compare-compact replay"
			: "compare-compact replay distillation via local rubric",
		training: {
			examples: vectors.oracleExamples.length + vectors.policyExamples.length,
			oracleExamples: vectors.oracleExamples.length,
			foldPolicyExamples: vectors.policyExamples.length,
			compressionExamples: vectors.compressionExamples,
			holdoutExamples: vectors.holdoutExamples,
			datasetRecords: vectors.totalRecords,
			datasetHash,
			datasetSource,
			rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
			rubricPath: CONDUCTOR_RUBRIC_PATH,
			distillation,
		},
		budgetOracle: oracle,
		foldPolicy: {
			...policy,
			architecture: "linear_replay",
			confidence: 0.73,
			reuseHorizonTurns: 12,
		},
		compression: {
			mode: "deterministic_extract",
			confidence: 0.76,
			fidelityGate: true,
		},
	};
}

function main(): void {
	const out = process.argv.find((arg) => arg.startsWith("--out="))?.split("=")[1] ?? DEFAULT_OUT;
	const dataFile = process.argv.find((arg) => arg.startsWith("--data="))?.split("=")[1];
	const artifact = buildArtifact(dataFile);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
	process.stdout.write(`Wrote ${out} with ${artifact.training.examples} training examples\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
