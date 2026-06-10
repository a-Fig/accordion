/*
 * extract.ts — shared identifier extractor for the Relevance Lab.
 *
 * Used by tail context construction, pure scorers (bm25, actr, graph), and the
 * eval's silver label generation. Node-safe, browser-safe.
 */
import type { Block } from "../engine/types";

// ---------------------------------------------------------------------------
// Regex patterns for each identifier class
// ---------------------------------------------------------------------------

/** Windows absolute paths: C:\path\to\file.ext */
const RE_WIN_PATH = /[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+\\)*[^\s\\/:*?"<>|]+/g;

/** Unix absolute paths: /path/to/file */
const RE_UNIX_ABS = /\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+/g;

/** Relative paths: ./foo/bar, ../foo, src/lib/foo.ts */
const RE_REL_PATH = /(?:\.{1,2}\/|[a-zA-Z0-9_-]+\/)[a-zA-Z0-9._/-]+/g;

/**
 * Camel/Pascal/snake/SCREAMING_SNAKE/kebab identifiers.
 * Must be ≥4 chars and contain an internal case change, underscore, or hyphen.
 * Plain lowercase English words (no case change / no _ / no -) do NOT match.
 */
const RE_SYMBOL =
	/(?:[A-Z][a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[a-zA-Z0-9]+[_-][a-zA-Z0-9][a-zA-Z0-9_-]*|[A-Z]{2,}[_][A-Z0-9_]*)/g;

/** Dotted/method chains: store.refold, foo.bar.baz, fn() names */
const RE_CHAIN = /[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+(?:\(\))?|[a-zA-Z_][a-zA-Z0-9_]*\(\)/g;

/** Double- or single-quoted strings, 3–60 chars inner content */
const RE_QUOTED = /["']([^"'\n\r]{3,60})["']/g;

/** Hex ids / UUIDs / numbers with units — at least 4 chars */
const RE_HEX_NUM = /(?:0x[0-9a-fA-F]{2,}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9]+[kKmMgG]|[0-9]{4,})/g;

// ---------------------------------------------------------------------------
// Basename extractor from a path string
// ---------------------------------------------------------------------------
function basename(p: string): string {
	// Handle both / and \ separators
	const parts = p.replace(/\\/g, "/").split("/");
	return parts[parts.length - 1] || "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract deduplicated, lowercase-normalized identifiers from a text string.
 *
 * Extracts:
 * - File paths (unix, windows, relative); also emits the basename separately
 * - camelCase / PascalCase / snake_case / SCREAMING_SNAKE / kebab-case symbols
 * - Dotted/method chains and `function()` call names
 * - Double- or single-quoted strings (3–60 char inner content)
 * - Hex ids / UUIDs / numbers-with-units (4+ chars)
 *
 * All identifiers are lowercased before deduplication.
 */
export function extractIdents(text: string): string[] {
	const seen = new Set<string>();

	function add(s: string): void {
		const norm = s.toLowerCase().trim();
		if (norm.length >= 3) seen.add(norm);
	}

	// --- file paths (win, unix, relative) ---
	for (const m of text.matchAll(RE_WIN_PATH)) {
		add(m[0]);
		const bn = basename(m[0]);
		if (bn) add(bn);
	}
	for (const m of text.matchAll(RE_UNIX_ABS)) {
		add(m[0]);
		const bn = basename(m[0]);
		if (bn) add(bn);
	}
	for (const m of text.matchAll(RE_REL_PATH)) {
		// Filter out false positives that are just "version/numbers" etc.
		const s = m[0];
		if (/[./]/.test(s)) {
			add(s);
			const bn = basename(s);
			if (bn) add(bn);
		}
	}

	// --- symbols (camel, snake, screaming, kebab) ---
	for (const m of text.matchAll(RE_SYMBOL)) {
		if (m[0].length >= 4) add(m[0]);
	}

	// --- dotted chains and call names ---
	for (const m of text.matchAll(RE_CHAIN)) {
		add(m[0]);
		// Also add each component
		const parts = m[0].replace(/\(\)$/, "").split(".");
		for (const p of parts) {
			if (p.length >= 4) add(p);
		}
	}

	// --- quoted strings ---
	for (const m of text.matchAll(RE_QUOTED)) {
		const inner = m[1].trim();
		if (inner.length >= 3 && inner.length <= 60) add(inner);
	}

	// --- hex ids / UUIDs / numbers with units ---
	// Numbers-with-units (e.g. "20k") may be 3 chars; plain digit runs need 4+.
	// The regex captures three classes: 0x... UUIDs, number+unit, and 4+ digit runs.
	// We apply the 4-char floor only to plain digit runs (already encoded in the regex).
	for (const m of text.matchAll(RE_HEX_NUM)) {
		if (m[0].length >= 3) add(m[0]);
	}

	return [...seen];
}

/**
 * Count how many blocks in `blocks[0, endBlock)` contain each identifier.
 * Returns a Map<ident, count> for IDF / distinctiveness calculations.
 */
export function identCounts(blocks: Block[], endBlock: number): Map<string, number> {
	const counts = new Map<string, number>();
	const limit = Math.min(endBlock, blocks.length);
	for (let i = 0; i < limit; i++) {
		const idents = extractIdents(blocks[i].text);
		for (const id of idents) {
			counts.set(id, (counts.get(id) ?? 0) + 1);
		}
	}
	return counts;
}
