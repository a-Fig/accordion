import { createHash } from "node:crypto";

declare const process:
	| {
			env?: Record<string, string | undefined>;
	  }
	| undefined;

export type AgentMessage = Record<string, any>;

export type BlockKind = "user" | "text" | "thinking" | "tool_call" | "tool_result";
/** 0 = full · 1 = trim · 2 = digest · 3 = group member marker */
export type FoldLevel = 0 | 1 | 2 | 3;
export type ConductorActor = "conductor";
export type DecisionAction = "fold" | "unfold" | "pin";
export type HumanActor = "you" | "agent";

export interface Turn {
	index: number;
	messageIndexes: number[];
	tokens: number;
}

export interface ParsedContext {
	preamble: AgentMessage[];
	turns: Turn[];
	blocks: ContextBlock[];
}

interface SourceRef {
	messageIndex: number;
	contentIndex?: number;
	field: "content" | "thinking" | "tool_result";
}

export interface ContextBlock {
	id: string;
	kind: BlockKind;
	turn: number;
	order: number;
	text: string;
	tokens: number;
	toolName?: string;
	callId?: string;
	isError?: boolean;
	source: SourceRef;
}

export interface LastCompletedTurn {
	index: number;
	messages: AgentMessage[];
	tokens?: number;
}

export interface ManualChange {
	blockId: string;
	action: "fold" | "unfold" | "pin" | "unpin";
	actor: HumanActor | ConductorActor;
	turn: number;
}

export interface CalibrationEvent {
	turn: number;
	from: number;
	to: number;
	corrections: number;
	reason: "correction" | "decay" | "hold" | "pinned";
}

export interface ConductorConfig {
	budgetTokens: number;
	workingTailTokens: number;
	foldTargetMin: number;
	foldTargetMax: number;
	foldTargetInitial: number;
	summaryModel: string;
	ollamaBaseUrl: string;
	ollamaModel: string;
	embeddingModel: string;
	summariesEnabled: boolean;
	embeddingsEnabled: boolean;
	summaryTimeoutMs: number;
}

export interface AccordionState {
	foldedBlockIds: string[];
	pinnedBlockIds: string[];
	pinnedTurnIndexes: number[];
	summaryCache: Record<string, string>;
	pendingSummaryHashes: string[];
	manualChanges: ManualChange[];
	missingApiKeyLogged?: boolean;
	/** Short provider failure message for live UI (summary/embedding). */
	providerError?: string;
	embeddingCache: Record<string, number[]>;
	/** Graduated fold level per block id; absent or 0 means full. */
	foldLevels: Record<string, FoldLevel>;
	/** Live self-calibrated fold target inside [FOLD_TARGET_MIN, FOLD_TARGET_MAX]. */
	foldTargetCalibrated: number;
	/** Last turn the calibrator ticked, so same-turn re-runs are idempotent. */
	lastCalibrationTurn: number;
	/** Turns on which the relative-outlier rule fired; counted as correction events. */
	recentProactiveUnfoldTurns: number[];
	/** Whether the previous run actually exercised folding pressure. */
	lastRunHadPressure: boolean;
	/** Whether the previous pressure-active run assembled within budget. */
	lastRunWithinBudget: boolean;
	/** Recent calibration ticks for the UI/decision log (capped). */
	calibrationEvents: CalibrationEvent[];
	/** Temporary conductor-managed pins. Expire after CONDUCTOR_PIN_LIFETIME turns; never
	 *  prevent manual human/agent fold. Keyed by block id. */
	conductorPins: Record<string, { turn: number; reason: string }>;
	/** Runtime Conductor settings overlay; defaults from compile-time constants. */
	config: ConductorConfig;
}

export interface ConductorInput {
	messages: AgentMessage[];
	incomingPrompt: string;
	lastCompletedTurn: LastCompletedTurn | null;
	budgetTokens: number;
	state: AccordionState;
	workingTailTokens?: number;
}

export interface FoldDecision {
	blockId: string;
	action: DecisionAction;
	actor: ConductorActor | HumanActor;
	reason: string | string[];
	turn: number;
	kind: BlockKind;
	callId?: string;
	/** Fold level after this decision (0 full · 1 trim · 2 digest · 3 group member). */
	level?: FoldLevel;
	/** Fold level before this decision. */
	fromLevel?: FoldLevel;
}

export interface ConductorOutput {
	messages: AgentMessage[];
	decisions: FoldDecision[];
	warnings: string[];
	/** Block ids that were proactively unfolded by the relative-outlier rule. */
	proactiveUnfolds: string[];
	/** The calibrated fold target used (or that would be used) for this run. */
	foldTarget: number;
	/** Estimated tokens of the assembled context this run produced. */
	assembledTokens: number;
}

export interface SummaryRequest {
	block: ContextBlock;
	hash: string;
	digest: string;
}

export type SummaryProvider = (request: SummaryRequest) => Promise<string>;

/** Batch embedding function: given N texts, return N L2-normalized float vectors. */
export type EmbeddingProvider = (texts: string[]) => Promise<number[][]>;

export interface ConductorDependencies {
	summaryProvider?: SummaryProvider;
	embeddingProvider?: EmbeddingProvider;
	onSummary?: (hash: string, summary: string) => void;
	log?: (message: string) => void;
	now?: () => number;
	/** Override UNFOLD_RELATIVE_MARGIN at call time (also readable from env ACCORDION_UNFOLD_MARGIN). */
	unfoldMargin?: number;
	/** Override UNFOLD_SEMANTIC_FLOOR at call time (also readable from env ACCORDION_UNFOLD_FLOOR). */
	unfoldFloor?: number;
	/** Pin the fold target, disabling self-calibration (also readable from env ACCORDION_FIXED_TARGET). */
	fixedFoldTarget?: number;
}

export interface OpenAICompatibleSummaryProviderOptions {
	baseUrl: string;
	model: string;
	timeoutMs?: number;
	headers?: Record<string, string>;
}

export interface OllamaSummaryProviderOptions {
	baseUrl?: string;
	model?: string;
	timeoutMs?: number;
}

export interface PromptWeights {
	kind: number;
	keyword: number;
	recency: number;
	foldTargetRatio: number;
}

export const CHARS_PER_TOKEN = 4;
export const BLOCK_OVERHEAD = 4;
export const DEFAULT_BUDGET_TOKENS = 150_000;
export const WORKING_TAIL_TOKENS = 20_000;
export const MAX_EMBEDDING_CACHE_ENTRIES = 1_000;
/** Calibrated fold target band. The Conductor self-calibrates the fold target
 *  inside [FOLD_TARGET_MIN, FOLD_TARGET_MAX]: correction events (human, agent,
 *  or proactive unfolds) push it up (fold less); quiet pressure-active turns
 *  decay it down (fold more). Pin via env ACCORDION_FIXED_TARGET or
 *  ConductorDependencies.fixedFoldTarget. */
export const FOLD_TARGET_MIN = 0.6;
export const FOLD_TARGET_MAX = 0.92;
export const FOLD_TARGET_INITIAL = 0.8;
/** Legacy alias: pre-calibration code and tests referenced a single fixed ratio. */
export const FOLD_TARGET_RATIO = FOLD_TARGET_INITIAL;
export const CALIBRATION_UP_STEP = 0.04;
export const CALIBRATION_UP_MAX_PER_TURN = 0.08;
export const CALIBRATION_DOWN_STEP = 0.01;
export const MAX_CALIBRATION_EVENTS = 50;
/** Graduated fold levels: 0 = full, 1 = trim (structured excerpt), 2 = digest
 *  (salience digest or cached LLM summary), 3 = group member (one-line marker;
 *  the first unit of the group carries the group-prefixed digest). */
export const TRIM_TARGET_RATIO = 0.25;
export const TRIM_MIN_TOKENS = 240;
export const GROUP_MIN_UNITS = 3;
export const GROUP_MEMBER_MARKER = "· folded into the group digest above";
export const UNFOLD_KEYWORD_THRESHOLD = 0.5;
/** Relative-outlier margin: a folded block is an unfold candidate only if its
 *  relevance exceeds (median_relevance_of_all_folded_blocks + UNFOLD_RELATIVE_MARGIN).
 *  Override at runtime via env var ACCORDION_UNFOLD_MARGIN or ConductorDependencies.unfoldMargin. */
export const UNFOLD_RELATIVE_MARGIN = 0.08;
/** Absolute safety floor for the cosine path: a folded block won't be unfolded unless
 *  its cosine relevance also clears this floor, regardless of the relative test.
 *  Prevents the outlier rule from firing when all relevance values are uniformly low.
 *  Override via env var ACCORDION_UNFOLD_FLOOR or ConductorDependencies.unfoldFloor. */
export const UNFOLD_SEMANTIC_FLOOR = 0.30;
/** Default embedding model (384d, 256-token input cap).
 *  Upgrade: "nomic-ai/nomic-embed-text-v1.5" (768d, 8k ctx) but requires
 *  "search_document:" / "search_query:" prefixes on inputs. */
export const EMBEDDING_MODEL = process?.env?.ACCORDION_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
export const UNFOLD_FEEDBACK_TURNS = 5;
export const HIGH_UNFOLD_RATE = 2;
export const SUMMARY_MODEL = "claude-haiku-4-5";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_OLLAMA_MODEL = "llama3.2:3b";
export const DEFAULT_SUMMARY_TIMEOUT_MS = 30_000;
/** Conductor pins expire after this many turns without renewal (auto-fold protection). */
export const CONDUCTOR_PIN_LIFETIME = 3;
/** Minimum pairwise digest-text keyword overlap for semantic group formation (second pass). */
export const SEMANTIC_GROUP_OVERLAP_THRESHOLD = 0.4;
/** Each risk category (commands/paths/exact_values/decisions) in a digest's suffix
 *  lowers the effective proactive-unfold floor by this amount. */
export const RISK_FLOOR_BONUS = 0.1;
/** The effective unfold floor never drops below this, regardless of risk bonus. */
export const RISK_FLOOR_MIN = 0.1;

/** Lower value means lower durable value and therefore more foldable. */
export const FOLD_RANK: Record<BlockKind, number> = {
	tool_result: 0,
	thinking: 1,
	text: 2,
	tool_call: 3,
	user: 4,
};

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"for",
	"from",
	"has",
	"have",
	"i",
	"in",
	"is",
	"it",
	"me",
	"of",
	"on",
	"or",
	"our",
	"that",
	"the",
	"this",
	"to",
	"we",
	"with",
	"you",
	"your",
]);

export function defaultConductorConfig(): ConductorConfig {
	return {
		budgetTokens: DEFAULT_BUDGET_TOKENS,
		workingTailTokens: WORKING_TAIL_TOKENS,
		foldTargetMin: FOLD_TARGET_MIN,
		foldTargetMax: FOLD_TARGET_MAX,
		foldTargetInitial: FOLD_TARGET_INITIAL,
		summaryModel: "",
		ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
		ollamaModel: DEFAULT_OLLAMA_MODEL,
		embeddingModel: EMBEDDING_MODEL,
		summariesEnabled: true,
		embeddingsEnabled: true,
		summaryTimeoutMs: DEFAULT_SUMMARY_TIMEOUT_MS,
	};
}

export function mergeConductorConfig(partial?: Partial<ConductorConfig>): ConductorConfig {
	const defaults = defaultConductorConfig();
	if (!partial) return { ...defaults };
	return { ...defaults, ...partial };
}

export function createAccordionState(seed: Partial<AccordionState> = {}): AccordionState {
	// Membership source of truth is foldedBlockIds (manual fold/unfold paths edit
	// it directly); foldLevels records depth for members. Stale level entries for
	// ids no longer in membership are dropped, and members without a recorded
	// depth migrate to level 2 (digest), matching the legacy binary system.
	const seededLevels = seed.foldLevels ?? {};
	const membership = seed.foldedBlockIds ?? Object.keys(seededLevels);
	const foldLevels: Record<string, FoldLevel> = {};
	for (const id of membership) {
		const normalized = normalizeLevel(seededLevels[id] ?? 2);
		foldLevels[id] = normalized > 0 ? normalized : 2;
	}
	const config = mergeConductorConfig(seed.config);
	const foldBand = foldTargetBand(config);
	return {
		foldedBlockIds: Object.keys(foldLevels),
		pinnedBlockIds: [...(seed.pinnedBlockIds ?? [])],
		pinnedTurnIndexes: [...(seed.pinnedTurnIndexes ?? [])],
		summaryCache: { ...(seed.summaryCache ?? {}) },
		pendingSummaryHashes: [...(seed.pendingSummaryHashes ?? [])],
		manualChanges: [...(seed.manualChanges ?? [])],
		missingApiKeyLogged: seed.missingApiKeyLogged ?? false,
		providerError: seed.providerError,
		embeddingCache: { ...(seed.embeddingCache ?? {}) },
		foldLevels,
		foldTargetCalibrated: clampFoldTarget(seed.foldTargetCalibrated ?? config.foldTargetInitial, foldBand),
		lastCalibrationTurn: seed.lastCalibrationTurn ?? -1,
		recentProactiveUnfoldTurns: [...(seed.recentProactiveUnfoldTurns ?? [])],
		lastRunHadPressure: seed.lastRunHadPressure ?? false,
		lastRunWithinBudget: seed.lastRunWithinBudget ?? false,
		calibrationEvents: [...(seed.calibrationEvents ?? [])].slice(-MAX_CALIBRATION_EVENTS),
		conductorPins: { ...(seed.conductorPins ?? {}) },
		config,
	};
}

export function normalizeLevel(level: unknown): FoldLevel {
	const n = typeof level === "number" ? Math.round(level) : 0;
	if (n <= 0) return 0;
	if (n >= 3) return 3;
	return n as FoldLevel;
}

export interface FoldTargetBand {
	min?: number;
	max?: number;
	initial?: number;
}

export function foldTargetBand(config: ConductorConfig): FoldTargetBand {
	return {
		min: config.foldTargetMin,
		max: config.foldTargetMax,
		initial: config.foldTargetInitial,
	};
}

export function clampFoldTarget(value: number, band: FoldTargetBand = {}): number {
	const min = band.min ?? FOLD_TARGET_MIN;
	const max = band.max ?? FOLD_TARGET_MAX;
	const initial = band.initial ?? FOLD_TARGET_INITIAL;
	if (!Number.isFinite(value)) return initial;
	return Math.min(max, Math.max(min, value));
}

/** Tick the self-calibrating fold target for this turn. Pure given state + deps:
 *  correction events (manual/agent unfolds and proactive unfolds inside the
 *  feedback window, not yet counted) push the target up by CALIBRATION_UP_STEP
 *  each, capped at CALIBRATION_UP_MAX_PER_TURN; a pressure-active quiet turn
 *  that previously assembled within budget decays it by CALIBRATION_DOWN_STEP.
 *  Idempotent within a turn via state.lastCalibrationTurn. */
export function calibrateFoldTarget(
	state: AccordionState,
	currentTurn: number,
	deps: ConductorDependencies = {},
): number {
	const band = foldTargetBand(state.config);
	const rawPinned = parseFloat(process?.env?.ACCORDION_FIXED_TARGET ?? "");
	const pinned = deps.fixedFoldTarget ?? (!isNaN(rawPinned) ? rawPinned : undefined);
	if (pinned !== undefined) {
		const target = clampFoldTarget(pinned, band);
		if (state.foldTargetCalibrated !== target) {
			recordCalibration(state, { turn: currentTurn, from: state.foldTargetCalibrated, to: target, corrections: 0, reason: "pinned" });
			state.foldTargetCalibrated = target;
		}
		return target;
	}

	const from = clampFoldTarget(state.foldTargetCalibrated ?? state.config.foldTargetInitial, band);
	if (state.lastCalibrationTurn >= currentTurn) return from;

	const inWindow = (turn: number) =>
		turn >= state.lastCalibrationTurn && turn < currentTurn && currentTurn - turn <= UNFOLD_FEEDBACK_TURNS;
	const manualCorrections = state.manualChanges.filter(
		(change) => change.action === "unfold" && (change.actor === "you" || change.actor === "agent") && inWindow(change.turn),
	).length;
	const proactiveCorrections = state.recentProactiveUnfoldTurns.filter(inWindow).length;
	const corrections = manualCorrections + proactiveCorrections;

	let to = from;
	let reason: CalibrationEvent["reason"] = "hold";
	if (corrections > 0) {
		to = clampFoldTarget(from + Math.min(CALIBRATION_UP_MAX_PER_TURN, corrections * CALIBRATION_UP_STEP), band);
		reason = "correction";
	} else if (state.lastRunHadPressure && state.lastRunWithinBudget) {
		to = clampFoldTarget(from - CALIBRATION_DOWN_STEP, band);
		reason = "decay";
	}

	state.lastCalibrationTurn = currentTurn;
	if (to !== from || reason !== "hold") {
		recordCalibration(state, { turn: currentTurn, from, to, corrections, reason });
	}
	state.foldTargetCalibrated = to;
	return to;
}

function recordCalibration(state: AccordionState, event: CalibrationEvent): void {
	state.calibrationEvents.push(event);
	if (state.calibrationEvents.length > MAX_CALIBRATION_EVENTS) {
		state.calibrationEvents = state.calibrationEvents.slice(-MAX_CALIBRATION_EVENTS);
	}
}

export function estTokens(s: string): number {
	if (!s) return 0;
	return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function tokensOf(s: string): number {
	return estTokens(s) + BLOCK_OVERHEAD;
}

function clip(s: string, n: number): string {
	const m = Math.max(1, n);
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= m ? t : t.slice(0, m - 3).trimEnd() + "...";
}

function firstLine(s: string, n = 100): string {
	const line = (s.split("\n").find((l) => l.trim()) ?? "").trim();
	return clip(line, n);
}

function decisionSentence(text: string, maxChars = 180): string {
	const sentences = text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	const selected = sentences.find((sentence) =>
		/\b(?:actual|belongs to|blamed|came from|command we kept|decision|decided|exact command|favou?rite|favou?red|final|liked|preferred|selected|chosen|wanted|we chose|we will)\b/i.test(sentence),
	);
	return selected ? clip(selected, maxChars) : "";
}

function salienceTokens(text: string, maxItems = 5, maxChars = 120): string {
	const seen = new Set<string>();
	const result: string[] = [];
	let totalChars = 0;
	const add = (s: string) => {
		const t = s.trim();
		if (!t || seen.has(t) || result.length >= maxItems || totalChars + t.length > maxChars) return;
		seen.add(t); result.push(t); totalChars += t.length;
	};
	// SCREAMING-CASE hyphenated identifiers (e.g. MANGO-WHISPER-9, AUTH-TOKEN)
	for (const m of text.matchAll(/[A-Z]{2,}(?:-[A-Z0-9]+)+/g)) add(m[0]);
	// key: value and key=value pairs
	for (const m of text.matchAll(/\b(\w[\w.-]*)[ \t]*[:=][ \t]*(\S+)/g)) {
		const key = m[1], val = m[2];
		if (!STOPWORDS.has(key.toLowerCase()) && val.length > 2) add(`${key}=${val}`);
	}
	// Filenames with extensions
	for (const m of text.matchAll(/\b[\w.-]+\.\w{1,6}\b/g)) add(m[0]);
	// Version / hex literals
	for (const m of text.matchAll(/\bv?\d+\.\d+[\d.]*\b|\b0x[0-9a-fA-F]+\b/g)) add(m[0]);
	// Error markers
	for (const m of text.matchAll(/\b(?:error|exception|failed|panic)[: ]+\S+/gi)) add(m[0].slice(0, 30));
	// HTTP routes and API endpoints. Keep this bounded: sentence-wide route
	// regexes can backtrack badly on huge minified or repetitive tool outputs.
	for (const m of text.matchAll(/\b(?:DELETE|GET|PATCH|POST|PUT)\s+\/[A-Za-z0-9_./:*-]+/g)) add(m[0]);
	// Common shell command invocations
	for (const m of text.matchAll(/\b(?:bun|cargo|deno|docker|gh|git|go|kubectl|make|node|npm|npx|pnpm|pytest|python3?|uv|yarn)\b[^\n.!?;]*/g)) {
		add(m[0]);
	}
	return result.join(" · ");
}

/** Categorize text content into salience buckets for structured digest suffixes. */
export function categorizeSalienceMarkers(text: string): {
	paths: string[];
	commands: string[];
	errors: string[];
	exact_values: string[];
	decisions: string[];
} {
	const result: { paths: string[]; commands: string[]; errors: string[]; exact_values: string[]; decisions: string[] } = {
		paths: [], commands: [], errors: [], exact_values: [], decisions: [],
	};
	const seen = new Set<string>();
	const add = (bucket: string[], val: string) => {
		const t = val.trim().slice(0, 80);
		if (!t || seen.has(t) || bucket.length >= 3) return;
		seen.add(t); bucket.push(t);
	};
	// Paths: filenames with common extensions, relative/absolute paths
	for (const m of text.matchAll(/\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|svelte|rs|py|go|java|rb|yml|yaml|toml|sh|env|log|conf|cfg|txt|sql|proto|lock)\b/g)) add(result.paths, m[0]);
	for (const m of text.matchAll(/(?:^|\s)((?:\.{1,2}|src|lib|app|dist|build|test|scripts?)\/[\w./-]+)/gm)) add(result.paths, m[1]);
	// Commands: lines starting with $ and common CLI invocations
	for (const m of text.matchAll(/^\s*\$\s+(.+)/gm)) add(result.commands, m[1].slice(0, 80));
	for (const m of text.matchAll(/\b(?:npm|npx|pnpm|yarn|bun|node|git|docker|kubectl|make|cargo|go|python3?|pytest|deno|uv|gh)\s+\S[^\n.!?;]{0,60}/g)) {
		add(result.commands, m[0].trim());
	}
	// Errors: explicit error markers and stack frames
	for (const m of text.matchAll(/\b(?:Error|FAIL|FAILED|error|exception|panic|ENOENT|ECONNREFUSED)[: ]+[^\n]{0,60}/g)) add(result.errors, m[0].slice(0, 60));
	if (/\s+at\s+\S+\s*\(/.test(text)) add(result.errors, "stack trace");
	// Exact values: key=value / key: value pairs
	for (const m of text.matchAll(/\b(\w[\w.-]*)[ \t]*[:=][ \t]*(\S+)/g)) {
		const key = m[1], val = m[2];
		if (!STOPWORDS.has(key.toLowerCase()) && val.length > 2 && val.length < 60) add(result.exact_values, `${key}=${val}`);
	}
	// Decisions: sentences containing explicit decision language
	for (const m of text.matchAll(/[^.!?\n]*\b(?:decided|chose|standardized on|going with|will use|selected|picked)\b[^.!?\n]*/gi)) {
		add(result.decisions, m[0].trim().slice(0, 80));
	}
	return result;
}

function buildSalienceSuffix(text: string): string {
	const cats = categorizeSalienceMarkers(text);
	const parts: string[] = [];
	if (cats.paths.length > 0) parts.push(`paths: ${cats.paths.slice(0, 3).join(", ")}`);
	if (cats.commands.length > 0) parts.push(`commands: ${cats.commands.slice(0, 2).join(", ")}`);
	if (cats.errors.length > 0) parts.push(`errors: ${cats.errors.slice(0, 2).join(", ")}`);
	if (cats.exact_values.length > 0) parts.push(`exact_values: ${cats.exact_values.slice(0, 3).join(", ")}`);
	if (cats.decisions.length > 0) parts.push(`decisions: ${cats.decisions.slice(0, 1).join(", ")}`);
	if (parts.length === 0) return "";
	return ` ⟦${parts.join(" ∣ ")}⟧`;
}

/** Parse the structured salience suffix appended by deterministicDigest and return the
 *  risk category names present. Risk categories: commands, paths, exact_values, decisions. */
export function parseRiskFlags(digestText: string): string[] {
	// Match the last ⟦...⟧ bracket (the salience suffix, not a group or trim marker)
	const match = digestText.match(/⟦([^⟧]+)⟧\s*$/);
	if (!match) return [];
	const suffix = match[1];
	// Don't parse group/trim markers as salience suffixes
	if (/^(?:group|trim)\b/.test(suffix.trim())) return [];
	const riskCategories = ["commands", "paths", "exact_values", "decisions"] as const;
	return riskCategories.filter((cat) => suffix.includes(`${cat}:`));
}

/** Number of risk categories present in the digest's salience suffix. Used to lower the
 *  proactive-unfold effective floor: effective_floor = floor - (bonus × RISK_FLOOR_BONUS). */
export function parseSalienceRiskBonus(digestText: string): number {
	return parseRiskFlags(digestText).length;
}

function isConductorPinned(block: ContextBlock, state: AccordionState, currentTurn: number): boolean {
	const pin = state.conductorPins?.[block.id];
	return !!pin && currentTurn - pin.turn <= CONDUCTOR_PIN_LIFETIME;
}

function formatTurnRanges(turns: number[]): string {
	if (turns.length === 0) return "none";
	const sorted = [...turns].sort((a, b) => a - b);
	const ranges: string[] = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (let i = 1; i <= sorted.length; i++) {
		const t = sorted[i];
		if (t === prev + 1) { prev = t; continue; }
		ranges.push(start === prev ? String(start) : `${start}–${prev}`);
		start = prev = t;
	}
	return ranges.join(", ");
}

function buildContextAwarenessHeader(foldedTurns: number[], foldTarget: number, assembledTokens: number, budgetTokens: number): string {
	const ratio = budgetTokens > 0 ? assembledTokens / budgetTokens : 0;
	const pressure = ratio < 0.7 ? "comfortable" : ratio < 0.85 ? "normal" : "tight";
	const turnList = formatTurnRanges(foldedTurns);
	return `[Accordion context manager active. Some earlier turns are folded to digests (marked ⟦t…⟧). If you need exact details from a folded turn, call accordion_recall or accordion_unfold before answering. Folded turns: ${turnList}. Conductor target: ${Math.round(foldTarget * 100)}%. Context pressure: ${pressure}.]`;
}

function getText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("\n");
	}
	return "";
}

function summaryPrompt(block: ContextBlock, digest: string): string {
	return (
		`Summarize this Accordion ${block.kind} block for future agent context. ` +
		`Keep durable facts, decisions, filenames, errors, and outcomes. Be concise.\n\n` +
		`Fallback digest:\n${digest}\n\nFull block:\n${block.text}`
	);
}

export function deterministicDigest(block: ContextBlock): string {
	switch (block.kind) {
		case "user": {
			const base = `"${clip(block.text, 100)}"`;
			return base + buildSalienceSuffix(block.text);
		}
		case "text": {
			const decision = decisionSentence(block.text);
			const salience = salienceTokens(block.text);
			let base: string;
			if (decision && salience && !decision.includes(salience)) base = `${decision} | ${salience}`;
			else base = decision || salience || clip(block.text, 120);
			return base + buildSalienceSuffix(block.text);
		}
		case "thinking": {
			const tok = estTokens(block.text);
			const gist = firstLine(block.text, 80);
			const base = `thought - ~${tok} tok${gist ? " - " + gist : ""}`;
			return base + buildSalienceSuffix(block.text);
		}
		case "tool_call": {
			const base = `${block.toolName ?? "tool"}(${clip(block.text.replace(/^\S+\s*/, ""), 70)})`;
			return base + buildSalienceSuffix(block.text);
		}
		case "tool_result": {
			const name = block.toolName ?? "result";
			if (!block.text.trim()) return `${name} -> ${block.isError ? "error" : "empty"}`;
			const lines = block.text.split("\n").filter((l) => l.trim()).length;
			const tag = block.isError ? "error" : `${lines} line${lines === 1 ? "" : "s"}`;
			const peek = salienceTokens(block.text) || firstLine(block.text, 60);
			const base = `${name} -> ${tag}, ~${block.tokens} tok${peek ? " - " + peek : ""}`;
			return base + buildSalienceSuffix(block.text);
		}
	}
}

/** Address prefix that makes every fold targetable by the agent's recall/unfold
 *  tools and the human's /peek and /expand commands. */
export function foldAddress(block: ContextBlock): string {
	return `\u27e6t${block.turn}\u27e7 `;
}

export function digestTokens(block: ContextBlock): number {
	return tokensOf(foldAddress(block) + deterministicDigest(block));
}

/** Level-1 fold: a deterministic structured excerpt at ~TRIM_TARGET_RATIO of the
 *  original. Keeps the head and tail (serial-position effect: models attend best
 *  to the start and end of a span) and hoists salience tokens from the middle,
 *  so identifiers, errors, and decisions survive even when the bulk is elided. */
export function trimmedText(block: ContextBlock): string {
	const text = block.text;
	const budgetChars = Math.max(240, Math.floor(text.length * TRIM_TARGET_RATIO));
	const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
	if (lines.length <= 4) return clip(text, budgetChars);

	const headBudget = Math.floor(budgetChars * 0.45);
	const tailBudget = Math.floor(budgetChars * 0.3);
	const head = clip(lines.slice(0, 2).join(" \u23ce "), headBudget);
	const tail = clip(lines.slice(-2).join(" \u23ce "), tailBudget);
	const salience = salienceTokens(text, 8, Math.max(40, budgetChars - headBudget - tailBudget - 24));
	const middle = salience ? `\u27ea\u2026 ${salience} \u2026\u27eb` : "\u27ea\u2026\u27eb";
	return `\u27e6trim t${block.turn}\u27e7 ${head}\n${middle}\n${tail}`;
}

export function trimTokens(block: ContextBlock): number {
	return tokensOf(trimmedText(block));
}

export function trimEligible(block: ContextBlock): boolean {
	return block.tokens >= TRIM_MIN_TOKENS && trimTokens(block) <= Math.floor(block.tokens * 0.5);
}

export function groupMemberText(block: ContextBlock): string {
	return `\u00b7 t${block.turn} ${GROUP_MEMBER_MARKER.slice(2)}`;
}

export function blockTokensAtLevel(block: ContextBlock, level: FoldLevel): number {
	if (level <= 0) return block.tokens;
	if (level === 1) return trimTokens(block);
	if (level === 3) return tokensOf(groupMemberText(block));
	return digestTokens(block);
}

export function liveTokensAtLevels(blocks: ContextBlock[], levels: Map<string, FoldLevel>): number {
	let total = 0;
	for (const block of blocks) total += blockTokensAtLevel(block, levels.get(block.id) ?? 0);
	return total;
}

function messageId(message: AgentMessage, index: number): string {
	return String(message.id ?? message.uuid ?? `__m${index}`);
}

export function parseMessages(messages: AgentMessage[]): ParsedContext {
	const preamble: AgentMessage[] = [];
	const turns: Turn[] = [];
	const blocks: ContextBlock[] = [];
	let currentTurn: Turn | null = null;
	let turn = 0;
	let order = 0;

	const beginTurn = (messageIndex: number) => {
		turn += 1;
		currentTurn = { index: turn, messageIndexes: [messageIndex], tokens: 0 };
		turns.push(currentTurn);
	};

	const includeMessage = (messageIndex: number) => {
		if (currentTurn && !currentTurn.messageIndexes.includes(messageIndex)) {
			currentTurn.messageIndexes.push(messageIndex);
		}
	};

	const push = (
		messageIndex: number,
		id: string,
		kind: BlockKind,
		text: string,
		source: SourceRef,
		extra: Partial<Pick<ContextBlock, "toolName" | "callId" | "isError">> = {},
	) => {
		if (!text && kind !== "tool_result") return;
		const block: ContextBlock = {
			id,
			kind,
			turn,
			order: order++,
			text,
			tokens: tokensOf(text),
			source,
			...extra,
		};
		blocks.push(block);
		if (currentTurn) {
			currentTurn.tokens += block.tokens;
			includeMessage(messageIndex);
		}
	};

	for (let mi = 0; mi < messages.length; mi++) {
		const message = messages[mi] as any;
		const role = message.role;
		const mid = messageId(message, mi);

		if (role === "compactionSummary" || (role !== "user" && !currentTurn)) {
			preamble.push(message);
			continue;
		}

		if (role === "user") {
			beginTurn(mi);
			push(mi, `${mid}:u`, "user", getText(message.content), {
				messageIndex: mi,
				field: "content",
			});
			continue;
		}

		if (role === "assistant") {
			includeMessage(mi);
			const content = Array.isArray(message.content) ? message.content : [];
			let ci = 0;
			for (const block of content) {
				if (block?.type === "thinking") {
					push(mi, `${mid}:${ci}`, "thinking", block.thinking || "", {
						messageIndex: mi,
						contentIndex: ci,
						field: "thinking",
					});
				} else if (block?.type === "text") {
					push(mi, `${mid}:${ci}`, "text", block.text || "", {
						messageIndex: mi,
						contentIndex: ci,
						field: "content",
					});
				} else if (block?.type === "toolCall" || block?.type === "tool_use") {
					const args = block.arguments ?? block.input ?? {};
					push(mi, `${mid}:${ci}`, "tool_call", `${block.name ?? "tool"} ${JSON.stringify(args)}`, {
						messageIndex: mi,
						contentIndex: ci,
						field: "content",
					}, {
						toolName: block.name ?? "tool",
						callId: block.id,
					});
				}
				ci++;
			}
			continue;
		}

		if (role === "toolResult") {
			includeMessage(mi);
			push(mi, `${mid}:r`, "tool_result", getText(message.content), {
				messageIndex: mi,
				field: "tool_result",
			}, {
				toolName: message.toolName || "tool",
				callId: message.toolCallId,
				isError: !!message.isError,
			});
			continue;
		}

		includeMessage(mi);
	}

	return { preamble, turns, blocks };
}

export function tokenizeForRelevance(text: string): string[] {
	const matches = text.toLowerCase().match(/[a-z0-9]+(?:[._:/\\-][a-z0-9]+)*/g) ?? [];
	return matches.filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export function keywordOverlap(blockText: string, prompt: string): number {
	const promptTokens = new Set(tokenizeForRelevance(prompt));
	if (promptTokens.size === 0) return 0;
	const blockTokens = new Set(tokenizeForRelevance(blockText));
	let shared = 0;
	for (const token of promptTokens) if (blockTokens.has(token)) shared++;
	return shared / promptTokens.size;
}

export function choosePromptWeights(
	prompt: string,
	state: AccordionState,
	currentTurn: number,
	calibratedTarget: number = FOLD_TARGET_INITIAL,
): PromptWeights {
	const target = clampFoldTarget(calibratedTarget, foldTargetBand(state.config));
	let weights: PromptWeights;
	if (hasIdentifierOrError(prompt)) {
		weights = { kind: 0.3, keyword: 0.6, recency: 0.1, foldTargetRatio: target };
	} else if (referencesPast(prompt)) {
		weights = { kind: 0.25, keyword: 0.7, recency: 0.05, foldTargetRatio: target };
	} else if (isGenericContinuation(prompt)) {
		weights = { kind: 0.3, keyword: 0.2, recency: 0.5, foldTargetRatio: target };
	} else {
		weights = { kind: 0.4, keyword: 0.4, recency: 0.2, foldTargetRatio: target };
	}

	const recentUnfolds = state.manualChanges.filter(
		(change) =>
			change.action === "unfold" &&
			(change.actor === "you" || change.actor === "agent") &&
			currentTurn - change.turn <= UNFOLD_FEEDBACK_TURNS,
	).length;

	// Relevance-weight shift only: fold aggressiveness now adapts through the
	// calibrated fold target instead of a hardcoded bump.
	if (recentUnfolds >= HIGH_UNFOLD_RATE) {
		weights = normalizeWeights({
			kind: Math.max(0.05, weights.kind - 0.1),
			keyword: weights.keyword + 0.15,
			recency: Math.max(0.05, weights.recency - 0.05),
			foldTargetRatio: target,
		});
	}

	return weights;
}

function normalizeWeights(weights: PromptWeights): PromptWeights {
	const total = weights.kind + weights.keyword + weights.recency;
	return {
		kind: weights.kind / total,
		keyword: weights.keyword / total,
		recency: weights.recency / total,
		foldTargetRatio: weights.foldTargetRatio,
	};
}

function hasIdentifierOrError(prompt: string): boolean {
	return (
		/`[^`]+`/.test(prompt) ||
		/\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|svelte|rs|py|go|java|rb|yml|yaml|toml)\b/i.test(prompt) ||
		/\b[A-Z][A-Za-z]+Error\b/.test(prompt) ||
		/\b(?:error|exception|traceback|failed|cannot|undefined|null|enoent|econnrefused)\b/i.test(prompt) ||
		/\b[A-Za-z_$][\w$]*(?:_[\w$]+|\.[\w$]+|::[\w$]+|\([^)]*\))/.test(prompt)
	);
}

function referencesPast(prompt: string): boolean {
	return /\b(earlier|before|previously|last time|we decided|you said|we said|as discussed|from above)\b/i.test(prompt);
}

function isGenericContinuation(prompt: string): boolean {
	return /^\s*(continue|next|keep going|go on|proceed|carry on|resume)\b/i.test(prompt);
}

interface FoldUnit {
	id: string;
	blocks: ContextBlock[];
	foldable: boolean;
	reason: string;
	score: number;
	overlap: number;
	fullTokens: number;
	foldedTokens: number;
	trimTokens: number;
	trimEligible: boolean;
}

function buildFoldUnits(blocks: ContextBlock[], prompt: string, currentTurn: number, state: AccordionState): FoldUnit[] {
	const calls = new Map<string, ContextBlock[]>();
	const results = new Map<string, ContextBlock[]>();
	for (const block of blocks) {
		if (!block.callId) continue;
		if (block.kind === "tool_call") calls.set(block.callId, [...(calls.get(block.callId) ?? []), block]);
		if (block.kind === "tool_result") results.set(block.callId, [...(results.get(block.callId) ?? []), block]);
	}

	const paired = new Set<string>();
	const units: FoldUnit[] = [];
	for (const block of blocks) {
		if ((block.kind === "tool_call" || block.kind === "tool_result") && !block.callId) {
			units.push(makeUnit(`malformed:${block.id}`, [block], false, "missing tool pair id kept full", prompt, currentTurn, state));
			continue;
		}

		if (block.callId && (block.kind === "tool_call" || block.kind === "tool_result")) {
			if (paired.has(block.id)) continue;
			const call = block.kind === "tool_call" ? block : calls.get(block.callId)?.[0];
			const result = block.kind === "tool_result" ? block : results.get(block.callId)?.[0];
			if (call && result && calls.get(block.callId)?.length === 1 && results.get(block.callId)?.length === 1) {
				paired.add(call.id);
				paired.add(result.id);
				units.push(makeUnit(`pair:${block.callId}`, [call, result], true, "tool pair", prompt, currentTurn, state));
			} else {
				paired.add(block.id);
				units.push(makeUnit(`malformed:${block.id}`, [block], false, "malformed tool pair kept full", prompt, currentTurn, state));
			}
			continue;
		}

		units.push(makeUnit(block.id, [block], true, "block", prompt, currentTurn, state));
	}
	return units;
}

function makeUnit(
	id: string,
	blocks: ContextBlock[],
	foldable: boolean,
	reason: string,
	prompt: string,
	currentTurn: number,
	state: AccordionState,
): FoldUnit {
	const fullTokens = blocks.reduce((sum, block) => sum + block.tokens, 0);
	const foldedTokens = blocks.reduce((sum, block) => sum + digestTokens(block), 0);
	const unitTrimTokens = blocks.reduce((sum, block) => sum + trimTokens(block), 0);
	const unitTrimEligible = blocks.every((block) => trimEligible(block)) && unitTrimTokens < fullTokens;
	const scoreParts = blocks.map((block) => {
		const kind = FOLD_RANK[block.kind] / 4;
		const overlap = relevance(block.text, prompt, state);
		const recency = currentTurn <= 1 ? 1 : block.turn / currentTurn;
		return { kind, overlap, recency };
	});
	const avg = (key: keyof (typeof scoreParts)[number]) =>
		scoreParts.reduce((sum, part) => sum + part[key], 0) / Math.max(1, scoreParts.length);

	return {
		id,
		blocks,
		foldable,
		reason,
		score: 0,
		overlap: avg("overlap"),
		fullTokens,
		foldedTokens,
		trimTokens: unitTrimTokens,
		trimEligible: unitTrimEligible,
	};
}

function unitScore(unit: FoldUnit, prompt: string, weights: PromptWeights, currentTurn: number, state: AccordionState): FoldUnit {
	const weighted = unit.blocks.map((block) => {
		const kindScore = FOLD_RANK[block.kind] / 4;
		const overlap = relevance(block.text, prompt, state);
		const recency = currentTurn <= 1 ? 1 : block.turn / currentTurn;
		return kindScore * weights.kind + overlap * weights.keyword + recency * weights.recency;
	});
	return {
		...unit,
		score: weighted.reduce((sum, n) => sum + n, 0) / Math.max(1, weighted.length),
	};
}

function isPinned(block: ContextBlock, state: AccordionState): boolean {
	return state.pinnedBlockIds.includes(block.id) || state.pinnedTurnIndexes.includes(block.turn);
}

function isGraceProtected(block: ContextBlock, state: AccordionState, currentTurn: number): boolean {
	return state.manualChanges.some(
		(change) =>
			change.blockId === block.id &&
			(change.actor === "you" || change.actor === "agent") &&
			(change.action === "fold" || change.action === "unfold") &&
			change.turn === currentTurn,
	);
}

function protectedTailIds(blocks: ContextBlock[], maxTurn: number, workingTailTokens: number): Set<string> {
	const ids = new Set<string>();
	let sum = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		if (block.turn === maxTurn) {
			ids.add(block.id);
			continue;
		}
		if (sum < workingTailTokens) {
			ids.add(block.id);
			sum += block.tokens;
		}
	}
	return ids;
}

export function contentHash(block: ContextBlock): string {
	const normalized = JSON.stringify({
		kind: block.kind,
		toolName: block.toolName ?? "",
		callId: block.callId ?? "",
		isError: !!block.isError,
		text: block.text.replace(/\s+/g, " ").trim(),
	});
	return createHash("sha256").update(normalized).digest("hex");
}

export function textHash(text: string): string {
	return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

export function pruneEmbeddingCache(
	state: AccordionState,
	blocks: ContextBlock[],
	prompt: string,
	maxEntries = MAX_EMBEDDING_CACHE_ENTRIES,
): void {
	const budget = Math.max(0, Math.floor(maxEntries));
	if (budget === 0) {
		state.embeddingCache = {};
		return;
	}

	const keys: string[] = [];
	const add = (text: string) => {
		if (!text.trim()) return;
		const key = textHash(text);
		if (!keys.includes(key)) keys.push(key);
	};
	add(prompt);
	for (let i = blocks.length - 1; i >= 0; i--) add(blocks[i].text);

	const keep = new Set(keys.slice(0, budget));
	state.embeddingCache = Object.fromEntries(
		Object.entries(state.embeddingCache).filter(([key]) => keep.has(key)),
	);
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Pre-warm the embedding cache for all block texts and the incoming prompt.
 *  Must be awaited BEFORE calling runConductor() to enable the semantic relevance path.
 *  runConductor() itself is synchronous — it only reads the cache. */
export async function warmEmbeddings(
	blocks: ContextBlock[],
	prompt: string,
	provider: EmbeddingProvider,
	state: AccordionState,
): Promise<void> {
	const texts: string[] = [];
	const keys: string[] = [];
	const addIfMissing = (text: string) => {
		const key = textHash(text);
		if (!state.embeddingCache[key]) { texts.push(text); keys.push(key); }
	};
	addIfMissing(prompt);
	for (const block of blocks) addIfMissing(block.text);
	if (texts.length === 0) return;
	
	try {
		const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 2000));
		const vectors = await Promise.race([provider(texts), timeout]);
		for (let i = 0; i < keys.length; i++) state.embeddingCache[keys[i]] = vectors[i];
	} catch (error) {
		// Non-throwing bounded timeout; relevance() falls back to keyword matching.
	}
}

function hasEmbeddings(state: AccordionState): boolean {
	return Object.keys(state.embeddingCache).length > 0;
}

function relevance(blockText: string, promptText: string, state: AccordionState): number {
	const bv = state.embeddingCache[textHash(blockText)];
	const pv = state.embeddingCache[textHash(promptText)];
	if (bv && pv) {
		let dot = 0;
		for (let i = 0; i < bv.length; i++) dot += bv[i] * pv[i];
		return dot; // L2-normalized vectors → cosine similarity
	}
	return keywordOverlap(blockText, promptText);
}

function summaryFor(block: ContextBlock, state: AccordionState, deps: ConductorDependencies): string {
	const digest = deterministicDigest(block);
	const hash = contentHash(block);
	const cached = state.summaryCache[hash];
	if (cached) return cached;

	if (!deps.summaryProvider) {
		if (!state.missingApiKeyLogged) {
			state.missingApiKeyLogged = true;
			deps.log?.("Accordion Conductor: ANTHROPIC_API_KEY missing; using deterministic digests.");
		}
		return digest;
	}

	if (!state.pendingSummaryHashes.includes(hash)) {
		state.pendingSummaryHashes.push(hash);
		void deps
			.summaryProvider({ block, hash, digest })
				.then((summary) => {
					const cleaned = summary.trim();
					if (!cleaned) return;
					state.summaryCache[hash] = cleaned;
					deps.onSummary?.(hash, cleaned);
				})
				.catch((error) => {
					deps.log?.(`Accordion Conductor: summary generation failed: ${String(error)}`);
				})
				.finally(() => {
					state.pendingSummaryHashes = state.pendingSummaryHashes.filter((h) => h !== hash);
				});
	}
	return digest;
}

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((message) => ({
		...message,
		content: Array.isArray(message.content)
			? message.content.map((part: any) => ({ ...part }))
			: message.content,
	}));
}

function applyFoldedContent(messages: AgentMessage[], block: ContextBlock, summary: string): void {
	const message = messages[block.source.messageIndex] as any;
	if (!message) return;

	if (block.kind === "tool_call") {
		if (!Array.isArray(message.content) || typeof block.source.contentIndex !== "number") return;
		const part = message.content[block.source.contentIndex];
		if (!part) return;
		if (part.type === "toolCall") {
			part.arguments = { accordion_folded: true, summary };
		} else if (part.type === "tool_use") {
			part.input = { accordion_folded: true, summary };
		}
		return;
	}

	if (block.source.field === "tool_result") {
		message.content = [{ type: "text", text: summary }];
		return;
	}

	if (typeof message.content === "string") {
		message.content = summary;
		return;
	}

	if (!Array.isArray(message.content)) return;
	if (typeof block.source.contentIndex === "number") {
		const part = message.content[block.source.contentIndex];
		if (!part) return;
		if (block.source.field === "thinking") part.thinking = summary;
		else if (part.type === "text") part.text = summary;
		return;
	}

	message.content = [{ type: "text", text: summary }];
}

export function runConductor(input: ConductorInput, deps: ConductorDependencies = {}): ConductorOutput {
	const parsed = parseMessages(input.messages);
	const warnings: string[] = [];
	const restingTarget = clampFoldTarget(
		input.state.foldTargetCalibrated ?? input.state.config.foldTargetInitial,
		foldTargetBand(input.state.config),
	);
	if (parsed.turns.length === 0 || parsed.blocks.length === 0) {
		return { messages: input.messages, decisions: [], warnings, proactiveUnfolds: [], foldTarget: restingTarget, assembledTokens: 0 };
	}

	const currentTurn = parsed.turns[parsed.turns.length - 1].index;

	// Prune expired conductor pins (expired = older than CONDUCTOR_PIN_LIFETIME turns).
	// This does NOT count as a calibration correction event — expiry is expected lifecycle.
	if (input.state.conductorPins) {
		for (const id of Object.keys(input.state.conductorPins)) {
			if (currentTurn - input.state.conductorPins[id].turn > CONDUCTOR_PIN_LIFETIME) {
				delete input.state.conductorPins[id];
			}
		}
	}

	const known = new Set(parsed.blocks.map((block) => block.id));
	const levels = new Map<string, FoldLevel>();
	for (const id of input.state.foldedBlockIds) {
		if (!known.has(id)) continue;
		const depth = normalizeLevel(input.state.foldLevels?.[id] ?? 2);
		levels.set(id, depth > 0 ? depth : 2);
	}
	const initialLevels = new Map(levels);

	const protectedIds = protectedTailIds(parsed.blocks, currentTurn, input.workingTailTokens ?? WORKING_TAIL_TOKENS);
	const pinnedTokens = parsed.blocks
		.filter((block) => isPinned(block, input.state))
		.reduce((sum, block) => sum + block.tokens, 0);

	if (pinnedTokens > input.budgetTokens) {
		warnings.push(
			`Pinned blocks alone cost ~${pinnedTokens.toLocaleString()} tokens, above the ${input.budgetTokens.toLocaleString()} token budget.`,
		);
	}

	let live = liveTokensAtLevels(parsed.blocks, levels);
	if (live <= input.budgetTokens && levels.size === 0) {
		return { messages: input.messages, decisions: [], warnings, proactiveUnfolds: [], foldTarget: restingTarget, assembledTokens: live };
	}

	// Pressure-active run: tick the calibrated fold target, then choose weights.
	const foldTarget = calibrateFoldTarget(input.state, currentTurn, deps);
	const weights = choosePromptWeights(input.incomingPrompt, input.state, currentTurn, foldTarget);

	const availableBudget = Math.max(0, input.budgetTokens - pinnedTokens);
	const targetTokens = pinnedTokens + Math.floor(availableBudget * weights.foldTargetRatio);
	const units = buildFoldUnits(parsed.blocks, input.incomingPrompt, currentTurn, input.state)
		.map((unit) => unitScore(unit, input.incomingPrompt, weights, currentTurn, input.state))
		.sort((a, b) => a.score - b.score || a.blocks[0].order - b.blocks[0].order);
	const canFoldUnit = (unit: FoldUnit) =>
		unit.foldable &&
		unit.foldedTokens < unit.fullTokens &&
		!unit.blocks.some(
			(block) =>
				isPinned(block, input.state) ||
				isConductorPinned(block, input.state, currentTurn) ||
				protectedIds.has(block.id) ||
				isGraceProtected(block, input.state, currentTurn),
		);
	const unitLevel = (unit: FoldUnit): FoldLevel =>
		unit.blocks.reduce((min: number, block) => Math.min(min, levels.get(block.id) ?? 0), 3) as FoldLevel;
	const setUnitLevel = (unit: FoldUnit, level: FoldLevel) => {
		for (const block of unit.blocks) {
			if (level === 0) levels.delete(block.id);
			else levels.set(block.id, level);
		}
	};
	const tokensAt = (unit: FoldUnit, level: FoldLevel) =>
		unit.blocks.reduce((sum, block) => sum + blockTokensAtLevel(block, level), 0);

	// Normalize: non-foldable units snap to full; mixed-level units snap to their
	// shallowest member, so tool pairs always move as one unit — the same
	// atomicity invariant the binary system enforced.
	for (const unit of units) {
		const blockLevels = unit.blocks.map((block) => levels.get(block.id) ?? 0);
		const hasFold = blockLevels.some((level) => level > 0);
		if (!canFoldUnit(unit)) {
			if (hasFold) setUnitLevel(unit, 0);
			continue;
		}
		const min = Math.min(...blockLevels) as FoldLevel;
		const max = Math.max(...blockLevels) as FoldLevel;
		if (min !== max) setUnitLevel(unit, min);
	}
	live = liveTokensAtLevels(parsed.blocks, levels);

	// Graduated escalation, depth-first in score order: the coldest unit deepens
	// first, and the marginal unit that crosses the target line stops at the
	// shallowest level that gets us there (full -> trim -> digest).
	if (live > input.budgetTokens) {
		for (const unit of units) {
			if (live <= targetTokens) break;
			if (!canFoldUnit(unit)) continue;
			const current = unitLevel(unit);
			if (current >= 2) continue;
			const currentTokens = tokensAt(unit, current);
			const need = live - targetTokens;
			if (current < 1 && unit.trimEligible) {
				const trimSave = currentTokens - unit.trimTokens;
				if (trimSave >= need && trimSave > 0) {
					setUnitLevel(unit, 1);
					live -= trimSave;
					continue;
				}
			}
			const digestSave = currentTokens - tokensAt(unit, 2);
			if (digestSave <= 0) continue;
			setUnitLevel(unit, 2);
			live -= digestSave;
		}
	}

	// Deep pressure: contiguous runs of digested units collapse into a group.
	// The head keeps a group-prefixed digest; members shrink to one-line markers.
	// Message skeleton is untouched, so provider safety holds by construction.
	type GroupMeta = { firstTurn: number; lastTurn: number; members: number; memberSalienceSuffix?: string };
	const groupHeadMeta = new Map<string, GroupMeta>();

	/** Union salience markers from all member digests for enriched group head prefix. */
	const buildGroupMemberSalienceSuffix = (group: FoldUnit[]): string => {
		const cats = { paths: new Set<string>(), commands: new Set<string>(), errors: new Set<string>(), exact_values: new Set<string>(), decisions: new Set<string>() };
		for (const unit of group) {
			for (const block of unit.blocks) {
				const digest = deterministicDigest(block);
				const match = digest.match(/⟦([^⟧]+)⟧\s*$/);
				if (!match || /^(?:group|trim)\b/.test(match[1].trim())) continue;
				for (const part of match[1].split(/\s*∣\s*/)) {
					const colon = part.indexOf(":");
					if (colon < 0) continue;
					const key = part.slice(0, colon).trim() as keyof typeof cats;
					if (!(key in cats)) continue;
					for (const val of part.slice(colon + 1).split(/,\s*/)) {
						const t = val.trim();
						if (t && cats[key].size < 3) cats[key].add(t);
					}
				}
			}
		}
		const parts: string[] = [];
		if (cats.paths.size > 0) parts.push(`paths: ${[...cats.paths].join(", ")}`);
		if (cats.commands.size > 0) parts.push(`commands: ${[...cats.commands].join(", ")}`);
		if (cats.errors.size > 0) parts.push(`errors: ${[...cats.errors].join(", ")}`);
		if (cats.exact_values.size > 0) parts.push(`exact_values: ${[...cats.exact_values].join(", ")}`);
		if (cats.decisions.size > 0) parts.push(`decisions: ${[...cats.decisions].join(", ")}`);
		return parts.length > 0 ? ` ∣ ${parts.join(" ∣ ")}` : "";
	};

	if (live > targetTokens) {
		const ordered = [...units].sort((a, b) => a.blocks[0].order - b.blocks[0].order);
		let run: FoldUnit[] = [];
		const flushRun = () => {
			if (run.length >= GROUP_MIN_UNITS && live > targetTokens) {
				const head = run[0];
				let saved = 0;
				for (const member of run.slice(1)) {
					saved += tokensAt(member, 2) - tokensAt(member, 3);
					setUnitLevel(member, 3);
				}
				live -= saved;
				const turns = run.flatMap((unit) => unit.blocks.map((block) => block.turn));
				groupHeadMeta.set(head.blocks[0].id, {
					firstTurn: Math.min(...turns),
					lastTurn: Math.max(...turns),
					members: run.length,
					memberSalienceSuffix: buildGroupMemberSalienceSuffix(run),
				});
			}
			run = [];
		};
		for (const unit of ordered) {
			if (live <= targetTokens) break;
			if (canFoldUnit(unit) && unitLevel(unit) === 2) run.push(unit);
			else flushRun();
		}
		flushRun();
	}

	// Semantic grouping second pass: if contiguous grouping didn't reach the target,
	// cluster non-adjacent L2 blocks by digest-text keyword overlap (≥ SEMANTIC_GROUP_OVERLAP_THRESHOLD
	// pairwise against the seed). Fires only when there are ≥ GROUP_MIN_UNITS candidates.
	if (live > targetTokens) {
		const ungroupedL2 = [...units]
			.filter((unit) => canFoldUnit(unit) && unitLevel(unit) === 2 && !groupHeadMeta.has(unit.blocks[0].id))
			.sort((a, b) => b.score - a.score); // highest relevance first = best group head
		if (ungroupedL2.length >= GROUP_MIN_UNITS) {
			const used = new Set<string>();
			for (const seed of ungroupedL2) {
				if (live <= targetTokens) break;
				if (used.has(seed.id)) continue;
				const seedDigest = deterministicDigest(seed.blocks[0]);
				const group = [seed];
				for (const other of ungroupedL2) {
					if (other === seed || used.has(other.id)) continue;
					const otherDigest = deterministicDigest(other.blocks[0]);
					if (keywordOverlap(seedDigest, otherDigest) >= SEMANTIC_GROUP_OVERLAP_THRESHOLD) {
						group.push(other);
					}
				}
				if (group.length < GROUP_MIN_UNITS) continue;
				// Form group: seed is head; group members go to L3
				let saved = 0;
				for (const member of group.slice(1)) {
					if (canFoldUnit(member) && unitLevel(member) === 2) {
						saved += tokensAt(member, 2) - tokensAt(member, 3);
						setUnitLevel(member, 3);
						used.add(member.id);
					}
				}
				live -= saved;
				used.add(seed.id);
				const turns = group.flatMap((u) => u.blocks.map((b) => b.turn));
				groupHeadMeta.set(seed.blocks[0].id, {
					firstTurn: Math.min(...turns),
					lastTurn: Math.max(...turns),
					members: group.length,
					memberSalienceSuffix: buildGroupMemberSalienceSuffix(group),
				});
			}
		}
	}

	// Relative-outlier proactive unfold:
	// A folded unit is an unfold candidate iff it clears the floor and either
	// exceeds (median + margin) or is the only folded item available to compare.
	// floor is branch-aware: UNFOLD_SEMANTIC_FLOOR on the cosine path, UNFOLD_KEYWORD_THRESHOLD
	// on the keyword fallback — preserving existing direct-probe keyword behavior.
	let usingCosine = hasEmbeddings(input.state);
	if (usingCosine && !input.state.embeddingCache[textHash(input.incomingPrompt)]) {
		usingCosine = false;
	}
	if (!usingCosine && deps.embeddingProvider) {
		warnings.push("Embedding cache is missing the prompt vector. Relevance scoring degraded to keyword fallback.");
	}

	const rawMargin = parseFloat(process?.env?.ACCORDION_UNFOLD_MARGIN ?? "");
	const margin = deps.unfoldMargin ?? (!isNaN(rawMargin) ? rawMargin : UNFOLD_RELATIVE_MARGIN);
	const rawFloor = parseFloat(process?.env?.ACCORDION_UNFOLD_FLOOR ?? "");
	const cosineFloor = deps.unfoldFloor ?? (!isNaN(rawFloor) ? rawFloor : UNFOLD_SEMANTIC_FLOOR);
	const floor = usingCosine ? cosineFloor : UNFOLD_KEYWORD_THRESHOLD;

	const foldedItems = units
		.filter((unit) => unit.foldable && unitLevel(unit) >= 1)
		.map((unit) => ({
			unit,
			overlap: Math.max(...unit.blocks.map((block) => relevance(block.text, input.incomingPrompt, input.state))),
		}));

	const med = median(foldedItems.map((item) => item.overlap));

	// Risk-aware unfold floor: blocks whose digests contain high-risk markers (commands,
	// paths, exact_values, decisions) get a lower effective floor — they're more likely
	// to cause a wrong answer if left folded.
	const riskFlagsByBlockId = new Map<string, string[]>();
	for (const item of foldedItems) {
		for (const block of item.unit.blocks) {
			const flags = parseRiskFlags(deterministicDigest(block));
			if (flags.length > 0) riskFlagsByBlockId.set(block.id, flags);
		}
	}

	const foldedCandidates = foldedItems
		.filter((item) => {
			const riskBonus = Math.max(...item.unit.blocks.map((b) => (riskFlagsByBlockId.get(b.id)?.length ?? 0)));
			const effectiveFloor = Math.max(RISK_FLOOR_MIN, floor - riskBonus * RISK_FLOOR_BONUS);
			return item.overlap >= effectiveFloor && (foldedItems.length < 2 || item.overlap >= med + margin);
		})
		.sort((a, b) => b.overlap - a.overlap || b.unit.blocks[0].turn - a.unit.blocks[0].turn);

	const proactiveUnfolds: string[] = [];
	for (const item of foldedCandidates) {
		const beforeLevels = new Map(levels);
		const beforeLive = live;
		const current = unitLevel(item.unit);
		const cost = item.unit.fullTokens - tokensAt(item.unit, current);
		setUnitLevel(item.unit, 0);
		groupHeadMeta.delete(item.unit.blocks[0].id);
		live += cost;

		if (live > input.budgetTokens) {
			const rescuedIds = new Set(item.unit.blocks.map((block) => block.id));
			for (const roomUnit of units) {
				if (live <= input.budgetTokens) break;
				if (roomUnit.id === item.unit.id || !canFoldUnit(roomUnit)) continue;
				if (roomUnit.blocks.some((block) => rescuedIds.has(block.id))) continue;
				const roomLevel = unitLevel(roomUnit);
				if (roomLevel >= 2) continue;
				live -= tokensAt(roomUnit, roomLevel) - tokensAt(roomUnit, 2);
				setUnitLevel(roomUnit, 2);
			}
		}

		if (live > input.budgetTokens) {
			levels.clear();
			for (const [id, level] of beforeLevels) levels.set(id, level);
			live = beforeLive;
			continue;
		}

		for (const block of item.unit.blocks) proactiveUnfolds.push(block.id);
	}

	// Proactive rescues are correction evidence for the calibrator: the Conductor
	// folded something the conversation turned out to need.
	const proactiveUnfoldSet = new Set(proactiveUnfolds);
	if (proactiveUnfolds.length > 0) {
		const turns = new Set(input.state.recentProactiveUnfoldTurns);
		turns.add(currentTurn);
		input.state.recentProactiveUnfoldTurns = [...turns]
			.filter((turn) => currentTurn - turn <= UNFOLD_FEEDBACK_TURNS * 2)
			.sort((a, b) => a - b);

		// Pin proactively rescued blocks that clear the unfold floor — they're relevant
		// to the current task and we don't want them to fold+unfold again next turn.
		input.state.conductorPins ??= {};
		for (const id of proactiveUnfolds) {
			const block = parsed.blocks.find((b) => b.id === id);
			if (!block) continue;
			const blockRelevance = relevance(block.text, input.incomingPrompt, input.state);
			if (blockRelevance >= floor) {
				input.state.conductorPins[id] = { turn: currentTurn, reason: "proactive_rescue" };
			}
		}
	}

	// Also pin recently agent-unfolded blocks that are still relevant to the current prompt.
	const recentAgentUnfolds = input.state.manualChanges
		.filter((c) => c.action === "unfold" && c.actor === "agent" && currentTurn - c.turn <= 1)
		.map((c) => c.blockId);
	for (const id of recentAgentUnfolds) {
		const block = parsed.blocks.find((b) => b.id === id);
		if (!block || (levels.get(id) ?? 0) > 0) continue;
		const blockRelevance = relevance(block.text, input.incomingPrompt, input.state);
		if (blockRelevance >= floor) {
			input.state.conductorPins ??= {};
			input.state.conductorPins[id] = { turn: currentTurn, reason: "agent_unfold_relevant" };
		}
	}

	const decisions = buildDecisions(parsed.blocks, initialLevels, levels, input.incomingPrompt, input.state, {
		currentTurn,
		proactiveUnfoldIds: proactiveUnfoldSet,
		riskFlagsByBlockId,
	});

	// Emit pin decisions for newly created conductor pins so they're visible in the decision log.
	const pinDecisions: FoldDecision[] = [];
	if (input.state.conductorPins) {
		for (const [id, pin] of Object.entries(input.state.conductorPins)) {
			if (pin.turn !== currentTurn) continue; // only newly set this turn
			const block = parsed.blocks.find((b) => b.id === id);
			if (!block) continue;
			pinDecisions.push({
				blockId: id,
				action: "pin",
				actor: "conductor",
				reason: ["conductor_pin", pin.reason],
				turn: block.turn,
				kind: block.kind,
				callId: block.callId,
			});
		}
	}

	const out = cloneMessages(input.messages);
	for (const block of parsed.blocks) {
		const level = levels.get(block.id) ?? 0;
		if (level === 0) continue;
		applyFoldedContent(out, block, contentForLevel(block, level, input.state, deps, groupHeadMeta.get(block.id)));
	}

	// Inject context-awareness header into the first assistant message when blocks are folded.
	// This teaches the model that folded turns are addressable via accordion_recall/unfold.
	const foldedTurns = [...new Set([...levels.keys()]
		.map((id) => parsed.blocks.find((b) => b.id === id)?.turn)
		.filter((t): t is number => t !== undefined)
	)].sort((a, b) => a - b);
	if (foldedTurns.length > 0) {
		const note = buildContextAwarenessHeader(foldedTurns, foldTarget, live, input.budgetTokens);
		for (const msg of out) {
			if ((msg as any).role === "assistant" && Array.isArray((msg as any).content)) {
				(msg as any).content.unshift({ type: "text", text: note });
				break;
			}
		}
	}

	input.state.lastRunHadPressure = true;
	input.state.lastRunWithinBudget = live <= input.budgetTokens;

	return { messages: out, decisions: [...decisions, ...pinDecisions], warnings, proactiveUnfolds, foldTarget, assembledTokens: live };
}

function contentForLevel(
	block: ContextBlock,
	level: FoldLevel,
	state: AccordionState,
	deps: ConductorDependencies,
	groupMeta?: { firstTurn: number; lastTurn: number; members: number; memberSalienceSuffix?: string },
): string {
	if (level === 1) return trimmedText(block);
	if (level === 3) return groupMemberText(block);
	const summary = summaryFor(block, state, deps);
	if (groupMeta) {
		const suffix = groupMeta.memberSalienceSuffix ?? "";
		return `\u27e6group \u00b7 turns ${groupMeta.firstTurn}\u2013${groupMeta.lastTurn} \u00b7 ${groupMeta.members} units${suffix}\u27e7 ${summary}`;
	}
	return foldAddress(block) + summary;
}

function buildDecisions(
	blocks: ContextBlock[],
	initialLevels: Map<string, FoldLevel>,
	finalLevels: Map<string, FoldLevel>,
	prompt: string,
	state: AccordionState,
	meta: {
		currentTurn?: number;
		proactiveUnfoldIds?: Set<string>;
		riskFlagsByBlockId?: Map<string, string[]>;
	} = {},
): FoldDecision[] {
	const { currentTurn = 0, proactiveUnfoldIds = new Set(), riskFlagsByBlockId = new Map() } = meta;
	const decisions: FoldDecision[] = [];
	for (const block of blocks) {
		const fromLevel = (initialLevels.get(block.id) ?? 0) as FoldLevel;
		const level = (finalLevels.get(block.id) ?? 0) as FoldLevel;
		if (fromLevel === level) continue;
		const overlap = relevance(block.text, prompt, state);
		const deeper = level > fromLevel;
		const reasons: string[] = [];
		if (!deeper) {
			reasons.push(level === 0 ? "relevance_high" : "relevance_eased");
			if (proactiveUnfoldIds.has(block.id)) reasons.push("proactive_rescue");
			const riskFlags = riskFlagsByBlockId.get(block.id) ?? [];
			for (const flag of riskFlags) reasons.push(`digest_has_risk_flag:${flag}`);
			if (riskFlags.length > 0) reasons.push("expected_answer_improvement_high");
		} else if (level === 1) {
			reasons.push(overlap < 0.2 ? "relevance_low" : "budget_pressure");
			reasons.push("trim_sufficient");
		} else if (level === 3) {
			reasons.push("budget_pressure_deep");
			reasons.push("grouped");
		} else {
			reasons.push(overlap < 0.2 ? "relevance_low" : "budget_pressure");
			if (block.tokens > 500) reasons.push("token_cost_high");
			if (currentTurn > 1 && block.turn / currentTurn < 0.5) reasons.push("age_high");
			reasons.push("not_pinned");
		}
		decisions.push({
			blockId: block.id,
			action: deeper ? "fold" : "unfold",
			actor: "conductor",
			reason: reasons,
			turn: block.turn,
			kind: block.kind,
			callId: block.callId,
			level,
			fromLevel,
		});
	}
	return decisions;
}

export function applyDecisionsToState(state: AccordionState, decisions: FoldDecision[]): void {
	for (const decision of decisions) {
		if (decision.action === "pin") {
			state.conductorPins ??= {};
			const reason = Array.isArray(decision.reason) ? (decision.reason[0] ?? "conductor_pin") : decision.reason;
			state.conductorPins[decision.blockId] = { turn: decision.turn, reason };
			continue;
		}
		const fallback: FoldLevel = decision.action === "fold" ? 2 : 0;
		const normalized = normalizeLevel(decision.level ?? fallback);
		const level: FoldLevel = decision.action === "fold" && normalized === 0 ? 2 : normalized;
		if (level === 0) delete state.foldLevels[decision.blockId];
		else state.foldLevels[decision.blockId] = level;
	}
	state.foldedBlockIds = Object.keys(state.foldLevels);
	state.manualChanges.push(
		...decisions
			.filter((d) => d.action !== "pin")
			.map((decision) => ({
				blockId: decision.blockId,
				action: decision.action as "fold" | "unfold",
				actor: decision.actor,
				turn: decision.turn,
			})),
	);
	state.manualChanges = state.manualChanges.slice(-200);
}

export function extractIncomingPrompt(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as any).role === "user") return getText((messages[i] as any).content);
	}
	return "";
}

export function lastCompletedTurnFromMessages(messages: AgentMessage[]): LastCompletedTurn | null {
	const parsed = parseMessages(messages);
	if (parsed.turns.length === 0) return null;
	const turn = parsed.turns[parsed.turns.length - 1];
	return {
		index: turn.index,
		messages: turn.messageIndexes.map((i) => messages[i]),
		tokens: turn.tokens,
	};
}

export function createHaikuSummaryProvider(apiKey = process?.env?.ANTHROPIC_API_KEY, model = SUMMARY_MODEL) {
	if (!apiKey) return undefined;
	return async ({ block, digest }: SummaryRequest): Promise<string> => {
		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model,
				max_tokens: 180,
				messages: [
					{
						role: "user",
						content: summaryPrompt(block, digest),
					},
				],
			}),
		});
		if (!response.ok) throw new Error(`Anthropic ${response.status}`);
		const json = (await response.json()) as any;
		return getText(json.content) || digest;
	};
}

export function createOpenAICompatibleSummaryProvider(
	options: OpenAICompatibleSummaryProviderOptions,
): SummaryProvider {
	const timeoutMs = options.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
	const baseUrl = options.baseUrl.replace(/\/$/, "");
	return async ({ block, digest }: SummaryRequest): Promise<string> => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error(`summary timed out after ${timeoutMs}ms`)), timeoutMs);
		try {
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				signal: controller.signal,
				headers: {
					"content-type": "application/json",
					...(options.headers ?? {}),
				},
				body: JSON.stringify({
					model: options.model,
					temperature: 0.1,
					max_tokens: 180,
					stream: false,
					messages: [
						{
							role: "system",
							content:
								"You summarize folded Accordion context blocks. Return only the summary, with no preamble.",
						},
						{
							role: "user",
							content: summaryPrompt(block, digest),
						},
					],
				}),
			});
			if (!response.ok) throw new Error(`OpenAI-compatible summary ${response.status}`);
			const json = (await response.json()) as any;
			const summary = json?.choices?.[0]?.message?.content;
			if (typeof summary !== "string" || !summary.trim()) return digest;
			return summary.trim();
		} finally {
			clearTimeout(timeout);
		}
	};
}

export function createOllamaSummaryProvider(options: OllamaSummaryProviderOptions = {}): SummaryProvider {
	return createOpenAICompatibleSummaryProvider({
		baseUrl: options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
		model: options.model ?? DEFAULT_OLLAMA_MODEL,
		timeoutMs: options.timeoutMs,
	});
}

export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

export function createGeminiSummaryProvider(
	apiKey = process?.env?.GOOGLE_API_KEY,
	model = DEFAULT_GEMINI_MODEL,
): SummaryProvider | undefined {
	if (!apiKey) return undefined;
	return createOpenAICompatibleSummaryProvider({
		baseUrl: DEFAULT_GEMINI_BASE_URL,
		model,
		headers: { Authorization: `Bearer ${apiKey}` },
	});
}

/** Local embedding provider using @huggingface/transformers (feature-extraction pipeline).
 *  Default model: Xenova/all-MiniLM-L6-v2 — 384d, 256-token input cap, no prefix needed.
 *  Upgrade: "nomic-ai/nomic-embed-text-v1.5" (768d, 8k ctx) but requires
 *  "search_document:" / "search_query:" prefixes on inputs.
 *  Pipeline is lazy-loaded on first call and reused across subsequent calls. */
export async function createTransformersEmbeddingProvider(model = EMBEDDING_MODEL): Promise<EmbeddingProvider> {
	let pipelineFactory: any;
	try {
		const { pipeline } = await import("@huggingface/transformers");
		pipelineFactory = pipeline;
	} catch (err: any) {
		if (err.code === "ERR_MODULE_NOT_FOUND" || err.message?.includes("Cannot find package")) {
			throw new Error("install @huggingface/transformers to enable --embeddings, or run without it");
		}
		throw err;
	}

	const needsPrefix = model.includes("nomic-embed-text");
	let pipePromise: Promise<any> | null = null;
	return async (texts: string[]) => {
		pipePromise ??= pipelineFactory("feature-extraction", model);
		const pipe = await pipePromise;
		const results: number[][] = [];
		for (const text of texts) {
			const prepared = needsPrefix ? `search_document: ${text}` : text;
			const out = await pipe(prepared, { pooling: "mean", normalize: true });
			results.push(Array.from(out.data as Float32Array));
		}
		return results;
	};
}
