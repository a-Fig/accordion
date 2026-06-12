import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildScenarios } from "./compare-compact.ts";
import {
	categorizeSalienceMarkers,
	contentHash,
	createArtifactCompressionProvider,
	deterministicDigest,
	parseConductorModelArtifact,
	parseMessages,
	type CompressionValue,
	type ConductorModelAuthority,
	type ConductorModelArtifact,
	type ContextBlock,
} from "./conductor.ts";

export interface CompressionEvaluationSummary {
	scenarios: number;
	blocks: number;
	answerBearingBlocks: number;
	deterministicRecall: number;
	candidateRecall: number;
	recallDelta: number;
	fidelityEscapes: number;
	teacherDigestHits: number;
	deterministicFallbacks: number;
}

export interface CompressionEvaluationReport {
	artifact: string;
	summary: CompressionEvaluationSummary;
	failures: string[];
}

const DEFAULT_ARTIFACT = "models/conductor-teacher-student-v1.json";
const DEFAULT_OUT = "docs/conductor-compression-evaluation.json";

export async function evaluateCompressionArtifact(
	artifact: ConductorModelArtifact,
	options: { artifactFile?: string } = {},
): Promise<CompressionEvaluationReport> {
	const authority = compressionMetadataAuthority(options.artifactFile ?? DEFAULT_ARTIFACT);
	const provider = createArtifactCompressionProvider(artifact, authority);
	const scenarios = buildScenarios();
	let blocks = 0;
	let answerBearingBlocks = 0;
	let deterministicRecall = 0;
	let candidateRecall = 0;
	let fidelityEscapes = 0;
	let teacherDigestHits = 0;
	let deterministicFallbacks = 0;

	for (const scenario of scenarios) {
		const parsed = parseMessages(scenario.messages);
		for (const block of parsed.blocks) {
			blocks++;
			const deterministic = deterministicDigest(block);
			const result = await provider({
				block,
				hash: contentHash(block),
				deterministicDigest: deterministic,
			});
			if (result.reason?.includes("teacher_digest")) teacherDigestHits++;
			if (result.reason?.includes("deterministic_fallback")) deterministicFallbacks++;
			const keys = [scenario.key, ...(scenario.aliases ?? [])].filter((key) =>
				block.text.toLowerCase().includes(key.toLowerCase()) ||
				deterministic.toLowerCase().includes(key.toLowerCase()),
			);
			if (keys.length > 0) {
				answerBearingBlocks++;
				if (containsAny(deterministic, keys)) deterministicRecall++;
				if (containsAny(result.value.digest, keys)) candidateRecall++;
			}
			if (fidelityFailure(block, result.value)) fidelityEscapes++;
		}
	}
	const summary: CompressionEvaluationSummary = {
		scenarios: scenarios.length,
		blocks,
		answerBearingBlocks,
		deterministicRecall,
		candidateRecall,
		recallDelta: candidateRecall - deterministicRecall,
		fidelityEscapes,
		teacherDigestHits,
		deterministicFallbacks,
	};
	return {
		artifact: options.artifactFile ?? DEFAULT_ARTIFACT,
		summary,
		failures: compressionGateFailures(summary),
	};
}

export function compressionGateFailures(
	summary: CompressionEvaluationSummary,
	options: {
		minRecallDelta?: number;
		maxFidelityEscapes?: number;
		minTeacherDigestHits?: number;
		minBlocks?: number;
	} = {},
): string[] {
	const failures: string[] = [];
	const minRecallDelta = options.minRecallDelta ?? 0;
	const maxFidelityEscapes = options.maxFidelityEscapes ?? 0;
	const minTeacherDigestHits = options.minTeacherDigestHits ?? 1;
	const minBlocks = options.minBlocks ?? 1;
	if (summary.blocks < minBlocks) failures.push(`blocks ${summary.blocks} < ${minBlocks}`);
	if (summary.recallDelta < minRecallDelta) failures.push(`recall delta ${summary.recallDelta} < ${minRecallDelta}`);
	if (summary.fidelityEscapes > maxFidelityEscapes) {
		failures.push(`fidelity escapes ${summary.fidelityEscapes} > ${maxFidelityEscapes}`);
	}
	if (summary.teacherDigestHits < minTeacherDigestHits) {
		failures.push(`teacher digest hits ${summary.teacherDigestHits} < ${minTeacherDigestHits}`);
	}
	return failures;
}

function compressionMetadataAuthority(artifactFile: string): ConductorModelAuthority {
	return {
		version: 1,
		generatedAt: "2026-06-12T00:00:00.000Z",
		artifact: artifactFile,
		evidence: {},
		authority: {
			budgetOracle: { mode: "cost_guarded", maxTargetMultiplier: 1 },
			foldPolicy: { mode: "shadow_only" },
			compression: { mode: "metadata_live" },
		},
	};
}

function containsAny(text: string, keys: string[]): boolean {
	const lower = text.toLowerCase();
	return keys.some((key) => lower.includes(key.toLowerCase()));
}

function fidelityFailure(block: ContextBlock, value: CompressionValue): boolean {
	const source = block.text.toLowerCase();
	const digestMarkers = categorizeSalienceMarkers(stripDigestSalienceSuffix(value.digest));
	const markers: Array<{ kind: "marker" | "exact"; value: string }> = [
		...digestMarkers.paths,
		...digestMarkers.commands,
		...digestMarkers.errors,
		...digestMarkers.decisions,
		...(value.salience?.paths ?? []),
		...(value.salience?.commands ?? []),
		...(value.salience?.errors ?? []),
		...(value.salience?.decisions ?? []),
	].map((value) => ({ kind: "marker", value }));
	markers.push(
		...[
			...digestMarkers.exact_values.filter((marker) => !isSyntheticDigestExactValue(marker)),
			...(value.salience?.exact_values ?? []),
		].map((value) => ({ kind: "exact" as const, value })),
	);
	return markers.some((marker) => !isGrounded(source, marker.value, marker.kind));
}

function stripDigestSalienceSuffix(digest: string): string {
	return digest.replace(/\s*⟦[^⟧]*⟧\s*$/u, "");
}

function isSyntheticDigestExactValue(marker: string): boolean {
	return /^(?:digest|paths|commands|errors|exact_values|decisions)=/i.test(marker);
}

function isGrounded(sourceLower: string, marker: string, kind: "marker" | "exact"): boolean {
	const normalized = marker.toLowerCase().trim();
	if (!normalized) return true;
	if (sourceLower.includes(normalized)) return true;
	if (kind !== "exact" || !normalized.includes("=")) return false;
	const [key, ...valueParts] = normalized.split("=");
	const value = valueParts.join("=");
	if (!key || !value) return false;
	const pattern = new RegExp(`\\b${escapeRegExp(key)}\\s*[:=]\\s*${escapeRegExp(value)}`);
	return pattern.test(sourceLower);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numericFlag(argv: string[], name: string, fallback: number): number {
	const value = argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
	return value === undefined ? fallback : Number(value);
}

function stringFlag(argv: string[], name: string, fallback: string): string {
	return argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const artifactFile = stringFlag(argv, "artifact", DEFAULT_ARTIFACT);
	const outFile = stringFlag(argv, "out", DEFAULT_OUT);
	const artifact = parseConductorModelArtifact(readFileSync(artifactFile, "utf8"));
	const report = await evaluateCompressionArtifact(artifact, { artifactFile });
	report.failures = compressionGateFailures(report.summary, {
		minRecallDelta: numericFlag(argv, "min-recall-delta", 0),
		maxFidelityEscapes: numericFlag(argv, "max-fidelity-escapes", 0),
		minTeacherDigestHits: numericFlag(argv, "min-teacher-digest-hits", 1),
		minBlocks: numericFlag(argv, "min-blocks", 1),
	});
	writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(`Results written to ${outFile}\n`);
	process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
	if (report.failures.length > 0) {
		for (const failure of report.failures) process.stderr.write(`COMPRESSION EVALUATION FAILED: ${failure}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
