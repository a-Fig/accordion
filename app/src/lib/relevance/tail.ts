/*
 * tail.ts — pure re-implementation of the store's protected-tail boundary.
 *
 * Mirrors AccordionStore.protectedFromIndex exactly so the lab can reproduce
 * the same tail split without touching the Svelte store. Node-safe, browser-safe.
 */
import type { Block } from "../engine/types";

export const DEFAULT_PROTECT_TOKENS = 20_000;

/**
 * Compute the first index of the protected working tail in a blocks prefix.
 *
 * Walks backward from the newest block, accumulating tokens toward `protectTokens`,
 * but refuses to pull in the next older block if doing so would exceed
 * `protectTokens * overflowCap` (default 1.25). The newest block is always
 * included even if it alone exceeds the cap.
 *
 * Special cases:
 *  - Empty array → 0
 *  - protectTokens === 0 → blocks.length (protection disabled, every block foldable)
 *
 * This is a verbatim port of AccordionStore.protectedFromIndex.
 */
export function computeProtectedFromIndex(
	blocks: { tokens: number }[],
	protectTokens: number,
	overflowCap = 1.25,
): number {
	if (!blocks.length) return 0;
	if (protectTokens === 0) return blocks.length;
	const cap = protectTokens * overflowCap;
	let sum = blocks[blocks.length - 1].tokens;
	if (sum >= protectTokens) return blocks.length - 1;
	for (let i = blocks.length - 2; i >= 0; i--) {
		const next = sum + blocks[i].tokens;
		if (next > cap) return i + 1;
		sum = next;
		if (sum >= protectTokens) return i;
	}
	return 0;
}

/**
 * Sample tick `endBlock` values for eval ticks across a session.
 *
 * Tick candidates are positions just BEFORE each `user`-kind block with index > 0
 * (i.e. `endBlock = index of the user block`), plus always the final tick
 * `endBlock = blocks.length`.
 *
 * If there are more than `maxTicks` candidates (including the final tick),
 * evenly-spaced candidates are picked while always including the last candidate
 * and the final tick. Candidates with fewer than 30 blocks are skipped.
 *
 * Returns ascending, deduplicated endBlock values.
 */
export function sampleTicks(blocks: Block[], maxTicks = 12): number[] {
	// Collect candidates: positions just before each non-first user block.
	const candidates: number[] = [];
	for (let i = 1; i < blocks.length; i++) {
		if (blocks[i].kind === "user") {
			const endBlock = i; // blocks[0..i) is the prefix up to (not including) this user block
			if (endBlock >= 30) candidates.push(endBlock);
		}
	}

	// Always add the final tick.
	const finalTick = blocks.length;
	if (!candidates.includes(finalTick) && finalTick >= 30) {
		candidates.push(finalTick);
	}

	if (!candidates.length) return finalTick >= 30 ? [finalTick] : [];

	// Ensure unique and sorted.
	const unique = [...new Set(candidates)].sort((a, b) => a - b);

	if (unique.length <= maxTicks) return unique;

	// Pick evenly spaced, always including the last one.
	const last = unique[unique.length - 1];
	const rest = unique.slice(0, -1);

	// We need maxTicks - 1 from `rest` (evenly spaced), plus the last.
	const needed = maxTicks - 1;
	const picked: number[] = [];
	for (let i = 0; i < needed; i++) {
		const idx = Math.round((i / (needed - 1 || 1)) * (rest.length - 1));
		picked.push(rest[idx]);
	}

	// Deduplicate and sort, then append last.
	const result = [...new Set(picked)].sort((a, b) => a - b);
	if (!result.includes(last)) result.push(last);
	return result.sort((a, b) => a - b);
}
