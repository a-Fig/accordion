import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CONDUCTOR_LABELING_RUBRIC_VERSION,
	type ConductorLabeler,
	type ConductorTrainingTask,
} from "./conductor-training-data.ts";
import {
	type ConductorTeacherLabelJob,
} from "./export-conductor-teacher-label-jobs.ts";
import {
	parseConductorTeacherLabels,
	type ConductorTeacherLabel,
} from "./import-conductor-teacher-labels.ts";

export interface TeacherLabelRequestOptions {
	apiKey: string;
	model: string;
	baseUrl?: string;
	labeler?: ConductorLabeler;
	rubricText?: string;
	limit?: number;
	temperature?: number;
	timeoutMs?: number;
	maxRetries?: number;
}

export interface TeacherLabelRequestReport {
	requestedJobs: number;
	labels: number;
	model: string;
	labeler: ConductorLabeler;
}

export type FetchLike = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
		signal?: AbortSignal;
	},
) => Promise<{
	ok: boolean;
	status: number;
	text(): Promise<string>;
}>;

const DEFAULT_JOBS = "data/conductor-teacher-label-jobs.jsonl";
const DEFAULT_OUT = "data/conductor-teacher-labels.jsonl";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";

export function parseConductorTeacherLabelJobs(input: string): ConductorTeacherLabelJob[] {
	const jobs: ConductorTeacherLabelJob[] = [];
	for (const [index, line] of input.split(/\r?\n/).entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const job = JSON.parse(trimmed) as ConductorTeacherLabelJob;
		validateTeacherLabelJob(job, index + 1);
		jobs.push(job);
	}
	return jobs;
}

export function serializeConductorTeacherLabels(labels: ConductorTeacherLabel[]): string {
	return `${labels.map((label) => JSON.stringify(label)).join("\n")}\n`;
}

export function teacherLabelerForModel(model: string): ConductorLabeler {
	const suffix = model.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
	return `teacher:${suffix}`;
}

export async function requestConductorTeacherLabels(
	jobs: ConductorTeacherLabelJob[],
	options: TeacherLabelRequestOptions,
	fetchImpl: FetchLike = globalThis.fetch as FetchLike,
): Promise<{ labels: ConductorTeacherLabel[]; report: TeacherLabelRequestReport }> {
	if (!fetchImpl) throw new Error("global fetch is unavailable; run with Node 18+ or inject fetchImpl");
	const labeler = options.labeler ?? teacherLabelerForModel(options.model);
	const selected = options.limit === undefined ? jobs : jobs.slice(0, options.limit);
	const labels: ConductorTeacherLabel[] = [];
	for (const job of selected) {
		labels.push(await requestOneTeacherLabel(withRuntimeLabeler(job, labeler), options, fetchImpl));
	}
	return {
		labels,
		report: {
			requestedJobs: selected.length,
			labels: labels.length,
			model: options.model,
			labeler,
		},
	};
}

export function buildTeacherLabelMessages(
	job: ConductorTeacherLabelJob,
	options: Pick<TeacherLabelRequestOptions, "rubricText"> = {},
): { role: "system" | "user"; content: string }[] {
	return [
		{
			role: "system",
			content: [
				"You are a strict Accordion Conductor teacher labeler.",
				"Return exactly one JSON object and no prose.",
				"Do not invent facts outside the supplied job input.",
				"Every returned field must match the label template shape.",
			].join("\n"),
		},
		{
			role: "user",
			content: JSON.stringify({
				rubricVersion: job.rubricVersion,
				rubricPath: job.rubricPath,
				rubricText: options.rubricText ?? "",
				jobId: job.jobId,
				recordId: job.recordId,
				task: job.task,
				requestedLabeler: job.requestedLabeler,
				instructions: job.instructions,
				input: job.input,
				outputSchema: job.outputSchema,
				labelTemplate: job.labelTemplate,
			}),
		},
	];
}

export function parseTeacherLabelResponse(job: ConductorTeacherLabelJob, responseContent: string): ConductorTeacherLabel {
	const json = extractJsonObject(responseContent);
	const [label] = parseConductorTeacherLabels(`${json}\n`);
	if (!label) throw new Error(`Teacher response for ${job.recordId} did not contain a label`);
	validateTeacherLabelMatchesJob(label, job);
	validateTeacherTarget(label);
	return label;
}

async function requestOneTeacherLabel(
	job: ConductorTeacherLabelJob,
	options: TeacherLabelRequestOptions,
	fetchImpl: FetchLike,
): Promise<ConductorTeacherLabel> {
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const maxRetries = options.maxRetries ?? 1;
	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const controller = options.timeoutMs === undefined ? undefined : new AbortController();
		const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), options.timeoutMs);
		try {
			const messages = buildTeacherLabelMessages(job, options);
			if (lastError !== undefined) {
				messages.push({
					role: "user",
					content: [
						`Previous response was rejected: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
						"Return exactly one valid JSON object matching labelTemplate. Do not use Markdown fences or unquoted keys.",
					].join("\n"),
				});
			}
			const body = {
				model: options.model,
				temperature: options.temperature ?? 0,
				response_format: { type: "json_object" },
				messages,
			};
			const response = await fetchImpl(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${options.apiKey}`,
				},
				body: JSON.stringify(body),
				signal: controller?.signal,
			});
			const text = await response.text();
			if (!response.ok) {
				throw new Error(`Teacher request for ${job.recordId} failed with ${response.status}: ${text}`);
			}
			return parseTeacherLabelResponse(job, parseChatCompletionContent(text, job.recordId));
		} catch (error) {
			lastError = error;
			if (attempt >= maxRetries) throw error;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function parseChatCompletionContent(responseText: string, recordId: string): string {
	const response = JSON.parse(responseText) as {
		choices?: Array<{ message?: { content?: unknown } }>;
	};
	const content = response.choices?.[0]?.message?.content;
	if (typeof content !== "string" || !content.trim()) {
		throw new Error(`Teacher response for ${recordId} did not include string message content`);
	}
	return content;
}

function extractJsonObject(content: string): string {
	const trimmed = content.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first < 0 || last <= first) throw new Error("Teacher response did not contain a JSON object");
	return trimmed.slice(first, last + 1);
}

function validateTeacherLabelJob(job: ConductorTeacherLabelJob, line: number): void {
	if (job.version !== 1) throw new Error(`Teacher job line ${line} has unsupported version`);
	if (job.rubricVersion !== CONDUCTOR_LABELING_RUBRIC_VERSION) {
		throw new Error(`Teacher job line ${line} uses unsupported rubric ${job.rubricVersion}`);
	}
	if (!["budget_oracle", "fold_policy", "compression"].includes(job.task)) {
		throw new Error(`Teacher job line ${line} has unsupported task`);
	}
	if (!job.recordId || typeof job.recordId !== "string") {
		throw new Error(`Teacher job line ${line} has invalid recordId`);
	}
	if (!/^teacher:[A-Za-z0-9_.-]+$/.test(job.requestedLabeler)) {
		throw new Error(`Teacher job line ${line} has invalid requestedLabeler`);
	}
	if (!job.labelTemplate || typeof job.labelTemplate !== "object") {
		throw new Error(`Teacher job line ${line} has invalid labelTemplate`);
	}
}

function validateTeacherLabelMatchesJob(label: ConductorTeacherLabel, job: ConductorTeacherLabelJob): void {
	if (label.recordId !== job.recordId) {
		throw new Error(`Teacher label recordId ${label.recordId} does not match job ${job.recordId}`);
	}
	if (label.task !== job.task) {
		throw new Error(`Teacher label task ${label.task} does not match job ${job.task}`);
	}
	if (label.labeler !== job.requestedLabeler) {
		throw new Error(`Teacher labeler ${label.labeler} does not match requested ${job.requestedLabeler}`);
	}
}

function validateTeacherTarget(label: ConductorTeacherLabel): void {
	const target = label.target as Record<string, unknown>;
	if (label.task === "budget_oracle") validateBudgetTarget(target);
	else if (label.task === "fold_policy") validateFoldTarget(target);
	else validateCompressionTarget(target);
}

function validateBudgetTarget(target: Record<string, unknown>): void {
	if (!finiteInRange(target.targetMultiplier, Number.MIN_VALUE, Infinity)) {
		throw new Error("Teacher budget target has invalid targetMultiplier");
	}
	if (!finiteInRange(target.weight, Number.MIN_VALUE, 1)) {
		throw new Error("Teacher budget target has invalid weight");
	}
	if (typeof target.rationale !== "string" || !target.rationale) {
		throw new Error("Teacher budget target has invalid rationale");
	}
}

function validateFoldTarget(target: Record<string, unknown>): void {
	if (target.label !== "positive" && target.label !== "unlabeled") {
		throw new Error("Teacher fold target has unsupported label");
	}
	if (!finiteInRange(target.keepScore, 0, 1)) {
		throw new Error("Teacher fold target has invalid keepScore");
	}
	if (!finiteInRange(target.expectedReuseTurns, 0, Infinity)) {
		throw new Error("Teacher fold target has invalid expectedReuseTurns");
	}
	if (![0, 1, 2, 3].includes(target.level as number)) {
		throw new Error("Teacher fold target has unsupported level");
	}
	if (!finiteInRange(target.puWeight, Number.MIN_VALUE, 1)) {
		throw new Error("Teacher fold target has invalid puWeight");
	}
	if (typeof target.rationale !== "string" || !target.rationale) {
		throw new Error("Teacher fold target has invalid rationale");
	}
}

function validateCompressionTarget(target: Record<string, unknown>): void {
	if (target.mode !== "teacher_textual_digest") {
		throw new Error("Teacher compression target must use teacher_textual_digest mode");
	}
	if (typeof target.digest !== "string" || !target.digest) {
		throw new Error("Teacher compression target has invalid digest");
	}
	if (target.fidelityGate !== true) {
		throw new Error("Teacher compression target has invalid fidelityGate");
	}
	const labels = target.fidelityLabels as Record<string, unknown> | undefined;
	for (const key of ["paths", "commands", "errors", "exactValues", "decisions"]) {
		const values = labels?.[key];
		if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
			throw new Error(`Teacher compression target has invalid fidelityLabels.${key}`);
		}
	}
	if (typeof target.rationale !== "string" || !target.rationale) {
		throw new Error("Teacher compression target has invalid rationale");
	}
}

function finiteInRange(value: unknown, min: number, max: number): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function withRuntimeLabeler(job: ConductorTeacherLabelJob, labeler: ConductorLabeler): ConductorTeacherLabelJob {
	return {
		...job,
		requestedLabeler: labeler,
		labelTemplate: {
			...job.labelTemplate,
			labeler,
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

function numericFlag(argv: string[], name: string): number | undefined {
	const value = stringFlag(argv, name);
	return value === undefined ? undefined : Number(value);
}

function main(): void {
	const argv = process.argv.slice(2);
	const jobsFile = stringFlag(argv, "jobs", DEFAULT_JOBS)!;
	const outFile = stringFlag(argv, "out", DEFAULT_OUT)!;
	const apiKeyEnv = stringFlag(argv, "api-key-env", DEFAULT_API_KEY_ENV)!;
	const apiKey = process.env[apiKeyEnv];
	if (!apiKey) throw new Error(`Missing ${apiKeyEnv}; export it or pass --api-key-env=<name>`);
	const model = stringFlag(argv, "model", process.env.CONDUCTOR_TEACHER_MODEL ?? process.env.OPENAI_MODEL);
	if (!model) throw new Error("Missing teacher model; pass --model=<model> or set CONDUCTOR_TEACHER_MODEL");
	const jobs = parseConductorTeacherLabelJobs(readFileSync(jobsFile, "utf8"));
	const labelerValue = stringFlag(argv, "labeler");
	const labeler = labelerValue === undefined ? undefined : labelerValue as ConductorLabeler;
	const rubricPath = stringFlag(argv, "rubric", jobs[0]?.rubricPath);
	const rubricText = rubricPath === undefined ? "" : readFileSync(rubricPath, "utf8");
	requestConductorTeacherLabels(jobs, {
		apiKey,
		model,
		baseUrl: stringFlag(argv, "base-url", process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL),
		labeler,
		rubricText,
		limit: numericFlag(argv, "limit"),
		timeoutMs: numericFlag(argv, "timeout-ms"),
		maxRetries: numericFlag(argv, "max-retries"),
	}).then(({ labels, report }) => {
		mkdirSync(dirname(outFile), { recursive: true });
		writeFileSync(outFile, serializeConductorTeacherLabels(labels));
		process.stdout.write(`Wrote ${outFile}\n`);
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
