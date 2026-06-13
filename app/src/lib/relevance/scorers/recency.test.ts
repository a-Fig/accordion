/*
 * recency.test.ts — unit tests for the Recency×Kind pure scorer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { recencyScorer, kindPrior, HALF_LIFE, params } from "./recency";
import type { Block } from "../../engine/types";
import type { TickContext } from "../types";
import { parse } from "../../engine/parse";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _nextOrder = 0;

function makeBlock(
	kind: Block["kind"],
	turn: number,
	tokens = 100,
	text = "",
): Block {
	return {
		id: `m${turn}:p${_nextOrder}`,
		kind,
		turn,
		order: _nextOrder++,
		text: text || "x".repeat(tokens * 4),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeCtx(scoredBlocks: Block[], tailBlocks: Block[]): TickContext {
	const blocks = [...scoredBlocks, ...tailBlocks];
	const atBlock = scoredBlocks.length;
	const endBlock = blocks.length;
	return {
		blocks,
		endBlock,
		atBlock,
		tailText: tailBlocks.map((b) => b.text).join("\n\n"),
		tailIdents: [],
	};
}

// Reset order counter between describe blocks
function resetOrder() {
	_nextOrder = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recencyScorer — array length and alignment", () => {
	it("returns array of length atBlock", () => {
		resetOrder();
		const scored = [makeBlock("user", 1), makeBlock("text", 2)];
		const tail = [makeBlock("user", 3)];
		const ctx = makeCtx(scored, tail);
		const scores = recencyScorer.score(ctx);
		expect(scores.length).toBe(2);
	});

	it("returns empty array when atBlock = 0", () => {
		resetOrder();
		const tail = [makeBlock("user", 1), makeBlock("text", 2)];
		const ctx = makeCtx([], tail);
		const scores = recencyScorer.score(ctx);
		expect(scores.length).toBe(0);
	});

	it("no null values — returns real scores everywhere", () => {
		resetOrder();
		const scored = [
			makeBlock("user", 1),
			makeBlock("text", 2),
			makeBlock("thinking", 3),
			makeBlock("tool_call", 4),
			makeBlock("tool_result", 5),
		];
		const tail = [makeBlock("user", 6)];
		const ctx = makeCtx(scored, tail);
		const scores = recencyScorer.score(ctx);
		for (const s of scores) {
			expect(s).not.toBeNull();
		}
	});
});

describe("recencyScorer — newer > older same kind", () => {
	it("a more recent text block scores higher than an older one", () => {
		resetOrder();
		const older = makeBlock("text", 1);
		const newer = makeBlock("text", 10);
		const tail = [makeBlock("user", 15)];
		const ctx = makeCtx([older, newer], tail);
		const [sOlder, sNewer] = recencyScorer.score(ctx);
		expect(sNewer).toBeGreaterThan(sOlder!);
	});

	it("a block in the same turn as the current tail boundary scores highest", () => {
		resetOrder();
		const old = makeBlock("text", 1);
		const recent = makeBlock("text", 10);
		// tail block at turn 10 — currentTurn = 10
		const tail = [makeBlock("user", 10)];
		const ctx = makeCtx([old, recent], tail);
		const [sOld, sRecent] = recencyScorer.score(ctx);
		// recent has turnsSince=0, old has turnsSince=9
		expect(sRecent).toBeGreaterThan(sOld!);
	});
});

describe("recencyScorer — kind ordering at equal turn", () => {
	it("user > text > tool_call > thinking > tool_result at equal turns", () => {
		resetOrder();
		const turn = 5;
		const blocks = [
			makeBlock("user", turn),
			makeBlock("text", turn),
			makeBlock("tool_call", turn),
			makeBlock("thinking", turn),
			makeBlock("tool_result", turn),
		];
		const tail = [makeBlock("user", 10)];
		const ctx = makeCtx(blocks, tail);
		const [sUser, sText, sCall, sThink, sResult] = recencyScorer.score(ctx);

		expect(sUser).toBeGreaterThan(sText!);
		expect(sText).toBeGreaterThan(sCall!);
		expect(sCall).toBeGreaterThan(sThink!);
		expect(sThink).toBeGreaterThan(sResult!);
	});

	it("kind priors match exported kindPrior table", () => {
		resetOrder();
		// score(b) at turnsSince=0 → exp(0) = 1 → score = prior exactly
		const kinds: Block["kind"][] = ["user", "text", "tool_call", "thinking", "tool_result"];
		const blocks = kinds.map((k) => makeBlock(k, 5));
		const tail = [makeBlock("user", 5)]; // same turn → currentTurn = 5
		const ctx = makeCtx(blocks, tail);
		const scores = recencyScorer.score(ctx);

		for (let i = 0; i < kinds.length; i++) {
			const expected = kindPrior[kinds[i]];
			expect(scores[i]).toBeCloseTo(expected, 10);
		}
	});
});

describe("recencyScorer — half-life behavior", () => {
	it("score at HALF_LIFE turns ago is ~50% of same-kind score at turn 0", () => {
		resetOrder();
		const blocks = [
			makeBlock("text", 0),   // HALF_LIFE turns ago
			makeBlock("text", HALF_LIFE), // current turn
		];
		// currentTurn = HALF_LIFE (tail block's turn)
		const tail = [makeBlock("user", HALF_LIFE)];
		const ctx = makeCtx(blocks, tail);
		const [sOld, sNew] = recencyScorer.score(ctx);

		// sOld / sNew should be ~0.5 (one half-life of decay)
		const ratio = sOld! / sNew!;
		expect(ratio).toBeCloseTo(0.5, 5);
	});

	it("scores are all positive", () => {
		resetOrder();
		const blocks = Array.from({ length: 20 }, (_, i) => makeBlock("text", i));
		const tail = [makeBlock("user", 30)];
		const ctx = makeCtx(blocks, tail);
		const scores = recencyScorer.score(ctx);
		for (const s of scores) {
			expect(s!).toBeGreaterThan(0);
		}
	});

	it("score monotonically decreases for older blocks of same kind", () => {
		resetOrder();
		const blocks = Array.from({ length: 10 }, (_, i) =>
			makeBlock("thinking", i)
		);
		const tail = [makeBlock("user", 20)];
		const ctx = makeCtx(blocks, tail);
		const scores = recencyScorer.score(ctx) as number[];

		for (let i = 1; i < scores.length; i++) {
			// each block is 1 turn older than the next → monotonically decreasing
			expect(scores[i]).toBeGreaterThan(scores[i - 1]);
		}
	});
});

describe("recencyScorer — params export", () => {
	it("params includes halfLife", () => {
		expect(params.halfLife).toBe(HALF_LIFE);
	});

	it("params includes kindPrior", () => {
		expect(params.kindPrior).toBe(kindPrior);
	});
});

describe("recencyScorer — real sample session (no NaN/Infinity, sensible spread)", () => {
	it("scores all blocks with finite values and non-trivial spread on sample slice", () => {
		// Load a slice of the real sample — node:fs is allowed in TEST files.
		const samplePath = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../../../static/sample-session.jsonl",
		);
		const raw = readFileSync(samplePath, "utf-8");
		const { blocks } = parse(raw);

		// Use the first 200 blocks; tail = last 20 scored blocks is overkill — use
		// a simple 80/20 split over the slice.
		const slice = blocks.slice(0, 200);
		const atBlock = 160;
		const endBlock = 200;

		const ctx: TickContext = {
			blocks: slice,
			endBlock,
			atBlock,
			tailText: slice.slice(atBlock).map((b) => b.text).join("\n\n"),
			tailIdents: [],
		};

		const scores = recencyScorer.score(ctx);
		expect(scores.length).toBe(atBlock);

		for (const s of scores) {
			expect(s).not.toBeNull();
			expect(Number.isFinite(s!)).toBe(true);
			expect(Number.isNaN(s!)).toBe(false);
		}

		// Verify spread: max should be noticeably higher than min
		const nonNull = scores.filter((s) => s !== null) as number[];
		const max = Math.max(...nonNull);
		const min = Math.min(...nonNull);
		expect(max).toBeGreaterThan(min * 1.5); // at least 50% spread
	});
});
