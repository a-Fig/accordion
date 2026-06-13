/*
 * normalize.ts — score normalization utilities for the Relevance Lab.
 *
 * Node-safe, browser-safe. No Svelte imports, no `$lib` imports.
 */

/**
 * Rank-normalize an array of raw scores to [0, 1].
 *
 * - Null values stay null (scorer abstained).
 * - Non-null values are ranked: best score = 1, worst = 0.
 * - Ties share the mean of their would-be ranks (fractional rank averaging).
 * - Single non-null element → 1.
 * - All-null input → all null.
 * - All-equal non-null input → all 0.5 (shared mean rank of all items).
 */
export function rankNormalize(raw: (number | null)[]): (number | null)[] {
	if (!raw.length) return [];

	// Extract non-null values with their original indices.
	const entries: Array<{ idx: number; val: number }> = [];
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] !== null) entries.push({ idx: i, val: raw[i] as number });
	}

	if (!entries.length) return raw.map(() => null);

	if (entries.length === 1) {
		const result: (number | null)[] = raw.map(() => null);
		result[entries[0].idx] = 1;
		return result;
	}

	// Sort ascending (lower score = lower rank).
	const sorted = [...entries].sort((a, b) => a.val - b.val);

	// Assign 1-based ranks; ties share the mean rank.
	// rank ∈ [1, n] → normalized to [0, 1] as (rank - 1) / (n - 1).
	const n = sorted.length;
	const normalizedRank = new Map<number, number>(); // idx → normalized [0,1]

	let i = 0;
	while (i < sorted.length) {
		// Find the run of ties.
		let j = i;
		while (j < sorted.length && sorted[j].val === sorted[i].val) j++;
		// 1-based ranks of this tie group: i+1 .. j (inclusive)
		const meanRank = (i + 1 + j) / 2; // mean of [i+1 .. j]
		const norm = (meanRank - 1) / (n - 1);
		for (let k = i; k < j; k++) {
			normalizedRank.set(sorted[k].idx, norm);
		}
		i = j;
	}

	return raw.map((v, idx) => (v === null ? null : (normalizedRank.get(idx) ?? 0)));
}

/**
 * Min-max normalize an array of raw scores to [0, 1].
 *
 * - Null values stay null.
 * - If min === max (all equal), every non-null value maps to 1.
 */
export function minMaxNormalize(raw: (number | null)[]): (number | null)[] {
	if (!raw.length) return [];

	const vals = raw.filter((v): v is number => v !== null);
	if (!vals.length) return raw.map(() => null);

	const min = Math.min(...vals);
	const max = Math.max(...vals);
	const range = max - min;

	return raw.map((v) => {
		if (v === null) return null;
		return range === 0 ? 1 : (v - min) / range;
	});
}
