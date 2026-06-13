/*
 * actr.test.ts — unit tests for the ACT-R base-level activation scorer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { actrScorer, D, DISTINCTIVE_DF_CAP, params } from "./actr";
import type { Block } from "../../engine/types";
import type { TickContext } from "../types";
import { parse } from "../../engine/parse";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _nextOrder = 0;

function resetOrder() {
	_nextOrder = 0;
}

function makeBlock(
	kind: Block["kind"],
	turn: number,
	text: string,
	tokens?: number,
): Block {
	const t = text || "x".repeat((tokens ?? 50) * 4);
	return {
		id: `m${turn}:p${_nextOrder}`,
		kind,
		turn,
		order: _nextOrder++,
		text: t,
		tokens: tokens ?? Math.ceil(t.length / 4) + 3,
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

/**
 * Build a context with enough "filler" blocks so that a unique ident
 * appears in only ident-containing blocks (< 25% of total).
 *
 * fillerCount extra blocks are prepended; the ident appears in 1 or 2 of
 * total (fillerCount + signalCount + tailCount) blocks.
 *
 * Returns { ctx, signalIdxOffset } where signalIdxOffset is where the
 * signal blocks start in the scored set.
 */
function makeCtxWithFiller(opts: {
	signalBlocks: Block[];
	tailBlocks: Block[];
	fillerCount: number;
}): { ctx: TickContext; signalOffset: number } {
	const fillers: Block[] = [];
	for (let i = 0; i < opts.fillerCount; i++) {
		fillers.push(makeBlock("text", i, `filler block ${i} generic content here`));
	}
	const scored = [...fillers, ...opts.signalBlocks];
	const ctx = makeCtx(scored, opts.tailBlocks);
	return { ctx, signalOffset: opts.fillerCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("actrScorer — array length and alignment", () => {
	it("returns array of length atBlock", () => {
		resetOrder();
		const scored = [
			makeBlock("user", 1, "call appendBlocks here"),
			makeBlock("text", 2, "results from appendBlocks call"),
		];
		const tail = [makeBlock("user", 3, "next user turn")];
		const ctx = makeCtx(scored, tail);
		const scores = actrScorer.score(ctx);
		expect(scores.length).toBe(2);
	});

	it("returns empty array when atBlock = 0", () => {
		resetOrder();
		const tail = [makeBlock("user", 1, "hello"), makeBlock("text", 2, "world")];
		const ctx = makeCtx([], tail);
		const scores = actrScorer.score(ctx);
		expect(scores.length).toBe(0);
	});
});

describe("actrScorer — re-mentioned block outranks unreferenced sibling", () => {
	it("block b0 with distinctive ident re-mentioned in later block outranks unmentioned b1", () => {
		resetOrder();
		// To make "myFooFunction_xyz" distinctive, we need df < 25% of endBlock.
		// Use 6 filler blocks + b0 (has ident) + b1 (no ident) + b2 (re-mention) + tail
		// = 10 total. ident in b0 and b2 → df=2/10=20% < 25% → distinctive.
		const b0 = makeBlock("text", 7, "call myFooFunction_xyz here in this step");
		const b1 = makeBlock("text", 7, "unrelated text about something else entirely");
		const b2 = makeBlock("text", 9, "myFooFunction_xyz is called again now");
		const tail = [makeBlock("user", 10, "final turn prompt here")];

		const { ctx, signalOffset } = makeCtxWithFiller({
			signalBlocks: [b0, b1, b2],
			tailBlocks: tail,
			fillerCount: 6,
		});

		const scores = actrScorer.score(ctx);
		const s0 = scores[signalOffset]!;     // b0: creation + re-mention
		const s1 = scores[signalOffset + 1]!; // b1: creation only

		// b0 has creation (turn 7) + re-mention from b2 (turn 9) → two events
		// b1 has creation (turn 7) only → one event
		expect(s0).toBeGreaterThan(s1);
	});

	it("multiple re-mentions give even higher activation", () => {
		resetOrder();
		// accordionStore_test appears in b0 + 3 re-mention blocks = 4 total
		// Need total blocks > 4/0.25 = 16 → use 14 fillers + b0 + b1 + b2+b3+b4 = 19 scored + tail = 20
		const b0 = makeBlock("text", 15, "accordionStore_test initialization here");
		const b1 = makeBlock("text", 15, "something completely different here");
		const b2 = makeBlock("text", 17, "accordionStore_test usage in component");
		const b3 = makeBlock("text", 19, "accordionStore_test updated with new data");
		const b4 = makeBlock("text", 21, "accordionStore_test final state check");
		const tail = [makeBlock("user", 25, "user prompt here")];

		// b0+b2+b3+b4 = 4 blocks with ident, 14 fillers+b1+tail = 16 without
		// total = 20, df = 4/20 = 20% < 25% → distinctive
		const { ctx, signalOffset } = makeCtxWithFiller({
			signalBlocks: [b0, b1, b2, b3, b4],
			tailBlocks: tail,
			fillerCount: 14,
		});

		const scores = actrScorer.score(ctx);
		const s0 = scores[signalOffset]!;
		const s1 = scores[signalOffset + 1]!;

		// b0 has creation + 3 re-mentions → clearly outscores b1 (creation only)
		expect(s0).toBeGreaterThan(s1);
	});
});

describe("actrScorer — more recent re-mention > ancient re-mention", () => {
	it("block re-mentioned recently scores higher than block re-mentioned long ago", () => {
		resetOrder();
		// b0: re-mentioned at turn 9 (recent, Δt=1 from currentTurn=10)
		// b1: re-mentioned at turn 2 (ancient, Δt=8 from currentTurn=10)
		// Both created at turn 1.
		// Each ident appears in 2 out of many blocks → need df < 25% of total.
		// 14 fillers + b0 + b1 + recentMention + ancientMention = 18 scored + tail = 19 total
		// Each ident in 2 blocks → 2/19 ≈ 10.5% < 25% → distinctive

		const b0 = makeBlock("text", 1, "recentMention_alpha usage here");
		const b1 = makeBlock("text", 1, "ancientMention_beta usage here");
		const recentMention = makeBlock("text", 9, "recentMention_alpha is referenced again");
		const ancientMention = makeBlock("text", 2, "ancientMention_beta referenced early on");
		const tail = [makeBlock("user", 10, "user prompt at turn 10")];

		const { ctx, signalOffset } = makeCtxWithFiller({
			signalBlocks: [b0, b1, recentMention, ancientMention],
			tailBlocks: tail,
			fillerCount: 14,
		});

		const scores = actrScorer.score(ctx);
		const s0 = scores[signalOffset]!;     // b0: creation(t=1) + recent re-mention(t=9)
		const s1 = scores[signalOffset + 1]!; // b1: creation(t=1) + ancient re-mention(t=2)

		// currentTurn = 10
		// b0: sum = (10-1+1)^-0.5 + (10-9+1)^-0.5 = (10)^-0.5 + (2)^-0.5 ≈ 0.316 + 0.707 = 1.023
		// b1: sum = (10-1+1)^-0.5 + (10-2+1)^-0.5 = (10)^-0.5 + (9)^-0.5 ≈ 0.316 + 0.333 = 0.650
		// b0 wins: ln(1.023) > ln(0.650)
		expect(s0).toBeGreaterThan(s1);
	});

	it("power law: reference at Δt=1 weighs more than at Δt=9", () => {
		// With d=0.5: (1+1)^-0.5 = 0.707; (9+1)^-0.5 = 0.316
		// So recent > ancient contribution.
		const near = Math.pow(1 + 1, -D);
		const far = Math.pow(9 + 1, -D);
		expect(near).toBeGreaterThan(far);
	});
});

describe("actrScorer — common (non-distinctive) idents create no extra events", () => {
	it("ident present in >= 25% of blocks does not generate re-mention events", () => {
		resetOrder();
		// Make "commonword_ident" appear in 4 out of 8 blocks = 50% → not distinctive.
		// b4 (scored signal) also mentions it but gets NO re-mention events from b0-b3.
		// b5 (noise) never mentions it.
		// Both b4 and b5 created at same turn → similar scores (no dramatic gap).
		const scored: Block[] = [];
		// 4 blocks mentioning commonword_ident
		for (let i = 0; i < 4; i++) {
			scored.push(makeBlock("text", i, `commonword_ident is used in block ${i}`));
		}
		// b4: also mentions commonword_ident — but no re-mentions AFTER b4 in scored
		scored.push(makeBlock("text", 4, "commonword_ident reference here in signal"));
		// b5: unrelated
		scored.push(makeBlock("text", 4, "something else entirely unique here now"));

		const tail = [makeBlock("user", 10, "user message is here")];
		const ctx = makeCtx(scored, tail);
		const scores = actrScorer.score(ctx);

		// Both b4 and b5 have only their creation event
		// (commonword_ident is not distinctive, so earlier blocks don't count as re-mentions)
		// → finite, not null
		expect(scores[4]).not.toBeNull();
		expect(scores[5]).not.toBeNull();
		expect(Number.isFinite(scores[4]!)).toBe(true);
		expect(Number.isFinite(scores[5]!)).toBe(true);
		// Scores should be similar (both creation-only from same turn)
		expect(Math.abs(scores[4]! - scores[5]!)).toBeLessThan(0.01);
	});

	it("distinctive threshold: ident in exactly 1 of 5 blocks (20% < 25%) IS distinctive", () => {
		// df = 1/5 = 0.20 < 0.25 → should be distinctive
		const threshold = DISTINCTIVE_DF_CAP;
		expect(1 / 5).toBeLessThan(threshold);
	});

	it("non-distinctive threshold: ident in 2 of 5 blocks (40% >= 25%) is NOT distinctive", () => {
		const threshold = DISTINCTIVE_DF_CAP;
		expect(2 / 5).toBeGreaterThanOrEqual(threshold);
	});
});

describe("actrScorer — creation-only baseline is finite", () => {
	it("a block with no re-mentions still gets a finite score", () => {
		resetOrder();
		const b0 = makeBlock("text", 1, "unique-content-xyz-nobody-echoes");
		const tail = [makeBlock("user", 5, "different content here")];
		const ctx = makeCtx([b0], tail);
		const [s0] = actrScorer.score(ctx);

		expect(s0).not.toBeNull();
		expect(Number.isFinite(s0!)).toBe(true);
		expect(Number.isNaN(s0!)).toBe(false);
	});

	it("creation event gives positive activation (not -Infinity)", () => {
		resetOrder();
		const b = makeBlock("text", 3, "uniqueIdentifierNobodyEchoes here alone");
		const tail = [makeBlock("user", 10, "prompt")];
		const ctx = makeCtx([b], tail);
		const [s] = actrScorer.score(ctx);

		// activation = ln((Δt+1)^(-d)) = ln((7+1)^(-0.5)) = -0.5 * ln(8) ≈ -1.04
		// → negative but finite and > -Infinity
		expect(s!).toBeGreaterThan(-Infinity);
		expect(Number.isFinite(s!)).toBe(true);
	});
});

describe("actrScorer — postings correctness with shared idents", () => {
	it("two blocks sharing a distinctive ident: earlier block gets re-mention event from later", () => {
		// b0 and b1 share "sharedDistinct_fn". ident appears in 2 out of 10+ blocks → < 25% → distinctive.
		// b0 (earlier) gets a re-mention event from b1 (later).
		// b1 has no later re-mentions.
		// Need total blocks > 2/0.25 = 8 → use 10 fillers + b0 + b1 = 12 scored + tail = 13 total
		// df = 2/13 ≈ 15.4% < 25% → distinctive ✓
		resetOrder();
		const b0 = makeBlock("text", 11, "sharedDistinct_fn is called here");
		const b1 = makeBlock("text", 13, "sharedDistinct_fn invoked in b1 block");
		const tail = [makeBlock("user", 20, "completely different prompt content here")];

		const { ctx, signalOffset } = makeCtxWithFiller({
			signalBlocks: [b0, b1],
			tailBlocks: tail,
			fillerCount: 10,
		});

		const scores = actrScorer.score(ctx);
		const s0 = scores[signalOffset]!;
		const s1 = scores[signalOffset + 1]!;

		// b0 has creation (turn 11) + re-mention from b1 (turn 13) → two events
		// b1 has creation (turn 13) only → one event
		// currentTurn ≈ 20. b0 sum = (20-11+1)^-0.5 + (20-13+1)^-0.5 = (10)^-0.5 + (8)^-0.5
		// b1 sum = (20-13+1)^-0.5 = (8)^-0.5
		// b0 sum > b1 sum → b0 wins
		expect(s0).toBeGreaterThan(s1);
	});

	it("postings from tail blocks also count as re-mentions for scored blocks", () => {
		// b0 has a distinctive ident re-mentioned in the tail block.
		// b1 has no re-mentions.
		// Need df < 25% of endBlock (includes tail in endBlock).
		// 10 fillers + b0 + b1 + tailBlock = 13 total. ident in b0 and tailBlock = 2/13 ≈ 15% < 25% ✓
		resetOrder();
		const b0 = makeBlock("text", 11, "tailMentioned_func is defined here");
		const b1 = makeBlock("text", 11, "something entirely different here now");
		const tailBlock = makeBlock("user", 15, "tailMentioned_func is used in this tail");

		const { ctx, signalOffset } = makeCtxWithFiller({
			signalBlocks: [b0, b1],
			tailBlocks: [tailBlock],
			fillerCount: 10,
		});

		const scores = actrScorer.score(ctx);
		const s0 = scores[signalOffset]!;
		const s1 = scores[signalOffset + 1]!;

		// b0 gets a re-mention from the tail block → should outscore b1
		expect(s0).toBeGreaterThan(s1);
	});
});

describe("actrScorer — params export", () => {
	it("exports d and distinctiveDfCap", () => {
		expect(params.d).toBe(D);
		expect(params.distinctiveDfCap).toBe(DISTINCTIVE_DF_CAP);
	});

	it("D is 0.5", () => {
		expect(D).toBe(0.5);
	});

	it("DISTINCTIVE_DF_CAP is 0.25", () => {
		expect(DISTINCTIVE_DF_CAP).toBe(0.25);
	});
});

describe("actrScorer — real sample session (no NaN/Infinity, sensible spread)", () => {
	it("scores all blocks with finite values and non-trivial spread on sample slice", () => {
		const samplePath = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../../../static/sample-session.jsonl",
		);
		const raw = readFileSync(samplePath, "utf-8");
		const { blocks } = parse(raw);

		// Slice of 200 blocks, tail = last 40, scored = first 160
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

		const scores = actrScorer.score(ctx);
		expect(scores.length).toBe(atBlock);

		for (const s of scores) {
			expect(s).not.toBeNull();
			expect(Number.isFinite(s!)).toBe(true);
			expect(Number.isNaN(s!)).toBe(false);
		}

		// Verify spread: there should be meaningful variation (re-mentions vs none)
		const nonNull = scores.filter((s) => s !== null) as number[];
		const max = Math.max(...nonNull);
		const min = Math.min(...nonNull);
		// The highest-activation block should be noticeably higher than the lowest
		expect(max).toBeGreaterThan(min);
		// At least some blocks have higher activation than pure creation-event baseline
		// (i.e., range > 0 means spread exists)
		expect(max - min).toBeGreaterThan(0);
	});

	it("both recency and actr produce no NaN/Infinity on the full sample", async () => {
		// Import recency scorer inline to test both together
		const { recencyScorer } = await import("./recency");

		const samplePath = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../../../static/sample-session.jsonl",
		);
		const raw = readFileSync(samplePath, "utf-8");
		const { blocks } = parse(raw);

		// Use a representative slice near the middle of the session
		const mid = Math.floor(blocks.length / 2);
		const slice = blocks.slice(0, mid);
		const atBlock = Math.floor(mid * 0.8);
		const endBlock = mid;

		const ctx: TickContext = {
			blocks: slice,
			endBlock,
			atBlock,
			tailText: slice.slice(atBlock).map((b) => b.text).join("\n\n"),
			tailIdents: [],
		};

		for (const scorer of [recencyScorer, actrScorer]) {
			const scores = scorer.score(ctx);
			expect(scores.length).toBe(atBlock);
			for (const s of scores) {
				if (s !== null) {
					expect(Number.isFinite(s)).toBe(true);
					expect(Number.isNaN(s)).toBe(false);
				}
			}
		}
	});
});
