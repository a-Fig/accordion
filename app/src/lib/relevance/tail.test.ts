import { describe, it, expect } from "vitest";
import { computeProtectedFromIndex, sampleTicks, DEFAULT_PROTECT_TOKENS } from "./tail";
import type { Block } from "../engine/types";

function blks(tokens: number[]): { tokens: number }[] {
	return tokens.map((t) => ({ tokens: t }));
}

function makeBlocks(kindSeq: Array<{ kind: Block["kind"]; tokens: number }>): Block[] {
	return kindSeq.map((b, i) => ({
		id: `m${i}:p0`,
		kind: b.kind,
		turn: i,
		order: i,
		text: "x".repeat(b.tokens * 4),
		tokens: b.tokens,
		override: null,
		autoFolded: false,
		by: null,
	}));
}

describe("computeProtectedFromIndex", () => {
	it("returns 0 for empty array", () => {
		expect(computeProtectedFromIndex([], 1000)).toBe(0);
	});

	it("returns blocks.length when protectTokens is 0 (protection disabled)", () => {
		expect(computeProtectedFromIndex(blks([100, 200, 300]), 0)).toBe(3);
	});

	it("protects the single newest block even if it alone exceeds target", () => {
		// newest block = 50k tokens; target = 20k → still protect it (index 2)
		const blocks = blks([1000, 1000, 50_000]);
		expect(computeProtectedFromIndex(blocks, 20_000)).toBe(2);
	});

	it("returns blocks.length - 1 when newest block exactly meets target", () => {
		// newest block tokens >= protectTokens → protectedFromIndex = last index
		const blocks = blks([500, 500, 20_000]);
		expect(computeProtectedFromIndex(blocks, 20_000)).toBe(2);
	});

	it("stops before a block that would push past the overflow cap", () => {
		// target=10k, cap=12.5k. newest=5k (sum=5k<10k). next older=8k → 5+8=13k > 12.5k → stop
		const blocks = blks([8000, 5000]);
		const idx = computeProtectedFromIndex(blocks, 10_000, 1.25);
		// sum=5k < 10k but next=13k > 12.5k cap → return 1
		expect(idx).toBe(1);
	});

	it("absorbs exactly the overflow cap edge: sum + next == cap is allowed", () => {
		// target=10k, cap=12.5k. newest=6k, next=6k → 12k < 12.5k → include
		const blocks = blks([6000, 6000]);
		const idx = computeProtectedFromIndex(blocks, 10_000, 1.25);
		expect(idx).toBe(0);
	});

	it("returns 0 when entire session fits under protect target", () => {
		const blocks = blks([100, 200, 300]); // total 600 << 20000
		expect(computeProtectedFromIndex(blocks, 20_000)).toBe(0);
	});

	it("protects exact boundary block where sum crosses target", () => {
		// target=3000. blocks=[500, 500, 500, 1000, 1200]
		// walk back: sum=1200 (i=4), sum=2200 (i=3), sum=2700 (i=2) < 3000, sum=3200 >= 3000 → return 1
		const blocks = blks([500, 500, 500, 1000, 1200]);
		expect(computeProtectedFromIndex(blocks, 3000)).toBe(1);
	});

	it("DEFAULT_PROTECT_TOKENS is 20000", () => {
		expect(DEFAULT_PROTECT_TOKENS).toBe(20_000);
	});
});

describe("sampleTicks", () => {
	it("returns empty when blocks.length < 30", () => {
		const blocks = makeBlocks(Array.from({ length: 20 }, () => ({ kind: "text" as const, tokens: 100 })));
		expect(sampleTicks(blocks)).toEqual([]);
	});

	it("always includes the final tick (blocks.length)", () => {
		const blocks = makeBlocks([
			...Array.from({ length: 40 }, () => ({ kind: "text" as const, tokens: 100 })),
		]);
		const ticks = sampleTicks(blocks);
		expect(ticks).toContain(blocks.length);
	});

	it("result is ascending and deduplicated", () => {
		// Create a session with user blocks scattered through it
		const kinds: Array<{ kind: Block["kind"]; tokens: number }> = [];
		for (let i = 0; i < 100; i++) {
			kinds.push({ kind: i % 10 === 0 ? "user" : "text", tokens: 100 });
		}
		const blocks = makeBlocks(kinds);
		const ticks = sampleTicks(blocks);
		for (let i = 1; i < ticks.length; i++) {
			expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
		}
	});

	it("returns at most maxTicks ticks", () => {
		// Many user blocks → many candidates
		const kinds: Array<{ kind: Block["kind"]; tokens: number }> = [];
		for (let i = 0; i < 300; i++) {
			kinds.push({ kind: i % 5 === 0 ? "user" : "text", tokens: 100 });
		}
		const blocks = makeBlocks(kinds);
		const ticks = sampleTicks(blocks, 5);
		expect(ticks.length).toBeLessThanOrEqual(5 + 1); // maxTicks + possible final
		// But always includes the last
		expect(ticks).toContain(blocks.length);
	});

	it("skips candidate prefixes shorter than 30 blocks", () => {
		// user at index 5 (prefix=5 < 30), user at index 50 (prefix=50 >= 30)
		const kinds: Array<{ kind: Block["kind"]; tokens: number }> = [
			{ kind: "user", tokens: 100 }, // index 0 — skipped (index 0 doesn't make a candidate before it)
			...Array.from({ length: 4 }, () => ({ kind: "text" as const, tokens: 100 })),
			{ kind: "user", tokens: 100 }, // index 5, endBlock=5 < 30 → skipped
			...Array.from({ length: 44 }, () => ({ kind: "text" as const, tokens: 100 })),
			{ kind: "user", tokens: 100 }, // index 50, endBlock=50 >= 30 → included
			...Array.from({ length: 49 }, () => ({ kind: "text" as const, tokens: 100 })),
		];
		const blocks = makeBlocks(kinds);
		const ticks = sampleTicks(blocks);
		// endBlock=5 should NOT appear
		expect(ticks).not.toContain(5);
		// endBlock=50 should appear
		expect(ticks).toContain(50);
		// final tick
		expect(ticks).toContain(blocks.length);
	});

	it("no duplicates even when final tick == last candidate", () => {
		// If the last user block is the very last block, endBlock and blocks.length may collide.
		const kinds: Array<{ kind: Block["kind"]; tokens: number }> = [
			...Array.from({ length: 50 }, () => ({ kind: "text" as const, tokens: 100 })),
			{ kind: "user", tokens: 100 }, // index 50, endBlock=50
		];
		const blocks = makeBlocks(kinds);
		const ticks = sampleTicks(blocks);
		// blocks.length = 51; endBlock of the last user block = 50 (distinct)
		const unique = new Set(ticks);
		expect(unique.size).toBe(ticks.length);
	});
});
