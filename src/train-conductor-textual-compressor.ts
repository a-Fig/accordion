import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	parseConductorTrainingJsonl,
	type CompressionTrainingRecord,
} from "./conductor-training-data.ts";
import {
	buildArtifact,
	loadTrainingVectors,
} from "./train-conductor-model.ts";
import {
	type CompressionDigestEntryArtifact,
	type ConductorModelArtifact,
} from "./conductor.ts";

export interface TextualCompressorOptions {
	dataFile: string;
	outFile?: string;
	modelId?: string;
	minTeacherCompressionRecords?: number;
}

const DEFAULT_OUT = "models/conductor-textual-compressor-v1.json";
const DEFAULT_QWEN_MODEL = "Qwen/Qwen2.5-0.5B-Instruct";
const PROMPT_TEMPLATE =
	"Compress this block into a grounded textual digest. Preserve exact paths, commands, marker values, errors, and decisions. Block: {block}";

export function buildTextualCompressorArtifact(options: TextualCompressorOptions): ConductorModelArtifact {
	const jsonl = readFileSync(options.dataFile, "utf8");
	const records = parseConductorTrainingJsonl(jsonl);
	const { vectors, datasetSource } = loadTrainingVectors(options.dataFile);
	const teacherCompression = records.filter(
		(record): record is CompressionTrainingRecord =>
			record.task === "compression" &&
			record.labeler.startsWith("teacher:") &&
			record.target.mode === "teacher_textual_digest",
	);
	const minRecords = options.minTeacherCompressionRecords ?? 1;
	if (teacherCompression.length < minRecords) {
		throw new Error(`Teacher compression records ${teacherCompression.length} < required ${minRecords}`);
	}
	const digestTable: Record<string, CompressionDigestEntryArtifact> = {};
	for (const record of teacherCompression) {
		digestTable[record.contentHash] = {
			digest: record.target.digest,
			fidelityLabels: record.target.fidelityLabels,
			labeler: record.labeler,
		};
	}
	const artifact = buildArtifact(options.dataFile);
	return {
		...artifact,
		source: "teacher-distilled textual compressor candidate",
		compression: {
			mode: "teacher_textual_digest_table",
			confidence: 0.78,
			fidelityGate: true,
			baseModel: {
				modelFamily: "Qwen2.5",
				modelId: options.modelId ?? DEFAULT_QWEN_MODEL,
			},
			adapter: {
				type: "digest_table",
				path: "data/conductor-training-teacher.jsonl",
			},
			promptTemplate: PROMPT_TEMPLATE,
			distillation: {
				teacherRecords: vectors.teacherRecords,
				compressionRecords: teacherCompression.length,
				source: datasetSource,
			},
			digestTable,
		},
	};
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
	const artifact = buildTextualCompressorArtifact({
		dataFile,
		outFile,
		modelId: stringFlag(argv, "model-id", DEFAULT_QWEN_MODEL),
		minTeacherCompressionRecords: numericFlag(argv, "min-teacher-compression-records", 1),
	});
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, `${JSON.stringify(artifact, null, 2)}\n`);
	process.stdout.write(`Wrote ${outFile}\n`);
	process.stdout.write(`${JSON.stringify({
		mode: artifact.compression.mode,
		modelId: artifact.compression.baseModel?.modelId,
		compressionRecords: artifact.compression.distillation?.compressionRecords,
		digestEntries: Object.keys(artifact.compression.digestTable ?? {}).length,
	}, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
