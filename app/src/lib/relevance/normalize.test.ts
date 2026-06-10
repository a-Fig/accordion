import { describe, it, expect } from "vitest";
import { rankNormalize, minMaxNormalize } from "./normalize";

// Floating point comparison helper
const close = (a: number | null, b: number | null, tol = 1e-9): boolean => {
	if (a === null && b === null) return true;
	if (a === null || b === null) return false;
	return Math.abs(a - b) < tol;
};

describe("rankNormalize", () => {
	it("returns empty for empty input", () => {
		expect(rankNormalize([])).toEqual([]);
	});

	it("single non-null element → 1", () => {
		expect(rankNormalize([42])).toEqual([1]);
	});

	it("all null → all null", () => {
		expect(rankNormalize([null, null, null])).toEqual([null, null, null]);
	});

	it("worst = 0, best = 1 for two elements", () => {
		const out = rankNormalize([3, 10]);
		expect(out[0]).toBe(0); // 3 is worst
		expect(out[1]).toBe(1); // 10 is best
	});

	it("nulls stay null in mixed input", () => {
		const out = rankNormalize([null, 5, null, 10]);
		expect(out[0]).toBeNull();
		expect(out[2]).toBeNull();
		expect(out[3]).toBe(1); // 10 is best
		expect(out[1]).toBe(0); // 5 is worst (only two non-null)
	});

	it("ties share mean rank", () => {
		// [5, 5, 10]: ranks of 5s = 1,2 → mean = 1.5; rank of 10 = 3
		// normalized: (1.5-1)/(3-1) = 0.25 for 5s; (3-1)/(3-1) = 1 for 10
		const out = rankNormalize([5, 5, 10]);
		expect(close(out[0], 0.25)).toBe(true);
		expect(close(out[1], 0.25)).toBe(true);
		expect(close(out[2], 1)).toBe(true);
	});

	it("all equal → all map to same rank → output is uniform", () => {
		// n=3 equal values. sorted ranks 1,2,3 → mean=2 → norm = (2-1)/(3-1) = 0.5
		const out = rankNormalize([7, 7, 7]);
		expect(close(out[0]!, out[1]!)).toBe(true);
		expect(close(out[1]!, out[2]!)).toBe(true);
	});

	it("three distinct values correctly ordered", () => {
		const out = rankNormalize([10, 30, 20]);
		expect(out[1]).toBe(1); // 30 is best
		expect(out[0]).toBe(0); // 10 is worst
		// 20 is middle: rank 2, norm = (2-1)/(3-1) = 0.5
		expect(close(out[2]!, 0.5)).toBe(true);
	});

	it("output values are in [0, 1]", () => {
		const raw = [null, 1, 5, 3, null, 2, 4];
		const out = rankNormalize(raw);
		for (const v of out) {
			if (v !== null) {
				expect(v).toBeGreaterThanOrEqual(0);
				expect(v).toBeLessThanOrEqual(1);
			}
		}
	});
});

describe("minMaxNormalize", () => {
	it("returns empty for empty input", () => {
		expect(minMaxNormalize([])).toEqual([]);
	});

	it("all null → all null", () => {
		expect(minMaxNormalize([null, null])).toEqual([null, null]);
	});

	it("single element maps to 1", () => {
		expect(minMaxNormalize([42])).toEqual([1]);
	});

	it("min → 0, max → 1", () => {
		const out = minMaxNormalize([0, 100]);
		expect(out[0]).toBe(0);
		expect(out[1]).toBe(1);
	});

	it("all equal → all 1", () => {
		expect(minMaxNormalize([5, 5, 5])).toEqual([1, 1, 1]);
	});

	it("preserves nulls in mixed input", () => {
		const out = minMaxNormalize([null, 0, 50, null, 100]);
		expect(out[0]).toBeNull();
		expect(out[3]).toBeNull();
		expect(out[1]).toBe(0);
		expect(close(out[2]!, 0.5)).toBe(true);
		expect(out[4]).toBe(1);
	});

	it("output in [0,1] for general input", () => {
		const raw = [null, -10, 0, 5, 10, null];
		const out = minMaxNormalize(raw);
		for (const v of out) {
			if (v !== null) {
				expect(v).toBeGreaterThanOrEqual(0);
				expect(v).toBeLessThanOrEqual(1);
			}
		}
	});
});
