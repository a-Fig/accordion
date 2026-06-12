import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	CONDUCTOR_LABELING_RUBRIC_VERSION,
	DEFAULT_CONDUCTOR_TRAINING_DATA,
	buildConductorTrainingRecords,
	parseConductorTrainingJsonl,
	type ConductorTrainingRecord,
	type ConductorTrainingTask,
} from "./conductor-training-data.ts";

export interface LabelAuditTaskSummary {
	checked: number;
	agreements: number;
	agreement: number;
}

export interface LabelAuditDisagreement {
	recordId: string;
	task: ConductorTrainingTask;
	reason: "label_mismatch" | "missing_exported_record" | "unexpected_exported_record";
	actual?: unknown;
	expected?: unknown;
}

export interface LabelAuditReport {
	rubricVersion: string;
	records: number;
	duplicateRecords: number;
	checkedRecords: number;
	agreements: number;
	agreement: number;
	byTask: Record<ConductorTrainingTask, LabelAuditTaskSummary>;
	disagreements: LabelAuditDisagreement[];
}

export interface LabelAuditOptions {
	allowExtraTeacherRecords?: boolean;
}

const TASKS: ConductorTrainingTask[] = ["budget_oracle", "fold_policy", "compression"];

export function auditConductorTrainingLabels(
	exportedRecords: ConductorTrainingRecord[],
	duplicateRecords = buildConductorTrainingRecords(),
	options: LabelAuditOptions = {},
): LabelAuditReport {
	const exportedById = new Map(exportedRecords.map((record) => [record.recordId, record]));
	const duplicateById = new Map(duplicateRecords.map((record) => [record.recordId, record]));
	const byTask = Object.fromEntries(TASKS.map((task) => [task, { checked: 0, agreements: 0, agreement: 0 }])) as LabelAuditReport["byTask"];
	const disagreements: LabelAuditDisagreement[] = [];
	let checkedRecords = 0;
	let agreements = 0;

	for (const expected of duplicateRecords) {
		const actual = exportedById.get(expected.recordId);
		if (!actual) {
			disagreements.push({
				recordId: expected.recordId,
				task: expected.task,
				reason: "missing_exported_record",
				expected: labelFingerprint(expected),
			});
			continue;
		}
		checkedRecords++;
		byTask[expected.task].checked++;
		const actualLabel = labelFingerprint(actual);
		const expectedLabel = labelFingerprint(expected);
		if (stableJson(actualLabel) === stableJson(expectedLabel)) {
			agreements++;
			byTask[expected.task].agreements++;
		} else {
			disagreements.push({
				recordId: expected.recordId,
				task: expected.task,
				reason: "label_mismatch",
				actual: actualLabel,
				expected: expectedLabel,
			});
		}
	}

	for (const actual of exportedRecords) {
		if (duplicateById.has(actual.recordId)) continue;
		if (options.allowExtraTeacherRecords && actual.labeler.startsWith("teacher:")) continue;
		disagreements.push({
			recordId: actual.recordId,
			task: actual.task,
			reason: "unexpected_exported_record",
			actual: labelFingerprint(actual),
		});
	}

	for (const task of TASKS) {
		const summary = byTask[task];
		summary.agreement = round(summary.checked === 0 ? 0 : summary.agreements / summary.checked);
	}
	return {
		rubricVersion: CONDUCTOR_LABELING_RUBRIC_VERSION,
		records: exportedRecords.length,
		duplicateRecords: duplicateRecords.length,
		checkedRecords,
		agreements,
		agreement: round(checkedRecords === 0 ? 0 : agreements / checkedRecords),
		byTask,
		disagreements,
	};
}

function labelFingerprint(record: ConductorTrainingRecord): unknown {
	const base = {
		task: record.task,
		rubricVersion: record.rubricVersion,
		rubricPath: record.rubricPath,
		source: record.source,
		split: record.split,
		scenario: record.scenario,
		category: record.category,
		probe: record.probe,
		labeler: record.labeler,
	};
	if (record.task === "budget_oracle") {
		return {
			...base,
			features: normalizeNumberRecord(record.features),
			target: normalizeValue(record.target),
		};
	}
	if (record.task === "fold_policy") {
		return {
			...base,
			blockId: record.blockId,
			blockHash: record.blockHash,
			contentHash: record.contentHash,
			turn: record.turn,
			kind: record.kind,
			features: normalizeNumberRecord(record.features),
			target: normalizeValue(record.target),
		};
	}
	return {
		...base,
		blockId: record.blockId,
		blockHash: record.blockHash,
		contentHash: record.contentHash,
		turn: record.turn,
		kind: record.kind,
		target: normalizeValue(record.target),
	};
}

function normalizeNumberRecord(record: Record<string, number>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(record)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => [key, round(value)]),
	);
}

function normalizeValue(value: unknown): unknown {
	if (typeof value === "number") return round(value);
	if (Array.isArray(value)) return value.map(normalizeValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, nested]) => [key, normalizeValue(nested)]),
		);
	}
	return value;
}

function stableJson(value: unknown): string {
	return JSON.stringify(normalizeValue(value));
}

function round(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function numericFlag(argv: string[], name: string): number | undefined {
	const value = argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
	return value === undefined ? undefined : Number(value);
}

function main(): void {
	const argv = process.argv.slice(2);
	const dataFile = argv.find((arg) => arg.startsWith("--data="))?.split("=")[1] ?? DEFAULT_CONDUCTOR_TRAINING_DATA;
	const outFile = argv.find((arg) => arg.startsWith("--out="))?.split("=")[1] ?? "docs/conductor-label-audit.json";
	const minAgreement = numericFlag(argv, "min-agreement") ?? 1;
	const maxDisagreements = numericFlag(argv, "max-disagreements") ?? 0;
	const exported = parseConductorTrainingJsonl(readFileSync(dataFile, "utf8"));
	const report = auditConductorTrainingLabels(exported, undefined, {
		allowExtraTeacherRecords: argv.includes("--allow-extra-teacher-records"),
	});
	writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(`Results written to ${outFile}\n`);
	process.stdout.write(`${JSON.stringify({
		records: report.records,
		duplicateRecords: report.duplicateRecords,
		checkedRecords: report.checkedRecords,
		agreement: report.agreement,
		byTask: report.byTask,
		disagreements: report.disagreements.length,
	}, null, 2)}\n`);

	if (report.agreement < minAgreement) {
		process.stderr.write(`LABEL AUDIT FAILED: agreement ${report.agreement} < required ${minAgreement}\n`);
		process.exitCode = 1;
	}
	if (report.disagreements.length > maxDisagreements) {
		process.stderr.write(`LABEL AUDIT FAILED: disagreements ${report.disagreements.length} > allowed ${maxDisagreements}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
