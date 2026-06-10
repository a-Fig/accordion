/** Calibration tool — not runtime code. Run to re-tune UNFOLD_RELATIVE_MARGIN / UNFOLD_SEMANTIC_FLOOR after changing embedding model or filler distribution. */

import {
	createAccordionState,
	createTransformersEmbeddingProvider,
	parseMessages,
	runConductor,
	warmEmbeddings,
} from "./conductor.ts";

import {
	NEEDLE,
	NEEDLE_RESULT_ID_PREFIX,
	NEEDLE_TURN_ID_PREFIX,
	MULTI_NEEDLES,
	PROBE_REALISTIC,
	MULTI_PROBE_REALISTIC,
	buildHaystack,
	buildMultiKeyHaystack,
} from "./benchmark-niah.ts";

// ── Sweep grid ────────────────────────────────────────────────────────────────

const MARGINS = [0.05, 0.08, 0.10, 0.12, 0.15];
const FLOORS = [0.25, 0.30, 0.35];

// Operating regime: realistic probe, varied filler, same lengths/depths/budgets as the task
const SINGLE_LENGTHS = [10_000, 20_000];
const SINGLE_DEPTHS = [0.1, 0.25, 0.5];
const MULTI_LENGTHS = [10_000, 20_000];
const BUDGETS = [0.9, 0.7];

interface SweepMetrics {
	rescuedCells: number;
	totalCells: number;
	totalFalseUnfolds: number;
}

interface GridPoint {
	margin: number;
	floor: number;
	rescueRate: number;
	falseUnfoldRate: number;
}

// ── Haystack cache (warm embeddings once per unique haystack) ─────────────────

interface WarmHaystack {
	messages: ReturnType<typeof buildHaystack>;
	embeddingCache: Record<string, number[]>;
	inputTokens: number;
	needleIds: string[];
	probe: string;
}

async function buildWarmHaystacks(embProvider: ReturnType<typeof createTransformersEmbeddingProvider>): Promise<WarmHaystack[]> {
	const haystacks: WarmHaystack[] = [];

	for (const length of SINGLE_LENGTHS) {
		for (const depth of SINGLE_DEPTHS) {
			process.stderr.write(`  warming: single ${length}k depth=${depth}…\n`);
			const probe = PROBE_REALISTIC;
			const messages = buildHaystack(depth, length, NEEDLE, probe, "varied");
			const { blocks } = parseMessages(messages);
			const state = createAccordionState();
			await warmEmbeddings(blocks, probe, embProvider, state);
			const inputTokens = blocks.reduce((s, b) => s + b.tokens, 0);
			const needleIds = blocks
				.filter((b) => b.id.startsWith(NEEDLE_RESULT_ID_PREFIX) && b.kind === "tool_result")
				.map((b) => b.id);
			haystacks.push({ messages, embeddingCache: state.embeddingCache, inputTokens, needleIds, probe });
		}
	}

	for (const length of MULTI_LENGTHS) {
		process.stderr.write(`  warming: multi ${length}…\n`);
		const probe = MULTI_PROBE_REALISTIC;
		const messages = buildMultiKeyHaystack(length, probe, "varied");
		const { blocks } = parseMessages(messages);
		const state = createAccordionState();
		await warmEmbeddings(blocks, probe, embProvider, state);
		const inputTokens = blocks.reduce((s, b) => s + b.tokens, 0);
		const needleIds = blocks
			.filter((b) => b.id.startsWith(NEEDLE_RESULT_ID_PREFIX) && b.kind === "tool_result")
			.map((b) => b.id);
		haystacks.push({ messages, embeddingCache: state.embeddingCache, inputTokens, needleIds, probe });
	}

	return haystacks;
}

// ── Per-grid-point evaluation (no Ollama — conductor only) ────────────────────

function evalGridPoint(haystacks: WarmHaystack[], margin: number, floor: number): SweepMetrics {
	// Inject margin/floor via env vars (read by runConductor at call time)
	process.env.ACCORDION_UNFOLD_MARGIN = String(margin);
	process.env.ACCORDION_UNFOLD_FLOOR = String(floor);

	const metrics: SweepMetrics = { rescuedCells: 0, totalCells: 0, totalFalseUnfolds: 0 };

	for (const hs of haystacks) {
		for (const budget of BUDGETS) {
			const budgetTokens = Math.max(100, Math.floor(hs.inputTokens * budget));
			// Fresh state per run, but share the pre-warmed embedding cache
			const state = createAccordionState({ embeddingCache: hs.embeddingCache });

			const output = runConductor(
				{ messages: hs.messages, incomingPrompt: hs.probe, lastCompletedTurn: null, budgetTokens, state },
				{},
			);

			const needleSet = new Set(hs.needleIds);
			const rescued = output.proactiveUnfolds.some((id) => needleSet.has(id));
			// Exclude paired tool_calls (a-needle-*) — they unfold with their result, not false positives.
			const falseUnfolds = output.proactiveUnfolds.filter(
				(id) => !needleSet.has(id) && !id.startsWith(NEEDLE_TURN_ID_PREFIX),
			).length;

			metrics.totalCells++;
			if (rescued) metrics.rescuedCells++;
			metrics.totalFalseUnfolds += falseUnfolds;
		}
	}

	return metrics;
}

// ── Grid rendering ────────────────────────────────────────────────────────────

function renderGrid(grid: GridPoint[]): void {
	const floorLabels = FLOORS.map((f) => `floor=${f.toFixed(2)}`);
	const colW = 16;
	const header = "             " + floorLabels.map((l) => l.padStart(colW)).join("");
	process.stdout.write("\n" + header + "\n");

	for (const margin of MARGINS) {
		const label = `margin=${margin.toFixed(2)}`.padEnd(13);
		const row = label + FLOORS.map((floor) => {
			const pt = grid.find((p) => p.margin === margin && p.floor === floor)!;
			const cell = `R:${(pt.rescueRate * 100).toFixed(0)}% F:${pt.falseUnfoldRate.toFixed(2)}`;
			return cell.padStart(colW);
		}).join("");
		process.stdout.write(row + "\n");
	}

	process.stdout.write("\nR = needle rescue rate (higher better)\n");
	process.stdout.write("F = avg false-unfolds per cell (lower better)\n");
}

function recommend(grid: GridPoint[]): GridPoint {
	// Pick: zero false-unfolds → highest rescue rate → largest margin (most conservative)
	const zeroFalse = grid.filter((p) => p.falseUnfoldRate === 0);
	const pool = zeroFalse.length > 0 ? zeroFalse : grid;
	return pool.reduce((best, cur) => {
		if (cur.rescueRate > best.rescueRate) return cur;
		if (cur.rescueRate === best.rescueRate && cur.margin > best.margin) return cur;
		return best;
	});
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	process.stdout.write("Sweep: UNFOLD_RELATIVE_MARGIN × UNFOLD_SEMANTIC_FLOOR\n");
	process.stdout.write("Regime: realistic probe, varied filler, embeddings ON\n");
	process.stdout.write(`Grid: ${MARGINS.length} margins × ${FLOORS.length} floors\n`);
	process.stdout.write(`Cells per grid point: ${(SINGLE_LENGTHS.length * SINGLE_DEPTHS.length + MULTI_LENGTHS.length) * BUDGETS.length}\n\n`);

	process.stderr.write("Building and warming haystacks…\n");
	const embProvider = createTransformersEmbeddingProvider();
	const haystacks = await buildWarmHaystacks(embProvider);
	process.stderr.write(`Warmed ${haystacks.length} haystacks.\n\n`);

	const grid: GridPoint[] = [];
	let done = 0;
	const total = MARGINS.length * FLOORS.length;

	for (const margin of MARGINS) {
		for (const floor of FLOORS) {
			const metrics = evalGridPoint(haystacks, margin, floor);
			grid.push({
				margin,
				floor,
				rescueRate: metrics.rescuedCells / Math.max(1, metrics.totalCells),
				falseUnfoldRate: metrics.totalFalseUnfolds / Math.max(1, metrics.totalCells),
			});
			done++;
			process.stderr.write(`  [${done}/${total}] margin=${margin} floor=${floor}  rescue=${metrics.rescuedCells}/${metrics.totalCells}  falseUnfolds=${metrics.totalFalseUnfolds}\n`);
		}
	}

	renderGrid(grid);

	const rec = recommend(grid);
	process.stdout.write(
		`\nRecommended: margin=${rec.margin}, floor=${rec.floor}` +
		`  (rescue=${(rec.rescueRate * 100).toFixed(0)}%, false-unfolds/cell=${rec.falseUnfoldRate.toFixed(2)})\n`,
	);

	// Clean up env vars
	delete process.env.ACCORDION_UNFOLD_MARGIN;
	delete process.env.ACCORDION_UNFOLD_FLOOR;
}

if (process.argv[1]?.endsWith("sweep-unfold.ts") || process.argv[1]?.endsWith("sweep-unfold")) {
	await main();
}
