/*
 * summaryCache.ts — content-addressed immutable summary cache.
 *
 * Node-safe shared module (like live/protocol.ts). No Svelte imports, no
 * browser-only APIs (except globalThis.crypto.subtle, available in Node 18+
 * and all modern webviews). Persistence is the caller's job:
 *   - Webview: Rust accordion_read_text / accordion_append_line commands.
 *   - Node scripts: direct fs reads/writes.
 *
 * Cache file convention: summaries/cache.jsonl under ~/.accordion.
 */

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Inputs that determine whether a cached summary is still valid.
 * If any of these change the cache miss must trigger a fresh generation.
 */
export interface SummaryKeyInput {
	text: string;
	kind: string;
	promptVersion: number;
	model: string;
}

/**
 * Compute a SHA-256 hex digest of the canonical serialization of the key inputs.
 * Uses globalThis.crypto.subtle (Node 18+ and all modern webviews).
 */
export async function summaryKey(input: SummaryKeyInput): Promise<string> {
	// Stable canonical form: sorted keys, no extra whitespace.
	const canonical = JSON.stringify({
		kind: input.kind,
		model: input.model,
		promptVersion: input.promptVersion,
		text: input.text,
	});
	const encoded = new TextEncoder().encode(canonical);
	const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Cache entry ───────────────────────────────────────────────────────────────

export interface CacheEntry {
	/** SHA-256 hex key (output of summaryKey). */
	key: string;
	/** The generated summary text. */
	summary: string;
	/** Block kind that was summarized. */
	kind: string;
	/** Model that generated the summary. */
	model: string;
	/** PROMPT_VERSION at time of generation. */
	promptVersion: number;
	/** Estimated tokens of the source text. */
	srcTokens: number;
	/** Estimated tokens of the summary. */
	sumTokens: number;
	/** Unix epoch ms when the entry was generated. */
	at: number;
}

// ── JSONL serialization ───────────────────────────────────────────────────────

/**
 * Parse a JSONL cache file into entries. Tolerant: bad lines (invalid JSON,
 * missing required fields) are silently skipped rather than throwing.
 */
export function parseCacheLines(text: string): CacheEntry[] {
	const entries: CacheEntry[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const obj = JSON.parse(trimmed) as unknown;
			if (!isCacheEntry(obj)) continue;
			entries.push(obj);
		} catch {
			// Skip bad lines silently.
		}
	}
	return entries;
}

/** Serialize a single entry as a JSONL line (no trailing newline). */
export function serializeEntry(e: CacheEntry): string {
	return JSON.stringify(e);
}

function isCacheEntry(v: unknown): v is CacheEntry {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.key === "string" &&
		typeof o.summary === "string" &&
		typeof o.kind === "string" &&
		typeof o.model === "string" &&
		typeof o.promptVersion === "number" &&
		typeof o.srcTokens === "number" &&
		typeof o.sumTokens === "number" &&
		typeof o.at === "number"
	);
}

// ── In-memory cache ───────────────────────────────────────────────────────────

/**
 * Pure in-memory summary cache. Thread-unsafe (single-threaded JS only).
 * Persistence (read/write the backing file) is the caller's responsibility.
 *
 * Usage:
 *   const cache = new SummaryCacheMem();
 *   cache.load(parseCacheLines(await readFile(...)));
 *   const hit = cache.get(key);
 *   if (!hit) { ... generate ... cache.put(newEntry); await appendLine(serializeEntry(newEntry)); }
 */
export class SummaryCacheMem {
	private readonly _map = new Map<string, CacheEntry>();

	/** Bulk-load entries (e.g. from a parsed JSONL file). Later entries win on key collision. */
	load(entries: CacheEntry[]): void {
		for (const e of entries) {
			this._map.set(e.key, e);
		}
	}

	/** Look up a cache entry by key. Returns undefined on miss. */
	get(key: string): CacheEntry | undefined {
		return this._map.get(key);
	}

	/** Store an entry (overwrites any existing entry with the same key). */
	put(e: CacheEntry): void {
		this._map.set(e.key, e);
	}

	/** Number of entries in the cache. */
	get size(): number {
		return this._map.size;
	}
}
