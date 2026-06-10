import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface ProofSummary {
	cells: number;
	accordionScore: number;
	compactScore: number;
	accordionWinsVsCompact: number;
	compactWinsVsAccordion: number;
	tiesVsCompact: number;
	accordionBudgetViolations: number;
	compactBudgetViolations: number;
	accordionAdvantagePoints: number;
	representativeWins: Array<{
		scenario: string;
		budget: number;
		compactTokens: number;
		accordionTokens: number;
		compactAnswer?: string;
		accordionAnswer?: string;
	}>;
}

interface ComparisonReport {
	meta: Record<string, unknown>;
	retrievability: Record<string, number>;
	proofSummary: ProofSummary;
}

interface ReportInput {
	label: string;
	file: string;
	command: string;
	expectedMeta: Record<string, unknown>;
	maxAgeHours: number;
	minCells: number;
	minAdvantage: number;
	minAccordionScore: number;
	maxCompactWins: number;
	maxAccordionBudgetViolations: number;
	optional?: boolean;
}

const DEFAULT_OUT = "JUDGE_PROOF.md";

const INPUTS: ReportInput[] = [
	{
		label: "Semantic judge grid vs compact-style digest/drop",
		file: "compact-comparison-judge-semantic.json",
		command: "npm run proof:judge",
		expectedMeta: { budgets: [1500, 2500], categoryFilter: "semantic", compactMode: "deterministic", embeddings: true, withAnswers: true },
		maxAgeHours: 24,
		minCells: 6,
		minAdvantage: 50,
		minAccordionScore: 100,
		maxCompactWins: 0,
		maxAccordionBudgetViolations: 0,
	},
	{
		label: "Semantic judge grid vs model-generated compact summary",
		file: "compact-comparison-judge-llm-semantic.json",
		command: "npm run proof:judge:llm",
		expectedMeta: { budgets: [1500, 2500], categoryFilter: "semantic", compactMode: "llm", embeddings: true, withAnswers: true },
		maxAgeHours: 24,
		minCells: 6,
		minAdvantage: 50,
		minAccordionScore: 100,
		maxCompactWins: 0,
		maxAccordionBudgetViolations: 0,
	},
	{
		label: "Broad exact + semantic grid vs compact-style digest/drop",
		file: "compact-comparison-proof.json",
		command: "npm run proof:compact",
		expectedMeta: { budgets: [1500, 2500, 4000], compactMode: "deterministic", embeddings: true, withAnswers: false },
		maxAgeHours: 24,
		minCells: 30,
		minAdvantage: 20,
		minAccordionScore: 100,
		maxCompactWins: 0,
		maxAccordionBudgetViolations: 0,
	},
	{
		label: "Local-model paraphrase smoke",
		file: "compact-comparison-semantic-proof.json",
		command: "npm run proof:semantic",
		expectedMeta: {
			budgets: [1500],
			compactMode: "deterministic",
			embeddings: true,
			model: "llama3.2:3b",
			scenarioFilter: "semantic-preference-late",
			withAnswers: true,
		},
		maxAgeHours: 24,
		minCells: 1,
		minAdvantage: 100,
		minAccordionScore: 100,
		maxCompactWins: 0,
		maxAccordionBudgetViolations: 0,
	},
	{
		label: "Cloud-model paraphrase smoke",
		file: "compact-comparison-semantic-cloud-proof.json",
		command: "npm run proof:semantic:cloud",
		expectedMeta: {
			budgets: [1500],
			compactMode: "deterministic",
			embeddings: true,
			model: "minimax-m3:cloud",
			scenarioFilter: "semantic-preference-late",
			withAnswers: true,
		},
		maxAgeHours: 24,
		minCells: 1,
		minAdvantage: 100,
		minAccordionScore: 100,
		maxCompactWins: 0,
		maxAccordionBudgetViolations: 0,
	},
];

const EXTERNAL_INPUTS: ReportInput[] = [
	{
		label: "Captured host /compact semantic judge grid",
		file: "compact-comparison-judge-external-semantic.json",
		command: "npm run proof:judge:external",
		expectedMeta: { budgets: [1500, 2500], categoryFilter: "semantic", compactMode: "external", embeddings: true, withAnswers: true },
		maxAgeHours: 24,
		minCells: 6,
		minAdvantage: 50,
		minAccordionScore: 100,
		maxCompactWins: 0,
		maxAccordionBudgetViolations: 0,
		optional: true,
	},
];

function pct(score: number): string {
	return `${Math.round(score * 1000) / 10}%`;
}

function readReport(input: ReportInput): ComparisonReport | null {
	if (!existsSync(input.file)) return null;
	return JSON.parse(readFileSync(input.file, "utf8")) as ComparisonReport;
}

function compactLabel(report: ComparisonReport): string {
	return Object.keys(report.retrievability).find((key) => key !== "recency-truncation" && key !== "accordion") ?? "compact";
}

function reportDate(report: ComparisonReport): Date | null {
	const value = report.meta.date;
	if (typeof value !== "string") return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : null;
}

function reportDateLabel(report: ComparisonReport): string {
	return reportDate(report)?.toISOString() ?? "missing";
}

function scorePoints(score: number): number {
	return Math.round(score * 1000) / 10;
}

function stable(value: unknown): string {
	return JSON.stringify(value);
}

function validateMeta(input: ReportInput, report: ComparisonReport): string[] {
	const failures: string[] = [];
	for (const [key, expected] of Object.entries(input.expectedMeta)) {
		const actual = report.meta[key];
		if (stable(actual) !== stable(expected)) {
			failures.push(`${input.label}: meta.${key} ${stable(actual)} !== ${stable(expected)}`);
		}
	}
	return failures;
}

export function validateReport(input: ReportInput, report: ComparisonReport | null, now = new Date()): string[] {
	if (!report && input.optional) return [];
	if (!report) return [`Missing ${input.file}; run \`${input.command}\`.`];
	const summary = report.proofSummary;
	const failures: string[] = [];
	failures.push(...validateMeta(input, report));
	const date = reportDate(report);
	if (!date) {
		failures.push(`${input.label}: missing or invalid proof date`);
	} else {
		const ageHours = (now.getTime() - date.getTime()) / 3_600_000;
		if (ageHours > input.maxAgeHours) {
			failures.push(`${input.label}: proof age ${Math.round(ageHours * 10) / 10}h > ${input.maxAgeHours}h`);
		}
		if (ageHours < -1) {
			failures.push(`${input.label}: proof date is ${Math.round(Math.abs(ageHours) * 10) / 10}h in the future`);
		}
	}
	if (summary.cells < input.minCells) failures.push(`${input.label}: cells ${summary.cells} < ${input.minCells}`);
	if (summary.accordionAdvantagePoints < input.minAdvantage) {
		failures.push(`${input.label}: advantage ${summary.accordionAdvantagePoints}pp < ${input.minAdvantage}pp`);
	}
	if (scorePoints(summary.accordionScore) < input.minAccordionScore) {
		failures.push(`${input.label}: Accordion score ${scorePoints(summary.accordionScore)}% < ${input.minAccordionScore}%`);
	}
	if (summary.compactWinsVsAccordion > input.maxCompactWins) {
		failures.push(`${input.label}: compact wins ${summary.compactWinsVsAccordion} > ${input.maxCompactWins}`);
	}
	if (summary.accordionBudgetViolations > input.maxAccordionBudgetViolations) {
		failures.push(`${input.label}: Accordion budget violations ${summary.accordionBudgetViolations} > ${input.maxAccordionBudgetViolations}`);
	}
	return failures;
}

export function renderReport(inputs = [...INPUTS, ...EXTERNAL_INPUTS]): { markdown: string; failures: string[] } {
	const now = new Date();
	const rows = inputs.map((input) => ({ input, report: readReport(input) }));
	const available = rows.filter((row): row is { input: ReportInput; report: ComparisonReport } => row.report !== null);
	const failures = rows.flatMap((row) => validateReport(row.input, row.report, now));
	const lines = [
		"# Accordion Judge Proof",
		"",
		`Generated: ${new Date().toISOString()}`,
		"",
		"## Claim",
		"",
		"Accordion preserves buried, semantically referenced facts under tight context budgets better than compact-style summarization. The strongest current automated evidence is answer-scored: the model must answer the final prompt from each assembled context, and known decoy answers are rejected.",
		"",
		"## Current Evidence",
		"",
		"| Run | Proof date | Model | Baseline | Cells | Accordion | Baseline | Advantage | Accordion wins | Baseline wins | Accordion budget violations |",
		"| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];

	for (const { input, report } of available) {
		const summary = report.proofSummary;
		const baseline = compactLabel(report);
		const model = String(report.meta.model ?? "n/a");
		lines.push(
			`| ${input.label} | ${reportDateLabel(report)} | ${model} | ${baseline} | ${summary.cells} | ${pct(summary.accordionScore)} | ${pct(summary.compactScore)} | ${summary.accordionAdvantagePoints}pp | ${summary.accordionWinsVsCompact} | ${summary.compactWinsVsAccordion} | ${summary.accordionBudgetViolations} |`,
		);
	}

	const missing = rows.filter((row) => row.report === null && !row.input.optional).map((row) => row.input);
	if (missing.length > 0) {
		lines.push("", "## Missing Reports", "");
		for (const input of missing) lines.push(`- \`${input.file}\` from \`${input.command}\``);
	}

	const optionalMissing = rows.filter((row) => row.report === null && row.input.optional).map((row) => row.input);
	if (optionalMissing.length > 0) {
		lines.push("", "## Optional Host /compact Capture", "");
		for (const input of optionalMissing) {
			lines.push(`- Not captured yet: \`${input.file}\`. Generate captures with \`npm run compact:external-template\`, fill \`compact-captures.json\`, then run \`${input.command}\`.`);
		}
	}

	lines.push("", "## Proof Gate Status", "");
	if (failures.length === 0) {
		lines.push("All report-level proof gates passed.");
	} else {
		for (const failure of failures) lines.push(`- ${failure}`);
	}

	lines.push(
		"",
		"## Representative Failures Of Compact",
		"",
	);

	for (const { input, report } of available.slice(0, 2)) {
		const baseline = compactLabel(report);
		const wins = report.proofSummary.representativeWins.slice(0, 3);
		lines.push(`### ${input.label}`, "");
		for (const win of wins) {
			lines.push(`- \`${win.scenario}\` at budget ${win.budget}: ${baseline} ${win.compactTokens} tokens, Accordion ${win.accordionTokens} tokens.`);
			if (win.compactAnswer || win.accordionAnswer) {
				lines.push(`  - ${baseline}: ${win.compactAnswer ?? "(not answer-scored)"}`);
				lines.push(`  - Accordion: ${win.accordionAnswer ?? "(not answer-scored)"}`);
			}
		}
		lines.push("");
	}

	lines.push(
		"## Reproduce",
		"",
		"```bash",
		"npm test",
		"npm run proof:refresh",
		"```",
		"",
		"## Real /compact Capture Path",
		"",
		"```bash",
		"npm run compact:external-template",
		"# Replay each setupTranscript in the host, invoke /compact before finalPrompt, fill compact-captures.json.",
		"npm run proof:judge:external",
		"```",
		"",
		"External captures reject blank summaries by default, and generated templates keep `finalPrompt` out of `setupTranscript` so `/compact` does not see the question before evaluation.",
		"",
		"## Caveat",
		"",
		"This report proves Accordion against deterministic compact-style and local model-generated compact baselines. A judge-grade host comparison should add filled `compact-captures.json` from actual `/compact` runs and then rerun `npm run proof:judge:external`.",
		"",
	);

	return { markdown: lines.join("\n"), failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const outFile = process.argv.find((arg) => arg.startsWith("--out="))?.split("=")[1] ?? DEFAULT_OUT;
	const report = renderReport();
	writeFileSync(outFile, report.markdown);
	process.stdout.write(`Judge proof report written to ${outFile}\n`);
	if (report.failures.length > 0) {
		for (const failure of report.failures) process.stderr.write(`[FAIL] ${failure}\n`);
		process.exitCode = 1;
	}
}
