import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CONDUCTOR_LABELING_RUBRIC_VERSION,
	CONDUCTOR_RUBRIC_PATH,
	buildConductorTrainingRecords,
	type BudgetOracleTrainingRecord,
	type CompressionTrainingRecord,
	type ConductorLabeler,
	type ConductorTrainingRecord,
	type ConductorTrainingTask,
	type FoldPolicyTrainingRecord,
} from "./conductor-training-data.ts";
import { buildScenarios } from "./compare-compact.ts";
import { parseMessages, type ContextBlock } from "./conductor.ts";

export interface ConductorTeacherLabelJob {
	version: 1;
	jobId: string;
	recordId: string;
	task: ConductorTrainingTask;
	rubricVersion: string;
	rubricPath: string;
	requestedLabeler: ConductorLabeler;
	scenario: string;
	category: "exact" | "semantic";
	split: "train" | "holdout";
	probe: string;
	instructions: string[];
	input: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
	labelTemplate: Record<string, unknown>;
}

export interface TeacherLabelJobOptions {
	tasks?: ConductorTrainingTask[];
	limit?: number;
	labeler?: ConductorLabeler;
}

const DEFAULT_OUT = "data/conductor-teacher-label-jobs.jsonl";
const DEFAULT_LABELER: ConductorLabeler = "teacher:claude-sonnet-4";
const TASKS: ConductorTrainingTask[] = ["budget_oracle", "fold_policy", "compression"];

export function buildConductorTeacherLabelJobs(
	records = buildConductorTrainingRecords(),
	options: TeacherLabelJobOptions = {},
): ConductorTeacherLabelJob[] {
	const tasks = new Set(options.tasks ?? TASKS);
	const labeler = options.labeler ?? DEFAULT_LABELER;
	const blocks = scenarioBlockLookup();
	const jobs: ConductorTeacherLabelJob[] = [];
	for (const record of records) {
		if (!tasks.has(record.task)) continue;
		if (record.labeler !== "local-replay-rubric") continue;
		jobs.push(buildJob(record, labeler, blocks));
		if (options.limit !== undefined && jobs.length >= options.limit) break;
	}
	return jobs;
}

export function serializeConductorTeacherLabelJobs(jobs: ConductorTeacherLabelJob[]): string {
	return `${jobs.map((job) => JSON.stringify(job)).join("\n")}\n`;
}

function buildJob(
	record: ConductorTrainingRecord,
	labeler: ConductorLabeler,
	blocks: Map<string, ContextBlock>,
): ConductorTeacherLabelJob {
	const block = "blockId" in record ? blocks.get(`${record.scenario}:${record.blockId}`) : undefined;
	return {
		version: 1,
		jobId: `${record.recordId}:label:${labeler}`,
		recordId: record.recordId,
		task: record.task,
		rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
		rubricPath: CONDUCTOR_RUBRIC_PATH,
		requestedLabeler: labeler,
		scenario: record.scenario,
		category: record.category,
		split: record.split,
		probe: record.probe,
		instructions: instructionsFor(record.task),
		input: inputFor(record, block),
		outputSchema: outputSchemaFor(record.task),
		labelTemplate: labelTemplateFor(record, labeler),
	};
}

function inputFor(record: ConductorTrainingRecord, block?: ContextBlock): Record<string, unknown> {
	const common = {
		recordId: record.recordId,
		task: record.task,
		scenario: record.scenario,
		category: record.category,
		split: record.split,
		probe: record.probe,
		localReplayTarget: record.target,
	};
	if (record.task === "budget_oracle") {
		return {
			...common,
			features: record.features,
		};
	}
	return {
		...common,
		blockId: record.blockId,
		blockHash: record.blockHash,
		contentHash: record.contentHash,
		turn: record.turn,
		kind: record.kind,
		blockText: block?.text ?? "",
		features: record.task === "fold_policy" ? record.features : undefined,
	};
}

function labelTemplateFor(record: ConductorTrainingRecord, labeler: ConductorLabeler): Record<string, unknown> {
	return {
		version: 1,
		recordId: record.recordId,
		task: record.task,
		rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
		labeler,
		target: outputSchemaFor(record.task),
	};
}

function instructionsFor(task: ConductorTrainingTask): string[] {
	if (task === "budget_oracle") {
		return [
			"Return exactly one JSON object matching labelTemplate.",
			"Label target.targetMultiplier, not an absolute token budget.",
			"Use the frozen rubric: prefer 1.0 unless evidence supports a safe tighter or looser target.",
			"Keep target.weight in (0, 1] and provide a concise rationale.",
		];
	}
	if (task === "fold_policy") {
		return [
			"Return exactly one JSON object matching labelTemplate.",
			"Treat labels as positive-unlabeled, not positive-negative.",
			"Predict future reuse and map it to keepScore, expectedReuseTurns, and fold level L0-L3.",
			"Use low puWeight for unlabeled blocks; only confirmed or clearly answer-bearing blocks should be positive.",
		];
	}
	return [
		"Return exactly one JSON object matching labelTemplate.",
		"Produce textual compression only; do not use soft tokens or external memory.",
		"Set mode to teacher_textual_digest only if every digest fact is grounded in blockText.",
		"Preserve exact paths, commands, marker values, errors, and decisions in fidelityLabels.",
	];
}

function outputSchemaFor(task: ConductorTrainingTask): Record<string, unknown> {
	if (task === "budget_oracle") {
		return {
			targetMultiplier: "number > 0",
			weight: "number in (0, 1]",
			rationale: "string",
		};
	}
	if (task === "fold_policy") {
		return {
			label: "positive | unlabeled",
			keepScore: "number in [0, 1]",
			expectedReuseTurns: "number >= 0",
			level: "0 | 1 | 2 | 3",
			puWeight: "number in (0, 1]",
			rationale: "string",
		};
	}
	return {
		mode: "teacher_textual_digest",
		digest: "string grounded in blockText",
		fidelityGate: true,
		fidelityLabels: {
			paths: "string[]",
			commands: "string[]",
			errors: "string[]",
			exactValues: "string[]",
			decisions: "string[]",
		},
		rationale: "string",
	};
}

function scenarioBlockLookup(): Map<string, ContextBlock> {
	const map = new Map<string, ContextBlock>();
	for (const scenario of buildScenarios()) {
		const parsed = parseMessages(scenario.messages);
		for (const block of parsed.blocks) {
			map.set(`${scenario.name}:${block.id}`, block);
		}
	}
	return map;
}

function parseTasks(value: string | undefined): ConductorTrainingTask[] | undefined {
	if (!value) return undefined;
	const tasks = value.split(",").map((item) => item.trim()).filter(Boolean) as ConductorTrainingTask[];
	for (const task of tasks) {
		if (!TASKS.includes(task)) throw new Error(`Unsupported task: ${task}`);
	}
	return tasks;
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

function numericFlag(argv: string[], name: string): number | undefined {
	const value = stringFlag(argv, name);
	return value === undefined ? undefined : Number(value);
}

function main(): void {
	const argv = process.argv.slice(2);
	const outFile = stringFlag(argv, "out", DEFAULT_OUT)!;
	const labeler = stringFlag(argv, "labeler", DEFAULT_LABELER)! as ConductorLabeler;
	const limit = numericFlag(argv, "limit");
	const tasks = parseTasks(stringFlag(argv, "tasks"));
	const jobs = buildConductorTeacherLabelJobs(undefined, { tasks, limit, labeler });
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, serializeConductorTeacherLabelJobs(jobs));
	process.stdout.write(`Wrote ${outFile} with ${jobs.length} teacher label jobs\n`);
	process.stdout.write(`${JSON.stringify({
		tasks: tasks ?? TASKS,
		labeler,
		limit,
	}, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
