import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	parseConductorModelArtifact,
	validateConductorModelAuthority,
	type ConductorModelAuthority,
} from "./conductor.ts";

interface PromotionInputs {
	artifactFile: string;
	labelAuditFile: string;
	modelEvaluationFile: string;
	generatedAt?: string;
	requireTeacherDistillation?: boolean;
	requireMiniLmFoldPolicy?: boolean;
	requireTextualCompressor?: boolean;
}

interface LabelAuditReport {
	agreement: number;
	disagreements: unknown[];
	byTask: Record<string, { agreement: number }>;
}

interface ModelEvaluationReport {
	summary: {
		heuristicScore: number;
		learnedScore: number;
		compactScore: number;
		learnedQualityDelta: number;
		learnedTokenDelta: number;
		heuristicWins: number;
		tokenRegressionConversations: number;
		learnedBudgetViolations: number;
		bootstrapQualityDelta: { probabilityNonNegative: number };
	};
}

const DEFAULT_ARTIFACT = "models/conductor-local-v1.json";
const DEFAULT_LABEL_AUDIT = "docs/conductor-label-audit.json";
const DEFAULT_MODEL_EVALUATION = "docs/conductor-model-evaluation.json";
const DEFAULT_OUT = "models/conductor-local-v1.authority.json";

export function deriveConductorModelAuthority(input: PromotionInputs): ConductorModelAuthority {
	const artifact = parseConductorModelArtifact(readFileSync(input.artifactFile, "utf8"));
	const labelAudit = JSON.parse(readFileSync(input.labelAuditFile, "utf8")) as LabelAuditReport;
	const evaluation = JSON.parse(readFileSync(input.modelEvaluationFile, "utf8")) as ModelEvaluationReport;
	const failures = promotionFailures(labelAudit, evaluation, {
		requireTeacherDistillation: input.requireTeacherDistillation,
		distillation: artifact.training.distillation,
		requireMiniLmFoldPolicy: input.requireMiniLmFoldPolicy,
		foldPolicy: artifact.foldPolicy,
		requireTextualCompressor: input.requireTextualCompressor,
		compression: artifact.compression,
	});
	if (failures.length > 0) {
		throw new Error(`Cannot promote Conductor model authority: ${failures.join("; ")}`);
	}
	return validateConductorModelAuthority({
		version: 1,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		artifact: input.artifactFile,
		artifactDatasetHash: artifact.training.datasetHash,
		evidence: {
			labelAudit: input.labelAuditFile,
			modelEvaluation: input.modelEvaluationFile,
		},
		authority: {
			budgetOracle: {
				mode: "cost_guarded",
				maxTargetMultiplier: 1,
			},
			foldPolicy: {
				mode: "shadow_only",
			},
			compression: {
				mode: "digest_only",
			},
		},
	});
}

export function promotionFailures(
	labelAudit: LabelAuditReport,
	evaluation: ModelEvaluationReport,
	options: {
		requireTeacherDistillation?: boolean;
		distillation?: {
			teacherRecords: number;
			readyForLiveAuthority: boolean;
			missing: string[];
		};
		requireMiniLmFoldPolicy?: boolean;
		foldPolicy?: {
			architecture?: string;
			encoder?: { modelFamily?: string; modelId?: string };
			distillation?: { teacherRecords: number; trainingPairs: number };
			crossEncoderHead?: { type?: string; teacherPairs?: number; trainingPairs?: number };
		};
		requireTextualCompressor?: boolean;
		compression?: {
			mode?: string;
			fidelityGate?: boolean;
			baseModel?: { modelFamily?: string; modelId?: string };
			adapter?: { type?: string };
			distillation?: { teacherRecords: number; compressionRecords: number };
			digestTable?: Record<string, unknown>;
		};
	} = {},
): string[] {
	const failures: string[] = [];
	if (options.requireTeacherDistillation) {
		if (!options.distillation?.readyForLiveAuthority) {
			const missing = options.distillation?.missing?.join(",") || "distillation_metadata";
			failures.push(`teacher distillation not ready: ${missing}`);
		}
		if ((options.distillation?.teacherRecords ?? 0) <= 0) {
			failures.push("teacher distillation records 0 <= 0");
		}
	}
	if (options.requireMiniLmFoldPolicy) {
		if (options.foldPolicy?.architecture !== "minilm_cross_encoder_distilled") {
			failures.push(`fold policy architecture ${options.foldPolicy?.architecture ?? "linear_replay"} != minilm_cross_encoder_distilled`);
		}
		if (options.foldPolicy?.encoder?.modelFamily !== "MiniLM" || !/minilm/i.test(options.foldPolicy?.encoder?.modelId ?? "")) {
			failures.push("fold policy encoder is not MiniLM");
		}
		if ((options.foldPolicy?.distillation?.teacherRecords ?? 0) <= 0 || (options.foldPolicy?.distillation?.trainingPairs ?? 0) <= 0) {
			failures.push("fold policy MiniLM distillation metadata is incomplete");
		}
		if (options.foldPolicy?.crossEncoderHead?.type !== "hashed_pair_regressor") {
			failures.push("fold policy MiniLM cross-encoder head is missing");
		}
		if ((options.foldPolicy?.crossEncoderHead?.teacherPairs ?? 0) <= 0 || (options.foldPolicy?.crossEncoderHead?.trainingPairs ?? 0) <= 0) {
			failures.push("fold policy MiniLM cross-encoder head metadata is incomplete");
		}
	}
	if (options.requireTextualCompressor) {
		if (options.compression?.mode !== "teacher_textual_digest_table") {
			failures.push(`compression mode ${options.compression?.mode ?? "deterministic_extract"} != teacher_textual_digest_table`);
		}
		if (!options.compression?.fidelityGate) failures.push("textual compressor fidelityGate is not enabled");
		if ((options.compression?.distillation?.teacherRecords ?? 0) <= 0 || (options.compression?.distillation?.compressionRecords ?? 0) <= 0) {
			failures.push("textual compressor distillation metadata is incomplete");
		}
		if (!options.compression?.digestTable || Object.keys(options.compression.digestTable).length === 0) {
			failures.push("textual compressor digest table is empty");
		}
	}
	if (labelAudit.agreement !== 1) failures.push(`label agreement ${labelAudit.agreement} != 1`);
	if ((labelAudit.disagreements?.length ?? 0) !== 0) {
		failures.push(`label disagreements ${labelAudit.disagreements.length} != 0`);
	}
	for (const [task, summary] of Object.entries(labelAudit.byTask ?? {})) {
		if (summary.agreement !== 1) failures.push(`${task} label agreement ${summary.agreement} != 1`);
	}
	const summary = evaluation.summary;
	if (!summary) failures.push("missing model evaluation summary");
	else {
		if (summary.learnedScore < summary.heuristicScore) {
			failures.push(`learned score ${summary.learnedScore} < heuristic ${summary.heuristicScore}`);
		}
		if (summary.learnedScore < summary.compactScore) {
			failures.push(`learned score ${summary.learnedScore} < compact ${summary.compactScore}`);
		}
		if (summary.learnedQualityDelta < 0) failures.push(`learned quality delta ${summary.learnedQualityDelta} < 0`);
		if (summary.learnedTokenDelta < 0) failures.push(`learned token delta ${summary.learnedTokenDelta} < 0`);
		if (summary.heuristicWins !== 0) failures.push(`heuristic wins ${summary.heuristicWins} != 0`);
		if (summary.tokenRegressionConversations !== 0) {
			failures.push(`token-regression conversations ${summary.tokenRegressionConversations} != 0`);
		}
		if (summary.learnedBudgetViolations !== 0) {
			failures.push(`learned budget violations ${summary.learnedBudgetViolations} != 0`);
		}
		if ((summary.bootstrapQualityDelta?.probabilityNonNegative ?? 0) < 0.95) {
			failures.push(`bootstrap quality non-negative probability ${summary.bootstrapQualityDelta?.probabilityNonNegative ?? 0} < 0.95`);
		}
	}
	return failures;
}

function flag(argv: string[], name: string, fallback: string): string {
	return argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
}

function main(): void {
	const argv = process.argv.slice(2);
	const outFile = flag(argv, "out", DEFAULT_OUT);
	const authority = deriveConductorModelAuthority({
		artifactFile: flag(argv, "artifact", DEFAULT_ARTIFACT),
		labelAuditFile: flag(argv, "label-audit", DEFAULT_LABEL_AUDIT),
		modelEvaluationFile: flag(argv, "model-evaluation", DEFAULT_MODEL_EVALUATION),
		requireTeacherDistillation: argv.includes("--require-teacher-distillation"),
		requireMiniLmFoldPolicy: argv.includes("--require-minilm-fold-policy"),
		requireTextualCompressor: argv.includes("--require-textual-compressor"),
	});
	writeFileSync(outFile, `${JSON.stringify(authority, null, 2)}\n`);
	process.stdout.write(`Wrote ${outFile}\n`);
	process.stdout.write(`${JSON.stringify(authority.authority, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
