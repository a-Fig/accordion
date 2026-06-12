import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CONDUCTOR_LABELING_RUBRIC_VERSION,
	DEFAULT_CONDUCTOR_TRAINING_DATA,
	parseConductorTrainingJsonl,
	serializeConductorTrainingRecords,
	validateConductorTrainingRecord,
	type ConductorLabeler,
	type ConductorTrainingRecord,
	type ConductorTrainingTask,
} from "./conductor-training-data.ts";

export interface ConductorTeacherLabel {
	version: 1;
	recordId: string;
	task: ConductorTrainingTask;
	rubricVersion: string;
	labeler: ConductorLabeler;
	target: unknown;
}

export interface TeacherLabelImportReport {
	baseRecords: number;
	teacherLabels: number;
	importedRecords: number;
	outputRecords: number;
	byTask: Record<ConductorTrainingTask, number>;
}

const TASKS: ConductorTrainingTask[] = ["budget_oracle", "fold_policy", "compression"];
const DEFAULT_TEACHER_LABELS = "data/conductor-teacher-labels.jsonl";
const DEFAULT_OUT = "data/conductor-training-teacher.jsonl";

export function parseConductorTeacherLabels(input: string): ConductorTeacherLabel[] {
	const labels: ConductorTeacherLabel[] = [];
	for (const [index, line] of input.split(/\r?\n/).entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const label = JSON.parse(trimmed) as ConductorTeacherLabel;
		validateTeacherLabel(label, index + 1);
		labels.push(label);
	}
	return labels;
}

export function importConductorTeacherLabels(
	baseRecords: ConductorTrainingRecord[],
	teacherLabels: ConductorTeacherLabel[],
): { records: ConductorTrainingRecord[]; report: TeacherLabelImportReport } {
	const baseById = new Map(baseRecords.map((record) => [record.recordId, record]));
	const seen = new Set<string>();
	const imported: ConductorTrainingRecord[] = [];
	const byTask = Object.fromEntries(TASKS.map((task) => [task, 0])) as Record<ConductorTrainingTask, number>;

	for (const [index, label] of teacherLabels.entries()) {
		const duplicateKey = `${label.recordId}:${label.labeler}`;
		if (seen.has(duplicateKey)) {
			throw new Error(`Teacher label line ${index + 1} duplicates ${duplicateKey}`);
		}
		seen.add(duplicateKey);
		const base = baseById.get(label.recordId);
		if (!base) throw new Error(`Teacher label line ${index + 1} references unknown recordId ${label.recordId}`);
		if (base.task !== label.task) {
			throw new Error(`Teacher label line ${index + 1} task ${label.task} does not match base task ${base.task}`);
		}
		const record = {
			...structuredClone(base),
			recordId: `${base.recordId}:teacher:${shortHash(label.labeler)}`,
			labeler: label.labeler,
			target: label.target,
		} as ConductorTrainingRecord;
		validateConductorTrainingRecord(record, index + 1);
		imported.push(record);
		byTask[record.task]++;
	}

	const records = [...baseRecords, ...imported];
	return {
		records,
		report: {
			baseRecords: baseRecords.length,
			teacherLabels: teacherLabels.length,
			importedRecords: imported.length,
			outputRecords: records.length,
			byTask,
		},
	};
}

function validateTeacherLabel(label: ConductorTeacherLabel, line: number): void {
	if (label.version !== 1) throw new Error(`Teacher label line ${line} has unsupported version`);
	if (label.rubricVersion !== CONDUCTOR_LABELING_RUBRIC_VERSION) {
		throw new Error(`Teacher label line ${line} uses unsupported rubric ${label.rubricVersion}`);
	}
	if (!TASKS.includes(label.task)) throw new Error(`Teacher label line ${line} has unsupported task`);
	if (!/^teacher:[A-Za-z0-9_.-]+$/.test(label.labeler)) {
		throw new Error(`Teacher label line ${line} must use a teacher:* labeler`);
	}
	if (!label.recordId || typeof label.recordId !== "string") {
		throw new Error(`Teacher label line ${line} has invalid recordId`);
	}
	if (!label.target || typeof label.target !== "object") {
		throw new Error(`Teacher label line ${line} has invalid target`);
	}
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
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

function numericFlag(argv: string[], name: string): number | undefined {
	const inline = argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
	if (inline !== undefined) return Number(inline);
	const index = argv.indexOf(`--${name}`);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	return value && !value.startsWith("--") ? Number(value) : undefined;
}

function main(): void {
	const argv = process.argv.slice(2);
	const baseFile = stringFlag(argv, "base", DEFAULT_CONDUCTOR_TRAINING_DATA);
	const teacherFile = stringFlag(argv, "teacher-labels", DEFAULT_TEACHER_LABELS);
	const outFile = stringFlag(argv, "out", DEFAULT_OUT);
	const minTeacherRecords = numericFlag(argv, "min-teacher-records") ?? 1;
	const baseRecords = parseConductorTrainingJsonl(readFileSync(baseFile, "utf8"));
	const teacherLabels = parseConductorTeacherLabels(readFileSync(teacherFile, "utf8"));
	const { records, report } = importConductorTeacherLabels(baseRecords, teacherLabels);
	if (report.importedRecords < minTeacherRecords) {
		throw new Error(`Imported teacher records ${report.importedRecords} < required ${minTeacherRecords}`);
	}
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, serializeConductorTrainingRecords(records));
	process.stdout.write(`Wrote ${outFile}\n`);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
