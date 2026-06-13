/*
 * context.ts — build a TickContext for a given session prefix.
 *
 * Node-safe, browser-safe. No Svelte imports, no `$lib` imports.
 */
import type { Block } from "../engine/types";
import type { TickContext } from "./types";
import { computeProtectedFromIndex, DEFAULT_PROTECT_TOKENS } from "./tail";
import { extractIdents } from "./extract";

/** Maximum tail text length in chars (newest text kept when truncating). */
const TAIL_TEXT_MAX_CHARS = 60_000;

/**
 * Build a TickContext for a session prefix `blocks.slice(0, endBlock)`.
 *
 * - Computes `atBlock` via `computeProtectedFromIndex` over the prefix.
 * - Builds `tailText` from blocks [atBlock, endBlock), joined with "\n\n",
 *   capped at 60k chars (newest text preserved when truncating).
 * - Extracts `tailIdents` from `tailText`.
 */
export function buildTickContext(
	blocks: Block[],
	endBlock: number,
	protectTokens = DEFAULT_PROTECT_TOKENS,
): TickContext {
	const limit = Math.min(endBlock, blocks.length);
	const prefix = blocks.slice(0, limit);

	const atBlock = computeProtectedFromIndex(prefix, protectTokens);

	// Build tail text from blocks [atBlock, limit).
	const tailBlocks = prefix.slice(atBlock);
	const rawTailText = tailBlocks.map((b) => b.text).join("\n\n");

	// Cap to 60k chars, keeping the NEWEST text (tail end of the string).
	const tailText =
		rawTailText.length > TAIL_TEXT_MAX_CHARS
			? rawTailText.slice(rawTailText.length - TAIL_TEXT_MAX_CHARS)
			: rawTailText;

	const tailIdents = extractIdents(tailText);

	return {
		blocks,
		endBlock: limit,
		atBlock,
		tailText,
		tailIdents,
	};
}
