/*
 * state.svelte.ts — Relevance Lab reactive state (Svelte 5 runes).
 *
 * The lab is OFF by default — a single toolbar toggle enables it.
 * When enabled, every block in the older/foldable box gets a score [0,1]
 * from the active scorer, driving a heat tint on canvas tiles and a
 * per-scorer table in the Inspector.
 *
 * Svelte 5 constraint: $derived cannot be exported from a module. The
 * derived values are exposed as getter functions that read reactive state
 * — they are called inside Svelte component $derived.by expressions so
 * Svelte's reactivity system tracks their dependencies correctly.
 */
import { isTauriEnv, session } from "../session.svelte";
import type { ScoreFile, ScorerId } from "./types";
import { validateScoreFile } from "./scoreFile";
import { buildTickContext } from "./context";
import { pureScorers } from "./scorers/index";
import { rankNormalize } from "./normalize";

// ---------------------------------------------------------------------------
// All 8 scorer IDs — pure ones always available; external from a file.
// ---------------------------------------------------------------------------

export const ALL_SCORER_IDS: ScorerId[] = [
	"recency",
	"actr",
	"bm25",
	"graph",
	"embed",
	"judge",
	"attn",
	"rerank",
];

export const PURE_IDS: Set<ScorerId> = new Set(["recency", "actr", "bm25", "graph"]);

/** Friendly display name for each scorer id. */
export const SCORER_LABELS: Record<ScorerId, string> = {
	recency: "Recency×Kind",
	actr: "ACT-R activation",
	bm25: "Lexical BM25",
	graph: "Spreading activation",
	embed: "Embedding cosine",
	judge: "LLM judge",
	attn: "Attention probe",
	rerank: "Attention reranker",
};

// ---------------------------------------------------------------------------
// Pure helpers — exported so they're unit-testable without runes.
// ---------------------------------------------------------------------------

/**
 * Build a blockId → normalized [0,1] score map from a pure scorer run.
 * Returns an empty map on error.
 */
export function buildPureScoreMap(
	scorerId: ScorerId,
	blocks: import("../engine/types").Block[],
	endBlock: number,
	_atBlock: number,
): Map<string, number> {
	const scorer = pureScorers.find((s) => s.id === scorerId);
	if (!scorer) return new Map();
	try {
		const ctx = buildTickContext(blocks, endBlock);
		const raw = scorer.score(ctx);
		const normed = rankNormalize(raw);
		const out = new Map<string, number>();
		for (let i = 0; i < ctx.atBlock && i < blocks.length; i++) {
			const v = normed[i];
			if (v !== null && v !== undefined) out.set(blocks[i].id, v);
		}
		return out;
	} catch {
		return new Map();
	}
}

/**
 * Build a blockId → normalized [0,1] score map from a loaded ScoreFile tick.
 * `tickIndex` is clamped to the valid range.
 */
export function buildFileScoreMap(
	scorerId: ScorerId,
	file: ScoreFile,
	tickIndex: number,
): Map<string, number> {
	const tick = file.ticks[Math.max(0, Math.min(tickIndex, file.ticks.length - 1))];
	if (!tick) return new Map();
	const raw = tick.scores[scorerId];
	if (!raw) return new Map();
	const normed = rankNormalize(raw);
	const out = new Map<string, number>();
	for (let i = 0; i < tick.blockIds.length; i++) {
		const v = normed[i];
		if (v !== null && v !== undefined) out.set(tick.blockIds[i], v);
	}
	return out;
}

/**
 * Return the set of scorer ids available for a given file tick.
 * Pure scorers are always available; external ones only if the tick has data.
 */
export function availableScorersForTick(file: ScoreFile | null, tickIndex: number): Set<ScorerId> {
	const out = new Set<ScorerId>(PURE_IDS);
	if (!file) return out;
	const tick = file.ticks[Math.max(0, Math.min(tickIndex, file.ticks.length - 1))];
	if (!tick) return out;
	for (const id of Object.keys(tick.scores) as ScorerId[]) {
		if (!PURE_IDS.has(id) && tick.scores[id]) out.add(id);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Memoization key helpers
// ---------------------------------------------------------------------------

type MemoKey = string;
function pureKey(id: ScorerId, blockCount: number, protectedFrom: number): MemoKey {
	return `${id}:${blockCount}:${protectedFrom}`;
}
function fileKey(id: ScorerId, sessionId: string, tick: number): MemoKey {
	return `${id}:${sessionId}:${tick}`;
}

// ---------------------------------------------------------------------------
// The lab state (Svelte 5 runes — one singleton module-level object).
// $state is safe to export; $derived is not (Svelte 5 rule).
// ---------------------------------------------------------------------------

export const relevanceLab = $state<{
	enabled: boolean;
	scorer: ScorerId;
	file: ScoreFile | null;
	tickIndex: number;
	error: string | null;
}>({
	enabled: false,
	scorer: "recency",
	file: null,
	tickIndex: 0,
	error: null,
});

// Module-level memo caches — survive rerenders but are keyed so stale hits won't occur.
const _pureMemo = new Map<MemoKey, Map<string, number>>();
const _fileMemo = new Map<MemoKey, Map<string, number>>();

/**
 * Get the active score map: blockId → [0,1] normalized score for the active scorer.
 *
 * Called inside component $derived.by(() => getActiveScoreMap()) so Svelte tracks
 * reactive reads of `relevanceLab.*` and `session.store.*` automatically.
 *
 * Pure scorers: memoized by (id, blockCount, protectedFromIndex).
 * File scorers: memoized by (id, sessionId, tickIndex).
 */
export function getActiveScoreMap(): Map<string, number> {
	if (!relevanceLab.enabled) return new Map();
	const st = session.store;
	if (!st) return new Map();

	const scorerId = relevanceLab.scorer;
	const blocks = st.blocks;
	const endBlock = blocks.length;
	const atBlock = st.protectedFromIndex;

	if (PURE_IDS.has(scorerId)) {
		const key = pureKey(scorerId, endBlock, atBlock);
		const cached = _pureMemo.get(key);
		if (cached) return cached;
		const result = buildPureScoreMap(scorerId, blocks, endBlock, atBlock);
		if (_pureMemo.size > 32) _pureMemo.clear();
		_pureMemo.set(key, result);
		return result;
	}

	// External scorer — needs a loaded file.
	const file = relevanceLab.file;
	if (!file) return new Map();
	const tickIndex = relevanceLab.tickIndex;
	const key = fileKey(scorerId, file.sessionId, tickIndex);
	const cached = _fileMemo.get(key);
	if (cached) return cached;
	const result = buildFileScoreMap(scorerId, file, tickIndex);
	if (_fileMemo.size > 64) _fileMemo.clear();
	_fileMemo.set(key, result);
	return result;
}

/**
 * Get ALL-scorer scores for a given blockId (for the Inspector score table).
 *
 * Call inside $derived.by to get reactivity.
 * Pure scorers always return a value (or null if the block is in the tail).
 * External scorers return null unless a file is loaded with data for that scorer.
 */
export function getAllScoresForBlock(blockId: string): Map<ScorerId, number | null> {
	const result = new Map<ScorerId, number | null>();
	const st = session.store;
	if (!st) {
		for (const id of ALL_SCORER_IDS) result.set(id, null);
		return result;
	}

	const blocks = st.blocks;
	const endBlock = blocks.length;
	const atBlock = st.protectedFromIndex;
	const file = relevanceLab.file;
	const tickIndex = relevanceLab.tickIndex;

	// Pure scorers
	for (const id of PURE_IDS) {
		const key = pureKey(id, endBlock, atBlock);
		let map = _pureMemo.get(key);
		if (!map) {
			map = buildPureScoreMap(id, blocks, endBlock, atBlock);
			if (_pureMemo.size > 32) _pureMemo.clear();
			_pureMemo.set(key, map);
		}
		result.set(id, map.get(blockId) ?? null);
	}

	// External scorers
	for (const id of ALL_SCORER_IDS) {
		if (PURE_IDS.has(id)) continue;
		if (!file) { result.set(id, null); continue; }
		const key = fileKey(id, file.sessionId, tickIndex);
		let map = _fileMemo.get(key);
		if (!map) {
			map = buildFileScoreMap(id, file, tickIndex);
			if (_fileMemo.size > 64) _fileMemo.clear();
			_fileMemo.set(key, map);
		}
		result.set(id, map.get(blockId) ?? null);
	}

	return result;
}

/**
 * Get the set of scorer ids currently available.
 * Pure scorers always; external only when the file tick has data.
 *
 * Call inside $derived to get reactivity.
 */
export function getAvailableScorers(): Set<ScorerId> {
	return availableScorersForTick(relevanceLab.file, relevanceLab.tickIndex);
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

export function loadScoreFile(json: unknown): void {
	const file = validateScoreFile(json);
	if (!file) {
		relevanceLab.error = "Invalid score file format.";
		return;
	}
	relevanceLab.error = null;
	relevanceLab.file = file;
	// Reset to the LAST tick.
	relevanceLab.tickIndex = Math.max(0, file.ticks.length - 1);
	// Invalidate file score cache for new file.
	_fileMemo.clear();
}

/** Open a JSON score file via Tauri dialog. No-op in browser mode. */
export async function loadViaDialog(): Promise<void> {
	if (!isTauriEnv) return;
	try {
		const [{ open }, { readTextFile }] = await Promise.all([
			import("@tauri-apps/plugin-dialog"),
			import("@tauri-apps/plugin-fs"),
		]);
		const selected = await open({
			title: "Load relevance scores",
			filters: [{ name: "JSON", extensions: ["json"] }],
		});
		if (!selected || typeof selected !== "string") return;
		const text = await readTextFile(selected);
		const json = JSON.parse(text);
		loadScoreFile(json);
	} catch (e) {
		relevanceLab.error = e instanceof Error ? e.message : String(e);
	}
}

/**
 * Auto-load demo scores from /sample-relevance.json when:
 *   - lab is enabled AND no file loaded AND demo session is active.
 * Silently ignores 404 / parse errors.
 */
export async function autoLoadDemo(): Promise<void> {
	if (!relevanceLab.enabled) return;
	if (relevanceLab.file) return;
	// Demo session: store loaded, no filePath, not live.
	if (!session.store || session.filePath || session.live) return;
	try {
		const res = await fetch("/sample-relevance.json");
		if (!res.ok) return; // 404 is expected — not yet generated
		const json = await res.json();
		loadScoreFile(json);
	} catch {
		// silent — file may not exist yet
	}
}

// Expose for debugging (mirrors window.__store).
if (typeof window !== "undefined") {
	(window as any).__lab = relevanceLab;
}
