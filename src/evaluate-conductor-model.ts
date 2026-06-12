import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConductorModelAuthority } from "./conductor-model-authority.ts";
import {
	accordionContext,
	buildScenarios,
	compactContext,
} from "./compare-compact.ts";
import {
	createTransformersEmbeddingProvider,
	estTokens,
	parseConductorModelArtifact,
	type AgentMessage,
	type ConductorModelAuthority,
	type ConductorModelArtifact,
	type EmbeddingProvider,
} from "./conductor.ts";

interface StrategyScore {
	score: number;
	tokens: number;
	withinBudget: boolean;
	hasAnswer: boolean;
}

interface ComparisonCell {
	scenario: string;
	category: "exact" | "semantic";
	budget: number;
	heuristic: StrategyScore;
	learned: StrategyScore;
	compact: StrategyScore;
}

interface ConversationDelta {
	scenario: string;
	category: "exact" | "semantic";
	cells: number;
	heuristicScore: number;
	learnedScore: number;
	compactScore: number;
	heuristicTokens: number;
	learnedTokens: number;
	learnedQualityDelta: number;
	learnedTokenDelta: number;
}

interface BootstrapSummary {
	iterations: number;
	mean: number;
	lower95: number;
	upper95: number;
	probabilityNonNegative: number;
}

interface EvaluationSummary {
	conversations: number;
	cells: number;
	heuristicScore: number;
	learnedScore: number;
	compactScore: number;
	learnedQualityDelta: number;
	learnedTokenDelta: number;
	learnedWins: number;
	heuristicWins: number;
	ties: number;
	tokenRegressionConversations: number;
	learnedBudgetViolations: number;
	heuristicBudgetViolations: number;
	compactBudgetViolations: number;
	bootstrapQualityDelta: BootstrapSummary;
	bootstrapTokenDelta: BootstrapSummary;
}

type Scenario = ReturnType<typeof buildScenarios>[number];

const DEFAULT_OUT = "docs/conductor-model-evaluation.json";
const DEFAULT_ARTIFACT = "models/conductor-local-v1.json";
const DEFAULT_BUDGETS = [1_500, 2_500, 4_000];

function textOf(messages: AgentMessage[]): string {
	return messages.map((message) => {
		const content = (message as any).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content.map((part) => part.text ?? part.thinking ?? JSON.stringify(part)).join("\n");
	}).join("\n");
}

function tokensOf(messages: AgentMessage[]): number {
	return messages.reduce((sum, message) => sum + estTokens(textOf([message])) + 4, 0);
}

function scoreContext(messages: AgentMessage[], scenario: Scenario, budget: number): StrategyScore {
	const lower = textOf(messages).toLowerCase();
	const hasAnswer = [scenario.key, ...(scenario.aliases ?? [])].some((key) => lower.includes(key.toLowerCase()));
	const tokens = tokensOf(messages);
	return {
		score: tokens <= budget && hasAnswer ? 1 : 0,
		tokens,
		withinBudget: tokens <= budget,
		hasAnswer,
	};
}

export function summarizeCells(cells: ComparisonCell[], iterations = 1_000): {
	summary: EvaluationSummary;
	conversations: ConversationDelta[];
} {
	const byScenario = new Map<string, ComparisonCell[]>();
	for (const cell of cells) {
		byScenario.set(cell.scenario, [...(byScenario.get(cell.scenario) ?? []), cell]);
	}
	const conversations = [...byScenario.entries()].map(([scenario, scenarioCells]): ConversationDelta => {
		const mean = (selector: (cell: ComparisonCell) => number) =>
			scenarioCells.reduce((sum, cell) => sum + selector(cell), 0) / Math.max(1, scenarioCells.length);
		const heuristicScore = mean((cell) => cell.heuristic.score);
		const learnedScore = mean((cell) => cell.learned.score);
		const compactScore = mean((cell) => cell.compact.score);
		const heuristicTokens = mean((cell) => cell.heuristic.tokens);
		const learnedTokens = mean((cell) => cell.learned.tokens);
		return {
			scenario,
			category: scenarioCells[0].category,
			cells: scenarioCells.length,
			heuristicScore,
			learnedScore,
			compactScore,
			heuristicTokens,
			learnedTokens,
			learnedQualityDelta: learnedScore - heuristicScore,
			learnedTokenDelta: heuristicTokens - learnedTokens,
		};
	});
	const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
	const learnedQualityDelta = mean(conversations.map((item) => item.learnedQualityDelta));
	const learnedTokenDelta = mean(conversations.map((item) => item.learnedTokenDelta));
	return {
		conversations,
		summary: {
			conversations: conversations.length,
			cells: cells.length,
			heuristicScore: round(mean(conversations.map((item) => item.heuristicScore))),
			learnedScore: round(mean(conversations.map((item) => item.learnedScore))),
			compactScore: round(mean(conversations.map((item) => item.compactScore))),
			learnedQualityDelta: round(learnedQualityDelta),
			learnedTokenDelta: round(learnedTokenDelta),
			learnedWins: conversations.filter((item) => item.learnedQualityDelta > 0).length,
			heuristicWins: conversations.filter((item) => item.learnedQualityDelta < 0).length,
			ties: conversations.filter((item) => item.learnedQualityDelta === 0).length,
			tokenRegressionConversations: conversations.filter((item) => item.learnedTokenDelta < 0).length,
			learnedBudgetViolations: cells.filter((cell) => !cell.learned.withinBudget).length,
			heuristicBudgetViolations: cells.filter((cell) => !cell.heuristic.withinBudget).length,
			compactBudgetViolations: cells.filter((cell) => !cell.compact.withinBudget).length,
			bootstrapQualityDelta: bootstrapMean(conversations.map((item) => item.learnedQualityDelta), iterations),
			bootstrapTokenDelta: bootstrapMean(conversations.map((item) => item.learnedTokenDelta), iterations),
		},
	};
}

export function bootstrapMean(values: number[], iterations = 1_000): BootstrapSummary {
	if (values.length === 0) {
		return { iterations, mean: 0, lower95: 0, upper95: 0, probabilityNonNegative: 0 };
	}
	let seed = 0x12345678;
	const samples: number[] = [];
	for (let i = 0; i < iterations; i++) {
		let sum = 0;
		for (let j = 0; j < values.length; j++) {
			seed = (1664525 * seed + 1013904223) >>> 0;
			sum += values[seed % values.length];
		}
		samples.push(sum / values.length);
	}
	samples.sort((a, b) => a - b);
	return {
		iterations,
		mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
		lower95: round(samples[Math.floor(samples.length * 0.025)] ?? 0),
		upper95: round(samples[Math.floor(samples.length * 0.975)] ?? 0),
		probabilityNonNegative: round(samples.filter((sample) => sample >= 0).length / samples.length),
	};
}

async function evaluate(input: {
	scenarios: Scenario[];
	budgets: number[];
	embeddingProvider?: EmbeddingProvider;
	artifact?: ConductorModelArtifact;
	authority?: ConductorModelAuthority;
	iterations: number;
}): Promise<{ cells: ComparisonCell[]; conversations: ConversationDelta[]; summary: EvaluationSummary }> {
	const cells: ComparisonCell[] = [];
	for (const scenario of input.scenarios) {
		for (const budget of input.budgets) {
			const heuristicMessages = await accordionContext(
				scenario.messages,
				scenario.probe,
				budget,
				input.embeddingProvider,
				false,
			);
			const learnedMessages = await accordionContext(
				scenario.messages,
				scenario.probe,
				budget,
				input.embeddingProvider,
				true,
				input.artifact,
				input.authority,
			);
			const compactMessages = compactContext(scenario.messages, budget);
			const cell = {
				scenario: scenario.name,
				category: scenario.category,
				budget,
				heuristic: scoreContext(heuristicMessages, scenario, budget),
				learned: scoreContext(learnedMessages, scenario, budget),
				compact: scoreContext(compactMessages, scenario, budget),
			};
			cells.push(cell);
			process.stderr.write(
				`${scenario.name} budget=${budget} heuristic=${cell.heuristic.score} ` +
				`learned=${cell.learned.score} compact=${cell.compact.score} ` +
				`tokens(${cell.heuristic.tokens}/${cell.learned.tokens}/${cell.compact.tokens})\n`,
			);
		}
	}
	return { cells, ...summarizeCells(cells, input.iterations) };
}

function assertGates(summary: EvaluationSummary, argv: string[]): string[] {
	const failures: string[] = [];
	const minConversations = numericFlag(argv, "min-conversations");
	const minLearnedScore = numericFlag(argv, "min-learned-score");
	const minQualityDelta = numericFlag(argv, "min-quality-delta");
	const minTokenDelta = numericFlag(argv, "min-token-delta");
	const minQualityNonnegative = numericFlag(argv, "min-quality-nonnegative-probability");
	const maxHeuristicWins = numericFlag(argv, "max-heuristic-wins");
	const maxTokenRegressionConversations = numericFlag(argv, "max-token-regression-conversations");
	const maxBudgetViolations = numericFlag(argv, "max-budget-violations");

	if (minConversations !== undefined && summary.conversations < minConversations) {
		failures.push(`Conversations ${summary.conversations} < required ${minConversations}`);
	}
	if (minLearnedScore !== undefined && summary.learnedScore < minLearnedScore) {
		failures.push(`Learned score ${summary.learnedScore} < required ${minLearnedScore}`);
	}
	if (minQualityDelta !== undefined && summary.learnedQualityDelta < minQualityDelta) {
		failures.push(`Learned quality delta ${summary.learnedQualityDelta} < required ${minQualityDelta}`);
	}
	if (minTokenDelta !== undefined && summary.learnedTokenDelta < minTokenDelta) {
		failures.push(`Learned token delta ${summary.learnedTokenDelta} < required ${minTokenDelta}`);
	}
	if (
		minQualityNonnegative !== undefined &&
		summary.bootstrapQualityDelta.probabilityNonNegative < minQualityNonnegative
	) {
		failures.push(
			`Bootstrap P(quality delta >= 0) ${summary.bootstrapQualityDelta.probabilityNonNegative} < required ${minQualityNonnegative}`,
		);
	}
	if (maxHeuristicWins !== undefined && summary.heuristicWins > maxHeuristicWins) {
		failures.push(`Heuristic wins ${summary.heuristicWins} > allowed ${maxHeuristicWins}`);
	}
	if (
		maxTokenRegressionConversations !== undefined &&
		summary.tokenRegressionConversations > maxTokenRegressionConversations
	) {
		failures.push(
			`Token-regression conversations ${summary.tokenRegressionConversations} > allowed ${maxTokenRegressionConversations}`,
		);
	}
	if (maxBudgetViolations !== undefined && summary.learnedBudgetViolations > maxBudgetViolations) {
		failures.push(`Learned budget violations ${summary.learnedBudgetViolations} > allowed ${maxBudgetViolations}`);
	}
	return failures;
}

function numericFlag(argv: string[], name: string): number | undefined {
	const value = argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
	return value === undefined ? undefined : Number(value);
}

function stringFlag(argv: string[], name: string): string | undefined {
	const inline = argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
	if (inline !== undefined) return inline;
	const index = argv.indexOf(`--${name}`);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const budgets = argv.find((arg) => arg.startsWith("--budgets="))?.split("=")[1]?.split(",").map(Number) ?? DEFAULT_BUDGETS;
	const outFile = stringFlag(argv, "out") ?? DEFAULT_OUT;
	const artifactFile = stringFlag(argv, "model-artifact") ?? DEFAULT_ARTIFACT;
	const authorityFile = stringFlag(argv, "model-authority");
	const scenarioFilter = stringFlag(argv, "scenario");
	const categoryFilter = stringFlag(argv, "category");
	const iterations = numericFlag(argv, "bootstrap-iterations") ?? 1_000;
	const withEmbeddings = argv.includes("--embeddings");
	const artifact = parseConductorModelArtifact(readFileSync(artifactFile, "utf8"));
	const authority = loadConductorModelAuthority({ artifactFile, authorityFile });
	const embeddingProvider = withEmbeddings ? await createTransformersEmbeddingProvider() : undefined;
	const scenarios = buildScenarios().filter((scenario) => {
		if (scenarioFilter && scenario.name !== scenarioFilter) return false;
		if (categoryFilter && scenario.category !== categoryFilter) return false;
		return true;
	});
	const result = await evaluate({ scenarios, budgets, embeddingProvider, artifact, authority: authority.authority, iterations });
	const report = {
		meta: {
			date: new Date().toISOString(),
			budgets,
			artifactFile,
			authorityFile: authority.file,
			authorityImplicit: authority.implicit,
			embeddings: withEmbeddings,
			bootstrapUnit: "conversation",
			bootstrapIterations: iterations,
			scenarioFilter,
			categoryFilter,
		},
		summary: result.summary,
		conversations: result.conversations,
		cells: result.cells,
	};
	writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(`Results written to ${outFile}\n`);
	process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);

	const failures = assertGates(result.summary, argv);
	if (failures.length > 0) {
		for (const failure of failures) process.stderr.write(`EVALUATION GATE FAILED: ${failure}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
