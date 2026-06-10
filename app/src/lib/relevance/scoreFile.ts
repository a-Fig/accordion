/*
 * scoreFile.ts — score file helpers for the Relevance Lab.
 *
 * Structural validation, empty tick construction, and merging scorer results.
 * Node-safe, browser-safe. No Svelte imports, no `$lib` imports.
 */
import type { ScoreFile, TickScores, TickContext, ScorerId, ScorerMeta } from "./types";

/**
 * Validate that `json` is a structurally valid ScoreFile (version 1).
 * Returns the typed object or null if invalid.
 */
export function validateScoreFile(json: unknown): ScoreFile | null {
	if (typeof json !== "object" || json === null) return null;
	const obj = json as Record<string, unknown>;
	if (obj["version"] !== 1) return null;
	if (typeof obj["sessionId"] !== "string") return null;
	if (typeof obj["generatedAt"] !== "string") return null;
	if (!Array.isArray(obj["ticks"])) return null;
	for (const tick of obj["ticks"] as unknown[]) {
		if (typeof tick !== "object" || tick === null) return null;
		const t = tick as Record<string, unknown>;
		if (typeof t["tick"] !== "number") return null;
		if (typeof t["endBlock"] !== "number") return null;
		if (typeof t["atBlock"] !== "number") return null;
		if (!Array.isArray(t["blockIds"])) return null;
		if (typeof t["scorers"] !== "object" || t["scorers"] === null) return null;
		if (typeof t["scores"] !== "object" || t["scores"] === null) return null;
		// Each scores array must have length === blockIds.length to avoid mis-zipping.
		const blockIds = t["blockIds"] as unknown[];
		const scores = t["scores"] as Record<string, unknown>;
		for (const arr of Object.values(scores)) {
			if (Array.isArray(arr) && arr.length !== blockIds.length) return null;
		}
	}
	return json as ScoreFile;
}

/**
 * Construct an empty TickScores for a tick context.
 * blockIds is set to the ids of blocks [0, atBlock) in order.
 */
export function emptyTick(ctx: TickContext, tick: number): TickScores {
	const blockIds = ctx.blocks
		.slice(0, ctx.atBlock)
		.map((b) => b.id);
	return {
		tick,
		endBlock: ctx.endBlock,
		atBlock: ctx.atBlock,
		blockIds,
		scorers: {},
		scores: {},
	};
}

/**
 * Merge a scorer's result into an existing TickScores entry (mutates in place).
 */
export function mergeScorerResult(
	tickScores: TickScores,
	id: ScorerId,
	meta: Omit<ScorerMeta, "id">,
	scores: (number | null)[],
): void {
	tickScores.scorers[id] = meta;
	tickScores.scores[id] = scores;
}
