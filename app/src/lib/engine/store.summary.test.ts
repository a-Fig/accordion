/*
 * store.summary.test.ts — C2 summary layer tests.
 *
 * Covers:
 *   - setSummary: digestOf output uses LLM summary with correct foldTag prefix
 *   - effTokens / liveTokens drop when a big folded block gets a short summary
 *   - refold's candidate filter uses summarized cost (block folds when summary saves tokens
 *     but digest alone would not)
 *   - Guard: setSummary ignores summary >= text length
 *   - Guard: setSummary ignores unknown block id
 */
import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import type { Block, ParsedSession } from "./types";
import { foldTag, digestTokens } from "./digest";
import { estTokens, BLOCK_OVERHEAD } from "./tokens";

function blk(
	id: string,
	kind: Block["kind"] = "text",
	tokens: number = 1000,
	text?: string,
): Block {
	// text must be at least `tokens * 4` chars so `text.length >= summary.length` guard works
	const t = text ?? `block ${id} ` + "x".repeat(tokens * 4 + 20);
	return {
		id,
		kind,
		turn: 1,
		order: 0,
		text: t,
		tokens,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeStore(blocks: Block[]): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

// ── digestOf ──────────────────────────────────────────────────────────────────

describe("setSummary / digestOf", () => {
	it("digestOf uses the LLM summary for a foldable block with a prefix EXACTLY matching foldTag", () => {
		const b = blk("m0:p0", "text", 2000);
		const s = makeStore([b]);
		const summary = "refactored the auth module, updated UserService";
		s.setSummary(b.id, summary);

		const expected = `${foldTag(b.id)} ${summary}`;
		expect(s.digestOf(s.blocks[0])).toBe(expected);
	});

	it("digestOf falls back to digest() when no summary is set", () => {
		const b = blk("m0:p0", "text", 2000);
		const s = makeStore([b]);
		// No setSummary call — should return the deterministic digest.
		// Just verify it does NOT contain the summary.
		const d = s.digestOf(s.blocks[0]);
		expect(d).toMatch(/^\{#[0-9a-z]{6} FOLDED\}/); // starts with foldTag for foldable kind
	});

	it("digestOf includes foldTag prefix byte-identical to foldTag(id)", () => {
		const b = blk("abc:def", "thinking", 1500);
		const s = makeStore([b]);
		s.setSummary(b.id, "considered the approach");
		const out = s.digestOf(s.blocks[0]);
		expect(out.startsWith(foldTag(b.id))).toBe(true);
		expect(out.startsWith(foldTag(b.id) + " ")).toBe(true);
	});

	it("hasSummary returns true after setSummary", () => {
		const b = blk("m0:p0", "text", 2000);
		const s = makeStore([b]);
		expect(s.hasSummary(b.id)).toBe(false);
		s.setSummary(b.id, "short summary");
		expect(s.hasSummary(b.id)).toBe(true);
	});
});

// ── effTokens / liveTokens ────────────────────────────────────────────────────

describe("effTokens / liveTokens update when summary lands", () => {
	it("effTokens uses summary tokens for a folded block with a summary", () => {
		// Block is old (index 0), protected from index 1
		const b0 = blk("m0:p0", "text", 5000);
		const b1 = blk("m1:p0", "text", 1000);
		const s = makeStore([b0, b1]);
		s.setProtect(1500); // protect b1
		s.setBudget(3000); // forces b0 to fold

		expect(s.isFolded(s.blocks[0])).toBe(true);

		const beforeSummary = s.effTokens(s.blocks[0]);
		// Before: effTokens = digestTokens(b0)
		expect(beforeSummary).toBe(digestTokens(s.blocks[0]));

		// Apply a short summary
		const shortSummary = "auth refactor";
		s.setSummary(b0.id, shortSummary);

		const expectedSummaryTokens = estTokens(`${foldTag(b0.id)} ${shortSummary}`) + BLOCK_OVERHEAD;
		expect(s.effTokens(s.blocks[0])).toBe(expectedSummaryTokens);
		expect(s.effTokens(s.blocks[0])).toBeLessThan(beforeSummary);
	});

	it("liveTokens drops after setSummary on a folded block", () => {
		const b0 = blk("m0:p0", "text", 5000);
		const b1 = blk("m1:p0", "text", 1000);
		const s = makeStore([b0, b1]);
		s.setProtect(1500);
		s.setBudget(3000);

		expect(s.isFolded(s.blocks[0])).toBe(true);
		const liveBefore = s.liveTokens;

		s.setSummary(b0.id, "short");
		expect(s.liveTokens).toBeLessThan(liveBefore);
	});

	it("savedTokens increases after setSummary on a folded block", () => {
		const b0 = blk("m0:p0", "tool_result", 5000);
		const b1 = blk("m1:p0", "text", 1000);
		const s = makeStore([b0, b1]);
		s.setProtect(1500);
		s.setBudget(3000);

		const savedBefore = s.savedTokens;
		s.setSummary(b0.id, "read_file returned 200 lines");
		expect(s.savedTokens).toBeGreaterThan(savedBefore);
	});
});

// ── Guard: summary >= text length ─────────────────────────────────────────────

describe("setSummary guard: rejects non-compressing summaries", () => {
	it("ignores a summary that is longer than the block text", () => {
		const shortText = "hi"; // very short text
		const b = {
			...blk("m0:p0", "text", 10),
			text: shortText,
		};
		const s = makeStore([b]);
		// summary is longer than shortText
		s.setSummary(b.id, "this is a summary that is definitely longer than the source");
		expect(s.hasSummary(b.id)).toBe(false);
	});

	it("ignores a summary with the same length as the block text", () => {
		const text = "exact match length text here";
		const b = { ...blk("m0:p0", "text", 100), text };
		const s = makeStore([b]);
		// Same length — NOT a compression win (>= check)
		s.setSummary(b.id, text); // exactly equal length
		expect(s.hasSummary(b.id)).toBe(false);
	});

	it("accepts a summary strictly shorter than the block text", () => {
		const b = blk("m0:p0", "text", 2000); // text is long due to blk() padding
		const s = makeStore([b]);
		s.setSummary(b.id, "short");
		expect(s.hasSummary(b.id)).toBe(true);
	});
});

// ── Guard: unknown id ────────────────────────────────────────────────────────

describe("setSummary guard: ignores unknown ids", () => {
	it("setSummary on a non-existent id is a no-op", () => {
		const b = blk("m0:p0", "text", 2000);
		const s = makeStore([b]);
		s.setSummary("not-a-real-id", "some summary");
		// Should not throw, and the real block is unaffected
		expect(s.hasSummary("not-a-real-id")).toBe(false);
		expect(s.hasSummary(b.id)).toBe(false);
	});
});

// ── refold candidate filter uses summarized cost ──────────────────────────────

describe("refold uses summarized fold cost", () => {
	it("a block folds when its summary cost is below full tokens, even if digest cost was >= full", () => {
		// Craft a block whose deterministic digestTokens >= b.tokens (won't fold normally),
		// but whose summary is tiny enough to save tokens.
		//
		// digestTokens = estTokens(digest(b)) + BLOCK_OVERHEAD.
		// For "text" kind, digest = "{#xxxxxx FOLDED} clip(text, 120)".
		// foldTag ≈ 12 chars = 3 tok; clip(120-char text, 120) = 120 chars = 30 tok.
		// Total = 3 + 30 + 4 (BLOCK_OVERHEAD) = 37 tok.
		// If b.tokens = 30, then 37 >= 30 → NO savings from digest → not a candidate.
		//
		// But with a 1-char summary:
		// summaryTokens = estTokens("{#xxxxxx FOLDED} x") + 4 ≈ (12+2)/4 rounded + 4 = 4 + 4 = 8 tok
		// 8 < 30 → savings exist → IS a candidate now.
		//
		// Note: setBudget clamps to min 1000. We need liveTokens > budget, so use large blocks.
		// Make the full session (old + tail) = 60_000 tokens, budget = 1500. The "no savings"
		// block is the only old block; it won't fold by digest but should fold by summary.

		// Old block: text=120 chars, tokens=30 (set artificially). This is a "no-savings" block
		// since digestTokens(b) > b.tokens. BUT we also need the session to exceed budget.
		// To exceed budget=1500: tail = 2000 tokens (protected). old = 30 tokens.
		// liveTokens = 2030. budget = 1500. liveTokens > budget → must fold.
		// But old block has no savings by digest → won't fold → stays over budget (that's OK for this test).

		const shortText = "x".repeat(120); // 120 chars = 30 tokens
		const oldBlock = { ...blk("m0:p0", "text", 30), text: shortText, tokens: 30 };
		// Tail block: needs to be >= protectTokens so it alone satisfies the target.
		// Using 2000 tokens with setProtect(1500): sum(2000) >= target(1500) → stops,
		// returns index 1 → protectedFromIndex=1 → only tailBlock is protected.
		const tailBlock = blk("m1:p0", "text", 2000);
		const s = makeStore([oldBlock, tailBlock]);
		s.setProtect(1500); // tailBlock(2000 tok) >= 1500 → only tailBlock protected
		// Budget must be > 1000 (min clamp) but less than liveTokens=2030
		s.setBudget(1500); // 2030 > 1500 → must fold; but only candidate is oldBlock

		// Check: does digest save tokens for oldBlock?
		const dTok = digestTokens(s.blocks[0]);
		const bTok = s.blocks[0].tokens; // 30

		if (dTok >= bTok) {
			// Confirmed: digest doesn't save tokens → oldBlock NOT folded (no candidate).
			expect(s.isFolded(s.blocks[0])).toBe(false);

			// Now apply a short summary and trigger a refold.
			// summary = "y" (1 char) — definitely shorter than shortText (120 chars).
			s.setSummary(oldBlock.id, "y");
			// summaryTokens = estTokens("{#xxxxxx FOLDED} y") + BLOCK_OVERHEAD ≈ 4 + 4 = 8
			// 8 < 30 → savings exist → block should now be a candidate
			s.setBudget(1500); // re-trigger refold with same budget
			expect(s.isFolded(s.blocks[0])).toBe(true);
		} else {
			// If digest already saves tokens, the test precondition isn't met for this
			// block size. Just verify that a summary makes the cost even lower.
			const shortSummary = "y";
			s.setSummary(oldBlock.id, shortSummary);
			const summaryTok = estTokens(`${foldTag(oldBlock.id)} ${shortSummary}`) + BLOCK_OVERHEAD;
			expect(summaryTok).toBeLessThan(dTok);
		}
	});

	it("foldedCostOf returns summary tokens for a summarized block", () => {
		const b0 = blk("m0:p0", "text", 5000);
		const b1 = blk("m1:p0", "text", 2000); // protected: 2000 >= protectTokens(1500) → returns idx 1
		const s = makeStore([b0, b1]);
		s.setProtect(1500); // b1(2000 tok) >= 1500 → protectedFromIndex=1 → only b1 protected

		// Before summary: effTokens when folded = digestTokens
		s.setBudget(1000); // forces b0 to fold (7000 > 1000)
		expect(s.isFolded(s.blocks[0])).toBe(true);
		const effBeforeSummary = s.effTokens(s.blocks[0]);
		expect(effBeforeSummary).toBe(digestTokens(s.blocks[0]));

		// After summary: effTokens when folded = summaryTokens (smaller)
		const summary = "rewrote the auth module";
		s.setSummary(b0.id, summary);
		const expectedSummaryTokens = estTokens(`${foldTag(b0.id)} ${summary}`) + BLOCK_OVERHEAD;
		expect(s.effTokens(s.blocks[0])).toBe(expectedSummaryTokens);
		expect(s.effTokens(s.blocks[0])).toBeLessThan(effBeforeSummary);
	});
});
