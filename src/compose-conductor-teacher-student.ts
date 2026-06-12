import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	parseConductorModelArtifact,
	validateConductorModelArtifact,
	type ConductorModelArtifact,
} from "./conductor.ts";

export interface ComposeTeacherStudentOptions {
	baseFile: string;
	foldPolicyFile: string;
	compressionFile: string;
}

const DEFAULT_BASE = "models/conductor-local-teacher-v1.json";
const DEFAULT_FOLD_POLICY = "models/conductor-minilm-policy-v1.json";
const DEFAULT_COMPRESSION = "models/conductor-textual-compressor-v1.json";
const DEFAULT_OUT = "models/conductor-teacher-student-v1.json";

export function composeTeacherStudentArtifact(options: ComposeTeacherStudentOptions): ConductorModelArtifact {
	const base = parseConductorModelArtifact(readFileSync(options.baseFile, "utf8"));
	const foldPolicy = parseConductorModelArtifact(readFileSync(options.foldPolicyFile, "utf8"));
	const compression = parseConductorModelArtifact(readFileSync(options.compressionFile, "utf8"));
	assertSameDataset(base, foldPolicy, options.baseFile, options.foldPolicyFile);
	assertSameDataset(base, compression, options.baseFile, options.compressionFile);
	return validateConductorModelArtifact({
		...base,
		source: "teacher-student candidate with MiniLM fold policy and textual compressor",
		foldPolicy: foldPolicy.foldPolicy,
		compression: compression.compression,
	});
}

function assertSameDataset(
	left: ConductorModelArtifact,
	right: ConductorModelArtifact,
	leftFile: string,
	rightFile: string,
): void {
	if (left.training.datasetHash && right.training.datasetHash && left.training.datasetHash !== right.training.datasetHash) {
		throw new Error(
			`Cannot compose artifacts from different datasets: ${leftFile}=${left.training.datasetHash}, ` +
			`${rightFile}=${right.training.datasetHash}`,
		);
	}
}

function stringFlag(argv: string[], name: string, fallback: string): string {
	const inline = argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
	if (inline !== undefined) return inline;
	const index = argv.indexOf(`--${name}`);
	if (index >= 0) {
		const value = argv[index + 1];
		if (value && !value.startsWith("--")) return value;
	}
	return fallback;
}

function main(): void {
	const argv = process.argv.slice(2);
	const outFile = stringFlag(argv, "out", DEFAULT_OUT);
	const artifact = composeTeacherStudentArtifact({
		baseFile: stringFlag(argv, "base", DEFAULT_BASE),
		foldPolicyFile: stringFlag(argv, "fold-policy", DEFAULT_FOLD_POLICY),
		compressionFile: stringFlag(argv, "compression", DEFAULT_COMPRESSION),
	});
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, `${JSON.stringify(artifact, null, 2)}\n`);
	process.stdout.write(`Wrote ${outFile}\n`);
	process.stdout.write(`${JSON.stringify({
		source: artifact.source,
		foldPolicy: artifact.foldPolicy.architecture,
		compression: artifact.compression.mode,
		teacherRecords: artifact.training.distillation?.teacherRecords,
	}, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
