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

export interface SalienceMetadata {
	paths: string[];
	commands: string[];
	errors: string[];
	exact_values: string[];
	decisions: string[];
	sourceHash?: string;
	digest?: string;
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
	/** Session-scoped extracted facts used by folded views; never outlives AccordionState. */
	salienceMetadata: Record<string, SalienceMetadata>;
	/** Learned-model caches and shadow traces. Originals remain the source of truth. */
	model: ConductorModelState;
	/** Temporary conductor-managed pins. Expire after CONDUCTOR_PIN_LIFETIME turns; never
	 *  prevent manual human/agent fold. Keyed by block id. */
	conductorPins: Record<string, { turn: number; reason: string }>;
	/**
	 * Human-created multiblock folds (groups). Each group references a contiguous run of
	 * member block ids and carries its own `folded` flag. While a group is folded the
	 * Conductor must SKIP its members (the group's summary is what reaches the model,
	 * not the per-block digest). User-only for now; the Conductor never creates groups.
	 */
	groups: AccordionGroup[];
	/** Runtime Conductor settings overlay; defaults from compile-time constants. */
	config: ConductorConfig;
}

/** A human-created multiblock fold, mirroring the GUI's `Group` and the wire's `WireGroup`. */
export interface AccordionGroup {
	id: string;
	memberIds: string[];
	folded: boolean;
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

export interface ModelResult<T> {
	value: T;
	confidence: number;
	reason?: string;
	authority?: string;
}

export interface BudgetOracleValue {
	/** Multiplier applied to the deterministic calibrated fold target, then clamped. */
	targetMultiplier: number;
	quality?: number;
	cacheHitRate?: number;
	cost?: number;
}

export interface BudgetOracleRequest {
	prompt: string;
	promptHash: string;
	currentTurn: number;
	calibratedTarget: number;
	targetModelId?: string;
	stats: {
		blockCount: number;
		turnCount: number;
		totalTokens: number;
		kindCounts: Record<BlockKind, number>;
		maxBlockTokens: number;
	};
}

export type BudgetOracleProvider = (request: BudgetOracleRequest) => Promise<ModelResult<BudgetOracleValue>>;

export interface FoldPolicyFeatures {
	kindRank: number;
	keywordOverlap: number;
	recency: number;
	tokenCount: number;
	agentAttention: number;
	wasRecentlyUnfolded: boolean;
}

export interface FoldPolicyPrediction {
	blockId: string;
	blockHash: string;
	expectedReuseTurns: number;
	keepScore?: number;
	level?: FoldLevel;
	reason?: string;
}

export interface FoldPolicyRequest {
	prompt: string;
	promptHash: string;
	currentTurn: number;
	targetModelId?: string;
	items: Array<{
		block: ContextBlock;
		blockHash: string;
		features: FoldPolicyFeatures;
	}>;
}

export interface FoldPolicyResponse {
	predictions: Array<ModelResult<FoldPolicyPrediction>>;
	reason?: string;
}

export type FoldPolicyProvider = (request: FoldPolicyRequest) => Promise<FoldPolicyResponse>;

export interface CompressionValue {
	digest: string;
	salience?: Partial<SalienceMetadata>;
}

export interface CompressionRequest {
	block: ContextBlock;
	hash: string;
	deterministicDigest: string;
}

export type CompressionProvider = (request: CompressionRequest) => Promise<ModelResult<CompressionValue>>;

export interface CachedBudgetOracleDecision extends ModelResult<BudgetOracleValue> {
	promptHash: string;
	turn: number;
	shadow: boolean;
	createdAt: number;
	fallbackReason?: string;
}

export interface CachedFoldPolicyDecision extends ModelResult<FoldPolicyPrediction> {
	promptHash: string;
	blockHash: string;
	turn: number;
	features: FoldPolicyFeatures;
	shadow: boolean;
	createdAt: number;
	fallbackReason?: string;
}

export interface CachedCompressionDecision extends ModelResult<CompressionValue> {
	hash: string;
	accepted: boolean;
	shadow: boolean;
	createdAt: number;
	fallbackReason?: string;
}

export interface ConductorShadowTrace {
	kind: "budget_oracle" | "fold_policy" | "compression";
	turn: number;
	blockId?: string;
	heuristicDecision: unknown;
	modelDecision: unknown;
	outcome: "pending" | "accepted" | "fallback";
	reason?: string;
}

export interface ManualChangeTraceLabel {
	source: "manualChanges";
	blockId: string;
	action: ManualChange["action"];
	actor: ManualChange["actor"];
	turn: number;
	reuseDistanceTurns?: number;
}

export interface FoldDecisionTraceLabel {
	source: "foldDecision";
	blockId: string;
	action: DecisionAction;
	turn: number;
	kind: BlockKind;
	level: FoldLevel;
	reason: string[];
}

export interface NiahHoldoutTraceLabel {
	source: "niah";
	blockId: string;
	turn: number;
	needle: string;
	shouldKeep: true;
}

export interface CompactSweepTraceLabel {
	source: "compactSweep";
	scenario: string;
	budgetTokens: number;
	accordionScore: number;
	compactScore: number;
	tokenSpend?: number;
	cacheHitRate?: number;
	jointScore?: number;
}

export interface ConductorTraceExtractionInput {
	state: AccordionState;
	decisions?: FoldDecision[];
	niahNeedles?: Array<{ blockId: string; turn: number; needle: string }>;
	compactSweeps?: Array<{
		scenario: string;
		budgetTokens: number;
		accordionScore: number;
		compactScore: number;
		tokenSpend?: number;
		cacheHitRate?: number;
	}>;
}

export interface ConductorTraceDataset {
	manualChanges: ManualChangeTraceLabel[];
	foldDecisions: FoldDecisionTraceLabel[];
	niahHoldouts: NiahHoldoutTraceLabel[];
	compactSweeps: CompactSweepTraceLabel[];
}

export interface ConductorModelState {
	budgetOracle?: CachedBudgetOracleDecision;
	foldPolicyCache: Record<string, CachedFoldPolicyDecision>;
	compressionCache: Record<string, CachedCompressionDecision>;
	shadowTraces: ConductorShadowTrace[];
}

export interface WarmConductorModelInput {
	blocks: ContextBlock[];
	prompt: string;
	state: AccordionState;
	messages?: AgentMessage[];
	currentTurn?: number;
	targetModelId?: string;
}

export interface LocalConductorModelProviderOptions {
	budgetOracle?: boolean;
	foldPolicyProvider?: boolean;
	compressionProvider?: boolean;
}

export interface LinearModelArtifact {
	intercept: number;
	weights: Record<string, number>;
	confidence: number;
	min?: number;
	max?: number;
}

export type FoldPolicyArchitecture = "linear_replay" | "minilm_cross_encoder_distilled";

export interface FoldPolicyEncoderArtifact {
	modelFamily: "MiniLM";
	modelId: string;
	pairTemplate: string;
	pooling: "cls" | "mean";
	embeddingDimension?: number;
}

export interface FoldPolicyCrossEncoderHeadArtifact {
	type: "hashed_pair_regressor";
	featureDimension: number;
	intercept: number;
	weights: number[];
	confidence: number;
	trainingPairs: number;
	teacherPairs: number;
}

export interface FoldPolicyModelArtifact extends LinearModelArtifact {
	reuseHorizonTurns: number;
	architecture?: FoldPolicyArchitecture;
	encoder?: FoldPolicyEncoderArtifact;
	crossEncoderHead?: FoldPolicyCrossEncoderHeadArtifact;
	distillation?: {
		teacherRecords: number;
		trainingPairs: number;
		holdoutPairs: number;
		source: string;
	};
}

export interface CompressionFidelityLabels {
	paths: string[];
	commands: string[];
	errors: string[];
	exactValues: string[];
	decisions: string[];
}

export interface CompressionDigestEntryArtifact {
	digest: string;
	fidelityLabels: CompressionFidelityLabels;
	labeler: string;
}

export interface CompressionModelArtifact {
	mode: "deterministic_extract" | "teacher_textual_digest_table";
	confidence: number;
	fidelityGate: boolean;
	baseModel?: {
		modelFamily: "Qwen2.5" | "local_textual";
		modelId: string;
	};
	adapter?: {
		type: "LoRA" | "digest_table";
		rank?: number;
		path?: string;
	};
	promptTemplate?: string;
	distillation?: {
		teacherRecords: number;
		compressionRecords: number;
		source: string;
	};
	digestTable?: Record<string, CompressionDigestEntryArtifact>;
}

export interface ConductorModelArtifact {
	version: 1;
	createdAt: string;
	source: string;
	training: {
		examples: number;
		oracleExamples: number;
		foldPolicyExamples: number;
		compressionExamples?: number;
		holdoutExamples?: number;
		datasetRecords?: number;
		datasetHash?: string;
		datasetSource?: string;
		rubricVersion: string;
		rubricPath?: string;
		distillation?: {
			teacherRecords: number;
			localRecords: number;
			labelers: string[];
			readyForLiveAuthority: boolean;
			missing: string[];
		};
	};
	budgetOracle: LinearModelArtifact;
	foldPolicy: FoldPolicyModelArtifact;
	compression: CompressionModelArtifact;
}

export type BudgetOracleAuthorityMode = "shadow_only" | "cost_guarded" | "live";
export type FoldPolicyAuthorityMode = "shadow_only" | "live";
export type CompressionAuthorityMode = "digest_only" | "metadata_live";

export interface ConductorModelAuthority {
	version: 1;
	generatedAt: string;
	artifact: string;
	artifactDatasetHash?: string;
	evidence: {
		labelAudit?: string;
		modelEvaluation?: string;
		niahBenchmark?: string;
		compactComparison?: string;
	};
	authority: {
		budgetOracle: {
			mode: BudgetOracleAuthorityMode;
			maxTargetMultiplier?: number;
		};
		foldPolicy: {
			mode: FoldPolicyAuthorityMode;
		};
		compression: {
			mode: CompressionAuthorityMode;
		};
	};
}

export interface ConductorDependencies {
	summaryProvider?: SummaryProvider;
	embeddingProvider?: EmbeddingProvider;
	budgetOracle?: BudgetOracleProvider;
	foldPolicyProvider?: FoldPolicyProvider;
	compressionProvider?: CompressionProvider;
	onSummary?: (hash: string, summary: string) => void;
	onShadowTrace?: (trace: ConductorShadowTrace) => void;
	log?: (message: string) => void;
	now?: () => number;
	/** Override UNFOLD_RELATIVE_MARGIN at call time (also readable from env ACCORDION_UNFOLD_MARGIN). */
	unfoldMargin?: number;
	/** Override UNFOLD_SEMANTIC_FLOOR at call time (also readable from env ACCORDION_UNFOLD_FLOOR). */
	unfoldFloor?: number;
	/** Pin the fold target, disabling self-calibration (also readable from env ACCORDION_FIXED_TARGET). */
	fixedFoldTarget?: number;
	/** Minimum confidence for learned components to have live authority. */
	modelConfidenceFloor?: number;
	/** Timeout for async model warm-up providers. */
	modelTimeoutMs?: number;
	/** Force shadow mode; env CONDUCTOR_SHADOW=1 also enables it. */
	shadowMode?: boolean;
	/** Target model id for learned budget/policy features. */
	targetModelId?: string;
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
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "llama3.2:3b";
export const DEFAULT_SUMMARY_TIMEOUT_MS = 30_000;
export const DEFAULT_MODEL_CONFIDENCE_FLOOR = 0.65;
export const DEFAULT_MODEL_TIMEOUT_MS = 500;
export const MAX_MODEL_CACHE_ENTRIES = 1_000;
export const MAX_SHADOW_TRACES = 500;
/** Conductor pins expire after this many turns without renewal (auto-fold protection). */
export const CONDUCTOR_PIN_LIFETIME = 3;
/** Minimum pairwise digest-text keyword overlap for semantic group formation (second pass). */
export const SEMANTIC_GROUP_OVERLAP_THRESHOLD = 0.4;
export const SEMANTIC_GROUP_MAX_CANDIDATES = 80;
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

function mergeSalienceMetadata(seed?: Record<string, Partial<SalienceMetadata>>): Record<string, SalienceMetadata> {
	const out: Record<string, SalienceMetadata> = {};
	for (const [key, value] of Object.entries(seed ?? {})) {
		out[key] = {
			paths: [...(value.paths ?? [])],
			commands: [...(value.commands ?? [])],
			errors: [...(value.errors ?? [])],
			exact_values: [...(value.exact_values ?? [])],
			decisions: [...(value.decisions ?? [])],
			sourceHash: value.sourceHash,
			digest: value.digest,
		};
	}
	return out;
}

function mergeModelState(seed?: Partial<ConductorModelState>): ConductorModelState {
	return {
		budgetOracle: seed?.budgetOracle ? { ...seed.budgetOracle, value: { ...seed.budgetOracle.value } } : undefined,
		foldPolicyCache: Object.fromEntries(
			Object.entries(seed?.foldPolicyCache ?? {}).map(([key, value]) => [
				key,
				{ ...value, value: { ...value.value }, features: { ...value.features } },
			]),
		),
		compressionCache: Object.fromEntries(
			Object.entries(seed?.compressionCache ?? {}).map(([key, value]) => [
				key,
				{ ...value, value: { digest: value.value.digest, salience: value.value.salience ? { ...value.value.salience } : undefined } },
			]),
		),
		shadowTraces: [...(seed?.shadowTraces ?? [])].slice(-MAX_SHADOW_TRACES),
	};
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
		salienceMetadata: mergeSalienceMetadata(seed.salienceMetadata),
		model: mergeModelState(seed.model),
		conductorPins: { ...(seed.conductorPins ?? {}) },
		groups: (seed.groups ?? []).map((g: AccordionGroup) => ({ ...g, memberIds: [...g.memberIds] })),
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
	// Decisions: sentences containing explicit decision language.
	// Leading [^.!?\n]* before the keyword causes O(n²) backtracking on long no-newline text.
	// Bound pre-context to 200 chars to keep this O(n).
	for (const m of text.matchAll(/[^.!?\n]{0,200}\b(?:decided|chose|standardized on|going with|will use|selected|picked)\b[^.!?\n]{0,200}/gi)) {
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

const MAX_SUMMARY_INPUT_CHARS = 4_000;

function summaryPrompt(block: ContextBlock, digest: string): string {
	const text =
		block.text.length > MAX_SUMMARY_INPUT_CHARS
			? `${block.text.slice(0, MAX_SUMMARY_INPUT_CHARS)}\n[... truncated at ${MAX_SUMMARY_INPUT_CHARS} chars]`
			: block.text;
	return (
		`Summarize this Accordion ${block.kind} block for future agent context. ` +
		`Keep durable facts, decisions, filenames, errors, and outcomes. Be concise.\n\n` +
		`Fallback digest:\n${digest}\n\nFull block:\n${text}`
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

function unitScore(
	unit: FoldUnit,
	prompt: string,
	weights: PromptWeights,
	currentTurn: number,
	state: AccordionState,
	deps: ConductorDependencies,
): FoldUnit {
	const weighted = unit.blocks.map((block) => {
		const kindScore = FOLD_RANK[block.kind] / 4;
		const overlap = relevance(block.text, prompt, state);
		const recency = currentTurn <= 1 ? 1 : block.turn / currentTurn;
		const heuristic = kindScore * weights.kind + overlap * weights.keyword + recency * weights.recency;
		const cached = cachedFoldPolicy(block, prompt, state, deps);
		const learned = cached ? learnedKeepScoreFromCached(cached) : undefined;
		if (learned === undefined) return heuristic;
		return isArtifactFoldPolicyDecision(cached) && cached.authority !== "live" ? heuristic : learned;
	});
	return {
		...unit,
		score: weighted.reduce((sum, n) => sum + n, 0) / Math.max(1, weighted.length),
	};
}

function cachedFoldPolicy(
	block: ContextBlock,
	prompt: string,
	state: AccordionState,
	deps: ConductorDependencies = {},
): CachedFoldPolicyDecision | undefined {
	const cached = state.model.foldPolicyCache[textHash(block.text)];
	if (!cached || cached.promptHash !== textHash(prompt) || cached.fallbackReason) return undefined;
	if (!modelAuthorityAllowed(deps)) return undefined;
	if (cached.confidence < modelConfidenceFloor(deps)) return undefined;
	return cached;
}

function learnedKeepScore(
	block: ContextBlock,
	prompt: string,
	state: AccordionState,
	deps: ConductorDependencies = {},
): number | undefined {
	const cached = cachedFoldPolicy(block, prompt, state, deps);
	if (!cached) return undefined;
	return learnedKeepScoreFromCached(cached);
}

function learnedKeepScoreFromCached(cached: CachedFoldPolicyDecision): number {
	const predicted = cached.value;
	const base = Number.isFinite(predicted.keepScore ?? NaN)
		? predicted.keepScore!
		: reuseDistanceToKeepScore(predicted.expectedReuseTurns);
	const attentionBoost = cached.features.agentAttention * 0.25;
	return Math.max(0, Math.min(1, base + attentionBoost));
}

function learnedFoldLevel(
	block: ContextBlock,
	prompt: string,
	state: AccordionState,
	deps: ConductorDependencies,
): FoldLevel | undefined {
	const cached = cachedFoldPolicy(block, prompt, state, deps);
	if (!cached) return undefined;
	if (isArtifactFoldPolicyDecision(cached) && cached.authority !== "live") return undefined;
	const level = normalizeLevel(cached.value.level ?? reuseDistanceToFoldLevel(cached.value.expectedReuseTurns));
	return level;
}

function isArtifactFoldPolicyDecision(cached: CachedFoldPolicyDecision): boolean {
	return cached.value.reason?.startsWith("artifact:") === true || cached.reason?.startsWith("artifact:") === true;
}

function learnedUnitFoldLevel(
	unit: FoldUnit,
	prompt: string,
	state: AccordionState,
	deps: ConductorDependencies,
): FoldLevel | undefined {
	const levels = unit.blocks
		.map((block) => learnedFoldLevel(block, prompt, state, deps))
		.filter((level): level is FoldLevel => level !== undefined);
	if (levels.length === 0) return undefined;
	return Math.max(...levels) as FoldLevel;
}

function vectorForBlock(block: ContextBlock, state: AccordionState): number[] | undefined {
	return state.embeddingCache[textHash(block.text)];
}

function cosine(a: number[] | undefined, b: number[] | undefined): number {
	if (!a || !b || a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

export function mmrRedundancyPenalty(vector: number[] | undefined, selectedVectors: Array<number[] | undefined>, weight = 0.15): number {
	const maxSimilarity = Math.max(0, ...selectedVectors.map((selected) => cosine(vector, selected)));
	return maxSimilarity * weight;
}

function applyMmrRedundancyPenalty(units: FoldUnit[], state: AccordionState): FoldUnit[] {
	if (!hasEmbeddings(state)) return units;
	const byScore = [...units].sort((a, b) => b.score - a.score);
	const selected: ContextBlock[] = [];
	const adjusted = new Map<string, number>();
	for (const unit of byScore) {
		const block = unit.blocks[0];
		const vector = vectorForBlock(block, state);
		const penalty = mmrRedundancyPenalty(vector, selected.map((prior) => vectorForBlock(prior, state)));
		adjusted.set(unit.id, Math.max(0, unit.score - penalty));
		selected.push(block);
	}
	return units.map((unit) => ({ ...unit, score: adjusted.get(unit.id) ?? unit.score }));
}

function isPinned(block: ContextBlock, state: AccordionState): boolean {
	return state.pinnedBlockIds.includes(block.id) || state.pinnedTurnIndexes.includes(block.turn);
}

/**
 * True if the block belongs to a FOLDED group. While a group is folded the agent
 * sees the group's summary in place of all its members, so per-block fold decisions
 * for those members are meaningless — skip them in candidate selection so the
 * Conductor never double-folds something the group has already absorbed.
 */
function isInFoldedGroup(block: ContextBlock, state: AccordionState): boolean {
	for (const g of state.groups) {
		if (g.folded && g.memberIds.includes(block.id)) return true;
	}
	return false;
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

function modelConfidenceFloor(deps: ConductorDependencies): number {
	const raw = parseFloat(process?.env?.ACCORDION_MODEL_CONFIDENCE_FLOOR ?? "");
	const configured = deps.modelConfidenceFloor ?? (!isNaN(raw) ? raw : DEFAULT_MODEL_CONFIDENCE_FLOOR);
	if (!Number.isFinite(configured)) return DEFAULT_MODEL_CONFIDENCE_FLOOR;
	return Math.max(0, Math.min(1, configured));
}

function modelTimeoutMs(deps: ConductorDependencies): number {
	const raw = parseInt(process?.env?.ACCORDION_MODEL_TIMEOUT_MS ?? "", 10);
	const configured = deps.modelTimeoutMs ?? (!isNaN(raw) ? raw : DEFAULT_MODEL_TIMEOUT_MS);
	if (!Number.isFinite(configured)) return DEFAULT_MODEL_TIMEOUT_MS;
	return Math.max(1, configured);
}

export function isConductorShadowEnabled(deps: ConductorDependencies = {}): boolean {
	const env = process?.env?.CONDUCTOR_SHADOW;
	return deps.shadowMode ?? (env === "1" || env === "true");
}

function modelAuthorityAllowed(deps: ConductorDependencies): boolean {
	return !isConductorShadowEnabled(deps);
}

async function withModelTimeout<T>(promise: Promise<T>, deps: ConductorDependencies): Promise<T> {
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error("model provider timed out")), modelTimeoutMs(deps)),
	);
	return Promise.race([promise, timeout]);
}

function recordShadowTrace(state: AccordionState, deps: ConductorDependencies, trace: ConductorShadowTrace): void {
	state.model.shadowTraces.push(trace);
	if (state.model.shadowTraces.length > MAX_SHADOW_TRACES) {
		state.model.shadowTraces = state.model.shadowTraces.slice(-MAX_SHADOW_TRACES);
	}
	deps.onShadowTrace?.(trace);
}

function conductorStats(blocks: ContextBlock[]): BudgetOracleRequest["stats"] {
	const kindCounts: Record<BlockKind, number> = {
		user: 0,
		text: 0,
		thinking: 0,
		tool_call: 0,
		tool_result: 0,
	};
	let totalTokens = 0;
	let maxBlockTokens = 0;
	const turns = new Set<number>();
	for (const block of blocks) {
		kindCounts[block.kind]++;
		totalTokens += block.tokens;
		maxBlockTokens = Math.max(maxBlockTokens, block.tokens);
		turns.add(block.turn);
	}
	return {
		blockCount: blocks.length,
		turnCount: turns.size,
		totalTokens,
		kindCounts,
		maxBlockTokens,
	};
}

function recentAssistantText(messages: AgentMessage[] | undefined, maxMessages = 4): string {
	if (!messages?.length) return "";
	const parts: string[] = [];
	for (let i = messages.length - 1; i >= 0 && parts.length < maxMessages; i--) {
		const message = messages[i] as any;
		if (message.role !== "assistant") continue;
		const text = getText(message.content);
		if (text.trim()) parts.push(text);
	}
	return parts.reverse().join("\n");
}

function agentAttentionScore(block: ContextBlock, messages: AgentMessage[] | undefined): number {
	const ownText = block.text.trim();
	const recent = recentAssistantText(messages)
		.replace(ownText, "")
		.trim();
	if (!recent) return 0;
	const recentLower = recent.toLowerCase();
	const salience = categorizeSalienceMarkers(block.text);
	const markers = [
		...salience.paths,
		...salience.commands,
		...salience.errors,
		...salience.exact_values,
		...salience.decisions,
	].filter((marker) => marker.length >= 3);
	if (markers.some((marker) => recentLower.includes(marker.toLowerCase()))) return 1;

	const blockTokens = new Set(tokenizeForRelevance(block.text));
	if (blockTokens.size === 0) return 0;
	const assistantTokens = new Set(tokenizeForRelevance(recent));
	let shared = 0;
	for (const token of blockTokens) if (assistantTokens.has(token)) shared++;
	return Math.min(1, shared / Math.min(blockTokens.size, 20));
}

function foldPolicyFeatures(
	block: ContextBlock,
	prompt: string,
	currentTurn: number,
	state: AccordionState,
	messages: AgentMessage[] | undefined,
): FoldPolicyFeatures {
	return {
		kindRank: FOLD_RANK[block.kind] / 4,
		keywordOverlap: keywordOverlap(block.text, prompt),
		recency: currentTurn <= 1 ? 1 : block.turn / currentTurn,
		tokenCount: block.tokens,
		agentAttention: agentAttentionScore(block, messages),
		wasRecentlyUnfolded: state.manualChanges.some(
			(change) =>
				change.blockId === block.id &&
				change.action === "unfold" &&
				currentTurn - change.turn <= UNFOLD_FEEDBACK_TURNS,
		),
	};
}

function pruneModelCaches(state: AccordionState): void {
	const policyEntries = Object.entries(state.model.foldPolicyCache);
	if (policyEntries.length > MAX_MODEL_CACHE_ENTRIES) {
		state.model.foldPolicyCache = Object.fromEntries(policyEntries.slice(-MAX_MODEL_CACHE_ENTRIES));
	}
	const compressionEntries = Object.entries(state.model.compressionCache);
	if (compressionEntries.length > MAX_MODEL_CACHE_ENTRIES) {
		state.model.compressionCache = Object.fromEntries(compressionEntries.slice(-MAX_MODEL_CACHE_ENTRIES));
	}
}

export function reuseDistanceToFoldLevel(expectedReuseTurns: number): FoldLevel {
	if (!Number.isFinite(expectedReuseTurns) || expectedReuseTurns < 0) return 2;
	if (expectedReuseTurns <= 1) return 0;
	if (expectedReuseTurns <= 3) return 1;
	if (expectedReuseTurns <= 8) return 2;
	return 3;
}

function reuseDistanceToKeepScore(expectedReuseTurns: number): number {
	if (!Number.isFinite(expectedReuseTurns) || expectedReuseTurns < 0) return 0.5;
	return 1 / (1 + Math.max(0, expectedReuseTurns));
}

function salienceMetadataFromText(text: string, digest?: string): SalienceMetadata {
	const cats = categorizeSalienceMarkers(text);
	return {
		paths: cats.paths,
		commands: cats.commands,
		errors: cats.errors,
		exact_values: cats.exact_values,
		decisions: cats.decisions,
		sourceHash: textHash(text),
		digest,
	};
}

function mergeMetadata(base: SalienceMetadata, extra?: Partial<SalienceMetadata>): SalienceMetadata {
	const merge = (key: keyof Omit<SalienceMetadata, "sourceHash" | "digest">): string[] => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const value of [...(base[key] ?? []), ...(extra?.[key] ?? [])]) {
			const normalized = value.trim();
			if (!normalized || seen.has(normalized) || out.length >= 5) continue;
			seen.add(normalized);
			out.push(normalized);
		}
		return out;
	};
	return {
		paths: merge("paths"),
		commands: merge("commands"),
		errors: merge("errors"),
		exact_values: merge("exact_values"),
		decisions: merge("decisions"),
		sourceHash: base.sourceHash,
		digest: extra?.digest ?? base.digest,
	};
}

function metadataValues(metadata: Partial<SalienceMetadata> | undefined): string[] {
	if (!metadata) return [];
	return [
		...(metadata.paths ?? []),
		...(metadata.commands ?? []),
		...(metadata.errors ?? []),
		...(metadata.exact_values ?? []),
		...(metadata.decisions ?? []),
	].filter(Boolean);
}

function compressionFidelityFailure(block: ContextBlock, value: CompressionValue): string | undefined {
	const source = block.text.toLowerCase();
	const digestMetadata = salienceMetadataFromText(value.digest);
	digestMetadata.exact_values = digestMetadata.exact_values.filter((marker) => !/^digest=/i.test(marker));
	const candidateMetadata = mergeMetadata(
		digestMetadata,
		value.salience,
	);
	for (const marker of metadataValues(candidateMetadata)) {
		if (!source.includes(marker.toLowerCase())) return `ungrounded marker: ${marker}`;
	}
	return undefined;
}

function applyBudgetOracleTarget(
	state: AccordionState,
	currentTurn: number,
	calibratedTarget: number,
	deps: ConductorDependencies,
): number {
	const cached = state.model.budgetOracle;
	if (!cached || cached.turn !== currentTurn || cached.fallbackReason || !modelAuthorityAllowed(deps)) {
		return calibratedTarget;
	}
	if (cached.confidence < modelConfidenceFloor(deps)) return calibratedTarget;
	const multiplier = cached.value.targetMultiplier;
	if (!Number.isFinite(multiplier) || multiplier <= 0) return calibratedTarget;
	return clampFoldTarget(calibratedTarget * multiplier, foldTargetBand(state.config));
}

function promptHasHighRecallRisk(prompt: string): boolean {
	return hasIdentifierOrError(prompt) || referencesPast(prompt);
}

function sigmoid(value: number): number {
	return 1 / (1 + Math.exp(-value));
}

function dotFeatures(features: Record<string, number>, model: LinearModelArtifact): number {
	let total = model.intercept;
	for (const [name, weight] of Object.entries(model.weights)) {
		total += (features[name] ?? 0) * weight;
	}
	return total;
}

function clampModelOutput(value: number, model: LinearModelArtifact): number {
	const min = model.min ?? Number.NEGATIVE_INFINITY;
	const max = model.max ?? Number.POSITIVE_INFINITY;
	if (!Number.isFinite(value)) return Math.max(min, Math.min(max, model.intercept));
	return Math.max(min, Math.min(max, value));
}

function budgetArtifactFeatures(request: BudgetOracleRequest): Record<string, number> {
	return {
		prompt_risk: promptHasHighRecallRisk(request.prompt) ? 1 : 0,
		log_blocks: Math.log1p(request.stats.blockCount),
		log_turns: Math.log1p(request.stats.turnCount),
		log_total_tokens: Math.log1p(request.stats.totalTokens),
		log_max_block_tokens: Math.log1p(request.stats.maxBlockTokens),
		tool_ratio: request.stats.blockCount > 0
			? (request.stats.kindCounts.tool_call + request.stats.kindCounts.tool_result) / request.stats.blockCount
			: 0,
	};
}

function foldArtifactFeatures(features: FoldPolicyFeatures): Record<string, number> {
	return {
		kind_rank: features.kindRank,
		keyword_overlap: features.keywordOverlap,
		recency: features.recency,
		log_tokens: Math.log1p(features.tokenCount),
		agent_attention: features.agentAttention,
		recent_unfold: features.wasRecentlyUnfolded ? 1 : 0,
	};
}

export function foldPolicyCrossEncoderFeatureEntries(
	prompt: string,
	blockText: string,
	features: Record<string, number>,
	featureDimension: number,
): Array<[number, number]> {
	const dimension = Math.max(8, Math.floor(featureDimension));
	const entries = new Map<number, number>();
	const add = (name: string, value: number) => {
		if (!Number.isFinite(value) || value === 0) return;
		const index = stableFeatureIndex(name, dimension);
		entries.set(index, (entries.get(index) ?? 0) + value);
	};
	for (const [name, value] of Object.entries(features)) add(`num:${name}`, value);
	const promptTokens = tokenizeForRelevance(prompt).slice(0, 64);
	const blockTokens = tokenizeForRelevance(blockText).slice(0, 256);
	const promptScale = promptTokens.length === 0 ? 0 : 1 / Math.sqrt(promptTokens.length);
	const blockScale = blockTokens.length === 0 ? 0 : 1 / Math.sqrt(blockTokens.length);
	for (const token of promptTokens) add(`prompt:${token}`, promptScale);
	for (const token of blockTokens) add(`block:${token}`, blockScale);
	const blockSet = new Set(blockTokens);
	let overlap = 0;
	for (const token of new Set(promptTokens)) {
		if (!blockSet.has(token)) continue;
		overlap++;
		add(`overlap:${token}`, 1);
	}
	add("pair:overlap_ratio", promptTokens.length === 0 ? 0 : overlap / promptTokens.length);
	const salience = categorizeSalienceMarkers(blockText);
	for (const [name, values] of Object.entries(salience)) {
		add(`salience:${name}`, Math.min(1, values.length / 4));
		for (const value of values.slice(0, 4)) add(`salience:${name}:${value.toLowerCase()}`, 1);
	}
	return [...entries.entries()].sort(([a], [b]) => a - b);
}

function stableFeatureIndex(name: string, dimension: number): number {
	const digest = createHash("sha256").update(name).digest();
	return digest.readUInt32BE(0) % dimension;
}

function dotSparseFeatures(entries: Array<[number, number]>, weights: number[]): number {
	let sum = 0;
	for (const [index, value] of entries) sum += (weights[index] ?? 0) * value;
	return sum;
}

export function validateConductorModelArtifact(artifact: ConductorModelArtifact): ConductorModelArtifact {
	if (artifact.version !== 1) throw new Error(`Unsupported Conductor model artifact version: ${artifact.version}`);
	if (!artifact.budgetOracle || !artifact.foldPolicy || !artifact.compression) {
		throw new Error("Conductor model artifact is missing one or more job sections");
	}
	validateFoldPolicyArtifact(artifact.foldPolicy);
	validateCompressionArtifact(artifact.compression);
	return artifact;
}

export function validateFoldPolicyArtifact(model: FoldPolicyModelArtifact): FoldPolicyModelArtifact {
	const architecture = model.architecture ?? "linear_replay";
	if (architecture !== "linear_replay" && architecture !== "minilm_cross_encoder_distilled") {
		throw new Error(`Unsupported fold policy architecture: ${architecture}`);
	}
	if (architecture === "minilm_cross_encoder_distilled") {
		if (model.encoder?.modelFamily !== "MiniLM") {
			throw new Error("MiniLM fold policy artifact must declare encoder.modelFamily=MiniLM");
		}
		if (!model.encoder.modelId || !/minilm/i.test(model.encoder.modelId)) {
			throw new Error("MiniLM fold policy artifact must declare a MiniLM modelId");
		}
		if (!model.encoder.pairTemplate || !model.encoder.pairTemplate.includes("{prompt}") || !model.encoder.pairTemplate.includes("{block}")) {
			throw new Error("MiniLM fold policy artifact must declare a prompt/block pairTemplate");
		}
		if (!model.distillation || model.distillation.teacherRecords <= 0 || model.distillation.trainingPairs <= 0) {
			throw new Error("MiniLM fold policy artifact requires teacher distillation metadata");
		}
		if (model.crossEncoderHead?.type !== "hashed_pair_regressor") {
			throw new Error("MiniLM fold policy artifact must include a runnable crossEncoderHead");
		}
		if (!Number.isFinite(model.crossEncoderHead.featureDimension) || model.crossEncoderHead.featureDimension <= 0) {
			throw new Error("MiniLM fold policy crossEncoderHead has invalid featureDimension");
		}
		if (model.crossEncoderHead.weights.length !== model.crossEncoderHead.featureDimension) {
			throw new Error("MiniLM fold policy crossEncoderHead weight dimension mismatch");
		}
		if (!Number.isFinite(model.crossEncoderHead.intercept) || !Number.isFinite(model.crossEncoderHead.confidence)) {
			throw new Error("MiniLM fold policy crossEncoderHead has invalid numeric weights");
		}
		if (model.crossEncoderHead.teacherPairs <= 0 || model.crossEncoderHead.trainingPairs <= 0) {
			throw new Error("MiniLM fold policy crossEncoderHead requires teacher-trained pairs");
		}
	}
	return model;
}

export function validateCompressionArtifact(model: CompressionModelArtifact): CompressionModelArtifact {
	if (model.mode !== "deterministic_extract" && model.mode !== "teacher_textual_digest_table") {
		throw new Error(`Unsupported compression artifact mode: ${model.mode}`);
	}
	if (model.mode === "teacher_textual_digest_table") {
		if (!model.fidelityGate) throw new Error("Textual compressor artifact must enable fidelityGate");
		if ((model.distillation?.teacherRecords ?? 0) <= 0 || (model.distillation?.compressionRecords ?? 0) <= 0) {
			throw new Error("Textual compressor artifact requires teacher compression distillation metadata");
		}
		if (!model.baseModel?.modelId || !["Qwen2.5", "local_textual"].includes(model.baseModel.modelFamily)) {
			throw new Error("Textual compressor artifact must declare a supported baseModel");
		}
		if (!model.adapter || !["LoRA", "digest_table"].includes(model.adapter.type)) {
			throw new Error("Textual compressor artifact must declare a LoRA or digest_table adapter");
		}
		if (!model.promptTemplate || !model.promptTemplate.includes("{block}")) {
			throw new Error("Textual compressor artifact must declare a block promptTemplate");
		}
		if (!model.digestTable || Object.keys(model.digestTable).length === 0) {
			throw new Error("Textual compressor artifact requires at least one teacher digest entry");
		}
	}
	return model;
}

export function parseConductorModelArtifact(json: string): ConductorModelArtifact {
	return validateConductorModelArtifact(JSON.parse(json) as ConductorModelArtifact);
}

export function validateConductorModelAuthority(authority: ConductorModelAuthority): ConductorModelAuthority {
	if (authority.version !== 1) throw new Error(`Unsupported Conductor model authority version: ${authority.version}`);
	if (!["shadow_only", "cost_guarded", "live"].includes(authority.authority?.budgetOracle?.mode)) {
		throw new Error(`Unsupported budget oracle authority mode: ${authority.authority?.budgetOracle?.mode}`);
	}
	if (!["shadow_only", "live"].includes(authority.authority?.foldPolicy?.mode)) {
		throw new Error(`Unsupported fold policy authority mode: ${authority.authority?.foldPolicy?.mode}`);
	}
	if (!["digest_only", "metadata_live"].includes(authority.authority?.compression?.mode)) {
		throw new Error(`Unsupported compression authority mode: ${authority.authority?.compression?.mode}`);
	}
	return authority;
}

export function parseConductorModelAuthority(json: string): ConductorModelAuthority {
	return validateConductorModelAuthority(JSON.parse(json) as ConductorModelAuthority);
}

function budgetAuthorityMode(authority?: ConductorModelAuthority): BudgetOracleAuthorityMode {
	return authority?.authority.budgetOracle.mode ?? "cost_guarded";
}

function foldPolicyAuthorityMode(authority?: ConductorModelAuthority): FoldPolicyAuthorityMode {
	return authority?.authority.foldPolicy.mode ?? "shadow_only";
}

function compressionAuthorityMode(authority?: ConductorModelAuthority): CompressionAuthorityMode {
	return authority?.authority.compression.mode ?? "digest_only";
}

export function createArtifactBudgetOracleProvider(
	artifact: ConductorModelArtifact,
	authority?: ConductorModelAuthority,
): BudgetOracleProvider {
	const model = validateConductorModelArtifact(artifact).budgetOracle;
	const mode = budgetAuthorityMode(authority);
	return async (request) => {
		const raw = dotFeatures(budgetArtifactFeatures(request), model);
		let targetMultiplier = clampModelOutput(raw, model);
		if (mode === "shadow_only") targetMultiplier = 1;
		else if (mode === "cost_guarded") {
			targetMultiplier = Math.min(authority?.authority.budgetOracle.maxTargetMultiplier ?? 1, targetMultiplier);
		}
		const cacheHitRate = Math.max(0.01, Math.min(1, 1 - Math.log1p(request.stats.totalTokens) / 20));
		return {
			value: {
				targetMultiplier,
				quality: Math.max(0, Math.min(1, 0.7 + (targetMultiplier - 1) * 0.8)),
				cacheHitRate,
				cost: Math.max(1, request.stats.totalTokens * targetMultiplier),
			},
			confidence: model.confidence,
			reason: `artifact:${artifact.source}`,
			authority: mode,
		};
	};
}

export function createArtifactFoldPolicyProvider(
	artifact: ConductorModelArtifact,
	authority?: ConductorModelAuthority,
): FoldPolicyProvider {
	const model = validateConductorModelArtifact(artifact).foldPolicy;
	const mode = foldPolicyAuthorityMode(authority);
	return async (request) => ({
		reason: `artifact:${artifact.source}`,
		predictions: request.items.map((item) => {
			const features = foldArtifactFeatures(item.features);
			const head = model.architecture === "minilm_cross_encoder_distilled" ? model.crossEncoderHead : undefined;
			const score = head
				? sigmoid(
						head.intercept +
						dotSparseFeatures(
							foldPolicyCrossEncoderFeatureEntries(request.prompt, item.block.text, features, head.featureDimension),
							head.weights,
						),
					)
				: sigmoid(dotFeatures(features, model));
			const expectedReuseTurns = Math.max(0, Math.round((1 - score) * model.reuseHorizonTurns));
			const reason = head ? `artifact:${artifact.source}:cross_encoder_head` : `artifact:${artifact.source}:linear_head`;
			return {
				value: {
					blockId: item.block.id,
					blockHash: item.blockHash,
					expectedReuseTurns,
					keepScore: score,
					level: reuseDistanceToFoldLevel(expectedReuseTurns),
					reason,
				},
				confidence: Math.max(0, Math.min(1, (head?.confidence ?? model.confidence) * (0.8 + Math.abs(score - 0.5) * 0.4))),
				reason,
				authority: mode,
			};
		}),
	});
}

export function createArtifactCompressionProvider(
	artifact: ConductorModelArtifact,
	authority?: ConductorModelAuthority,
): CompressionProvider {
	const model = validateConductorModelArtifact(artifact).compression;
	const mode = compressionAuthorityMode(authority);
	return async ({ block, hash, deterministicDigest }) => {
		const entry = model.mode === "teacher_textual_digest_table" ? model.digestTable?.[hash] : undefined;
		const digest = entry?.digest ?? deterministicDigest;
		const value: CompressionValue = { digest };
		if (mode === "metadata_live") {
			value.salience = entry
				? {
						paths: entry.fidelityLabels.paths,
						commands: entry.fidelityLabels.commands,
						errors: entry.fidelityLabels.errors,
						exact_values: entry.fidelityLabels.exactValues,
						decisions: entry.fidelityLabels.decisions,
					}
				: salienceMetadataFromText(block.text, digest);
		}
		return {
			value,
			confidence: model.confidence,
			reason: entry ? `artifact:${artifact.source}:teacher_digest` : `artifact:${artifact.source}:deterministic_fallback`,
			authority: mode,
		};
	};
}

export function createArtifactConductorModelProviders(
	artifact: ConductorModelArtifact,
	authority?: ConductorModelAuthority,
): Pick<ConductorDependencies, "budgetOracle" | "foldPolicyProvider" | "compressionProvider"> {
	const validated = validateConductorModelArtifact(artifact);
	const validatedAuthority = authority ? validateConductorModelAuthority(authority) : undefined;
	return {
		budgetOracle: createArtifactBudgetOracleProvider(validated, validatedAuthority),
		foldPolicyProvider: createArtifactFoldPolicyProvider(validated, validatedAuthority),
		compressionProvider: createArtifactCompressionProvider(validated, validatedAuthority),
	};
}

export function createLocalBudgetOracleProvider(): BudgetOracleProvider {
	return async (request) => {
		const manyBlocks = request.stats.blockCount >= 80 || request.stats.turnCount >= 30;
		const largeBlocks = request.stats.maxBlockTokens >= 1_200;
		const riskyPrompt = promptHasHighRecallRisk(request.prompt);
		let targetMultiplier = 1;
		if (riskyPrompt) targetMultiplier += 0.06;
		if (!riskyPrompt && manyBlocks) targetMultiplier -= 0.04;
		if (!riskyPrompt && largeBlocks) targetMultiplier -= 0.02;
		return {
			value: {
				targetMultiplier: Math.max(0.85, Math.min(1.12, targetMultiplier)),
				quality: riskyPrompt ? 0.78 : 0.7,
				cacheHitRate: manyBlocks ? 0.74 : 0.86,
				cost: Math.max(1, request.stats.totalTokens),
			},
			confidence: 0.72,
			reason: "local_deterministic_prior",
		};
	};
}

export function createLocalFoldPolicyProvider(): FoldPolicyProvider {
	return async (request) => ({
		reason: "local_deterministic_prior",
		predictions: request.items.map((item) => {
			const f = item.features;
			const hot = f.agentAttention >= 0.8 || f.keywordOverlap >= 0.55 || f.wasRecentlyUnfolded;
			const soon = f.keywordOverlap >= 0.25 || f.agentAttention >= 0.35 || f.recency >= 0.85;
			const expectedReuseTurns = hot ? 0 : soon ? 3 : f.tokenCount >= 600 ? 12 : 8;
			const keepScore = Math.max(
				0,
				Math.min(
					1,
					f.kindRank * 0.2 +
						f.keywordOverlap * 0.45 +
						f.recency * 0.2 +
						f.agentAttention * 0.35 +
						(f.wasRecentlyUnfolded ? 0.25 : 0),
				),
			);
			return {
				value: {
					blockId: item.block.id,
					blockHash: item.blockHash,
					expectedReuseTurns,
					keepScore,
					level: reuseDistanceToFoldLevel(expectedReuseTurns),
					reason: "local_deterministic_prior",
				},
				confidence: hot || soon ? 0.78 : 0.7,
				reason: "local_deterministic_prior",
			};
		}),
	});
}

export function createLocalCompressionProvider(): CompressionProvider {
	return async ({ block, deterministicDigest }) => ({
		value: {
			digest: deterministicDigest,
			salience: salienceMetadataFromText(block.text, deterministicDigest),
		},
		confidence: 0.75,
		reason: "local_deterministic_prior",
	});
}

export function createLocalConductorModelProviders(
	options: LocalConductorModelProviderOptions = {},
): Pick<ConductorDependencies, "budgetOracle" | "foldPolicyProvider" | "compressionProvider"> {
	const enableBudgetOracle = options.budgetOracle ?? true;
	const enableFoldPolicyProvider = options.foldPolicyProvider ?? true;
	const enableCompressionProvider = options.compressionProvider ?? true;
	return {
		budgetOracle: enableBudgetOracle ? createLocalBudgetOracleProvider() : undefined,
		foldPolicyProvider: enableFoldPolicyProvider ? createLocalFoldPolicyProvider() : undefined,
		compressionProvider: enableCompressionProvider ? createLocalCompressionProvider() : undefined,
	};
}

export async function warmConductorModel(
	input: WarmConductorModelInput,
	deps: ConductorDependencies = {},
): Promise<void> {
	const state = input.state;
	const promptHash = textHash(input.prompt);
	const currentTurn = input.currentTurn ?? Math.max(0, ...input.blocks.map((block) => block.turn));
	const shadow = isConductorShadowEnabled(deps);
	const targetModelId = input.targetModelId ?? deps.targetModelId;
	const now = deps.now?.() ?? Date.now();

	const tasks: Array<Promise<void>> = [];

	if (deps.budgetOracle) {
		tasks.push((async () => {
			const calibratedTarget = clampFoldTarget(state.foldTargetCalibrated ?? state.config.foldTargetInitial, foldTargetBand(state.config));
			const request: BudgetOracleRequest = {
				prompt: input.prompt,
				promptHash,
				currentTurn,
				calibratedTarget,
				targetModelId,
				stats: conductorStats(input.blocks),
			};
			try {
				const result = await withModelTimeout(deps.budgetOracle!(request), deps);
				const fallbackReason = result.confidence < modelConfidenceFloor(deps) ? "confidence_below_floor" : undefined;
				state.model.budgetOracle = { ...result, promptHash, turn: currentTurn, shadow, createdAt: now, fallbackReason };
				if (shadow) {
					recordShadowTrace(state, deps, {
						kind: "budget_oracle",
						turn: currentTurn,
						heuristicDecision: { foldTarget: calibratedTarget },
						modelDecision: result.value,
						outcome: "pending",
						reason: fallbackReason,
					});
				}
			} catch (error: any) {
				state.model.budgetOracle = {
					value: { targetMultiplier: 1 },
					confidence: 0,
					promptHash,
					turn: currentTurn,
					shadow,
					createdAt: now,
					fallbackReason: error?.message || "budget_oracle_failed",
				};
			}
		})());
	}

	if (deps.foldPolicyProvider) {
		tasks.push((async () => {
			const items = input.blocks.flatMap((block) => {
				const blockHash = textHash(block.text);
				const cached = state.model.foldPolicyCache[blockHash];
				if (cached && cached.promptHash === promptHash) return [];
				return [{
					block,
					blockHash,
					features: foldPolicyFeatures(block, input.prompt, currentTurn, state, input.messages),
				}];
			});
			if (items.length === 0) return;
			try {
				const response = await withModelTimeout(deps.foldPolicyProvider!({
					prompt: input.prompt,
					promptHash,
					currentTurn,
					targetModelId,
					items,
				}), deps);
				const byHash = new Map(items.map((item) => [item.blockHash, item]));
				for (const prediction of response.predictions) {
					const blockHash = prediction.value.blockHash;
					const item = byHash.get(blockHash);
					if (!item) continue;
					const fallbackReason = prediction.confidence < modelConfidenceFloor(deps) ? "confidence_below_floor" : undefined;
					state.model.foldPolicyCache[blockHash] = {
						...prediction,
						blockHash,
						promptHash,
						turn: currentTurn,
						features: item.features,
						shadow,
						createdAt: now,
						fallbackReason,
					};
					if (shadow) {
						recordShadowTrace(state, deps, {
							kind: "fold_policy",
							turn: currentTurn,
							blockId: prediction.value.blockId,
							heuristicDecision: { score: undefined },
							modelDecision: prediction.value,
							outcome: "pending",
							reason: fallbackReason,
						});
					}
				}
			} catch (error: any) {
				deps.log?.(`Accordion Conductor model warm-up failed: ${error?.message || error}`);
			}
		})());
	}

	if (deps.compressionProvider) {
		for (const block of input.blocks) {
			const hash = contentHash(block);
			if (state.model.compressionCache[hash]) continue;
			tasks.push((async () => {
				const digest = deterministicDigest(block);
				try {
					const result = await withModelTimeout(deps.compressionProvider!({ block, hash, deterministicDigest: digest }), deps);
					const fidelityFailure = compressionFidelityFailure(block, result.value);
					const fallbackReason =
						result.confidence < modelConfidenceFloor(deps)
							? "confidence_below_floor"
							: fidelityFailure;
					const accepted = !fallbackReason;
					state.model.compressionCache[hash] = {
						...result,
						hash,
						accepted,
						shadow,
						createdAt: now,
						fallbackReason,
					};
					if (accepted && !shadow) {
						state.salienceMetadata[hash] = mergeMetadata(
							salienceMetadataFromText(block.text, result.value.digest),
							result.value.salience,
						);
					}
					if (shadow) {
						recordShadowTrace(state, deps, {
							kind: "compression",
							turn: block.turn,
							blockId: block.id,
							heuristicDecision: { digest },
							modelDecision: result.value,
							outcome: accepted ? "accepted" : "fallback",
							reason: fallbackReason,
						});
					}
				} catch (error: any) {
					state.model.compressionCache[hash] = {
						value: { digest },
						confidence: 0,
						hash,
						accepted: false,
						shadow,
						createdAt: now,
						fallbackReason: error?.message || "compression_failed",
					};
				}
			})());
		}
	}

	await Promise.all(tasks);
	pruneModelCaches(state);
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
	const hash = contentHash(block);

	const compressed = state.model.compressionCache[hash];
	if (compressed && modelAuthorityAllowed(deps)) {
		if (
			compressed.accepted &&
			!compressed.fallbackReason &&
			compressed.confidence >= modelConfidenceFloor(deps)
		) {
			state.salienceMetadata[hash] = mergeMetadata(
				salienceMetadataFromText(block.text, compressed.value.digest),
				compressed.value.salience,
			);
			return compressed.value.digest;
		}
		const digest = deterministicDigest(block);
		state.salienceMetadata[hash] = mergeMetadata(salienceMetadataFromText(block.text, digest), state.salienceMetadata[hash]);
		return digest;
	}

	const cached = state.summaryCache[hash];
	if (cached) return cached;

	const digest = deterministicDigest(block);
	state.salienceMetadata[hash] = mergeMetadata(salienceMetadataFromText(block.text, digest), state.salienceMetadata[hash]);

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

	// Pressure-active run: tick the calibrated fold target, then let a warmed,
	// confidence-gated oracle adjust it inside the same configured band.
	const calibratedTarget = calibrateFoldTarget(input.state, currentTurn, deps);
	const foldTarget = applyBudgetOracleTarget(input.state, currentTurn, calibratedTarget, deps);
	const weights = choosePromptWeights(input.incomingPrompt, input.state, currentTurn, foldTarget);

	const availableBudget = Math.max(0, input.budgetTokens - pinnedTokens);
	const targetTokens = pinnedTokens + Math.floor(availableBudget * weights.foldTargetRatio);
	const units = applyMmrRedundancyPenalty(
		buildFoldUnits(parsed.blocks, input.incomingPrompt, currentTurn, input.state)
			.map((unit) => unitScore(unit, input.incomingPrompt, weights, currentTurn, input.state, deps)),
		input.state,
	).sort((a, b) => a.score - b.score || a.blocks[0].order - b.blocks[0].order);
	const canFoldUnit = (unit: FoldUnit) =>
		unit.foldable &&
		unit.foldedTokens < unit.fullTokens &&
		!unit.blocks.some(
			(block) =>
				isPinned(block, input.state) ||
				isConductorPinned(block, input.state, currentTurn) ||
				protectedIds.has(block.id) ||
				isGraceProtected(block, input.state, currentTurn) ||
				isInFoldedGroup(block, input.state),
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
	const canFoldByUnitId = new Map<string, boolean>();
	const learnedTargetByUnitId = new Map<string, FoldLevel | undefined>();
	const digestByUnitId = new Map<string, string>();
	const digestTokensByUnitId = new Map<string, Set<string>>();
	for (const unit of units) {
		canFoldByUnitId.set(unit.id, canFoldUnit(unit));
		learnedTargetByUnitId.set(unit.id, learnedUnitFoldLevel(unit, input.incomingPrompt, input.state, deps));
	}
	const digestForUnit = (unit: FoldUnit): string => {
		const cached = digestByUnitId.get(unit.id);
		if (cached !== undefined) return cached;
		const digest = deterministicDigest(unit.blocks[0]);
		digestByUnitId.set(unit.id, digest);
		return digest;
	};
	const digestTokensForUnit = (unit: FoldUnit): Set<string> => {
		const cached = digestTokensByUnitId.get(unit.id);
		if (cached) return cached;
		const tokens = new Set(tokenizeForRelevance(digestForUnit(unit)));
		digestTokensByUnitId.set(unit.id, tokens);
		return tokens;
	};
	const digestOverlapForUnits = (seed: FoldUnit, other: FoldUnit): number => {
		const seedTokens = digestTokensForUnit(seed);
		if (seedTokens.size === 0) return 0;
		const otherTokens = digestTokensForUnit(other);
		let shared = 0;
		for (const token of seedTokens) if (otherTokens.has(token)) shared++;
		return shared / seedTokens.size;
	};
	const hasAlternativeFoldCandidate = (unit: FoldUnit): boolean =>
		units.some((other) =>
			other.id !== unit.id &&
			canFoldByUnitId.get(other.id) === true &&
			unitLevel(other) < 2 &&
			learnedTargetByUnitId.get(other.id) !== 0,
		);

	// Normalize: non-foldable units snap to full; mixed-level units snap to their
	// shallowest member, so tool pairs always move as one unit — the same
	// atomicity invariant the binary system enforced.
	for (const unit of units) {
		const blockLevels = unit.blocks.map((block) => levels.get(block.id) ?? 0);
		const hasFold = blockLevels.some((level) => level > 0);
		if (!canFoldByUnitId.get(unit.id)) {
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
			if (!canFoldByUnitId.get(unit.id)) continue;
			const current = unitLevel(unit);
			if (current >= 2) continue;
			const currentTokens = tokensAt(unit, current);
			const learnedTarget = learnedTargetByUnitId.get(unit.id);
			if (learnedTarget === 0 && hasAlternativeFoldCandidate(unit)) {
				continue;
			}
			if (learnedTarget !== undefined && learnedTarget > current) {
				const targetLevel: FoldLevel = learnedTarget === 1 && unit.trimEligible ? 1 : 2;
				const saved = currentTokens - tokensAt(unit, targetLevel);
				if (saved > 0) {
					setUnitLevel(unit, targetLevel);
					live -= saved;
					continue;
				}
			}
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
		const add = (key: keyof typeof cats, values: string[] | undefined) => {
			for (const value of values ?? []) {
				const t = value.trim();
				if (t && cats[key].size < 3) cats[key].add(t);
			}
		};
		for (const unit of group) {
			for (const block of unit.blocks) {
				const metadata = input.state.salienceMetadata[contentHash(block)];
				if (metadata) {
					add("paths", metadata.paths);
					add("commands", metadata.commands);
					add("errors", metadata.errors);
					add("exact_values", metadata.exact_values);
					add("decisions", metadata.decisions);
					continue;
				}
				const digest = deterministicDigest(block);
				const match = digest.match(/⟦([^⟧]+)⟧\s*$/);
				if (!match || /^(?:group|trim)\b/.test(match[1].trim())) continue;
				for (const part of match[1].split(/\s*∣\s*/)) {
					const colon = part.indexOf(":");
					if (colon < 0) continue;
					const key = part.slice(0, colon).trim() as keyof typeof cats;
					if (!(key in cats)) continue;
					add(key, part.slice(colon + 1).split(/,\s*/));
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
			if (canFoldByUnitId.get(unit.id) && unitLevel(unit) === 2) run.push(unit);
			else flushRun();
		}
		flushRun();
	}

	// Semantic grouping second pass: if contiguous grouping didn't reach the target,
	// cluster non-adjacent L2 blocks by digest-text keyword overlap (≥ SEMANTIC_GROUP_OVERLAP_THRESHOLD
	// pairwise against the seed). Fires only when there are ≥ GROUP_MIN_UNITS candidates.
	if (live > targetTokens) {
		const ungroupedL2 = [...units]
			.filter((unit) => canFoldByUnitId.get(unit.id) && unitLevel(unit) === 2 && !groupHeadMeta.has(unit.blocks[0].id))
			.sort((a, b) => b.score - a.score) // highest relevance first = best group head
			.slice(0, SEMANTIC_GROUP_MAX_CANDIDATES);
		if (ungroupedL2.length >= GROUP_MIN_UNITS) {
			const used = new Set<string>();
			for (const seed of ungroupedL2) {
				if (live <= targetTokens) break;
				if (used.has(seed.id)) continue;
				const group = [seed];
				for (const other of ungroupedL2) {
					if (other === seed || used.has(other.id)) continue;
					if (digestOverlapForUnits(seed, other) >= SEMANTIC_GROUP_OVERLAP_THRESHOLD) {
						group.push(other);
					}
				}
				if (group.length < GROUP_MIN_UNITS) continue;
				// Form group: seed is head; group members go to L3
				let saved = 0;
				for (const member of group.slice(1)) {
					if (canFoldByUnitId.get(member.id) && unitLevel(member) === 2) {
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
	recordFoldPolicyShadowOutcomes(parsed.blocks, levels, input.incomingPrompt, input.state, deps, currentTurn);

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

function recordFoldPolicyShadowOutcomes(
	blocks: ContextBlock[],
	finalLevels: Map<string, FoldLevel>,
	prompt: string,
	state: AccordionState,
	deps: ConductorDependencies,
	currentTurn: number,
): void {
	if (!isConductorShadowEnabled(deps)) return;
	const promptHash = textHash(prompt);
	for (const block of blocks) {
		const cached = state.model.foldPolicyCache[textHash(block.text)];
		if (!cached || cached.promptHash !== promptHash || !cached.shadow) continue;
		const heuristicLevel = (finalLevels.get(block.id) ?? 0) as FoldLevel;
		const modelLevel = normalizeLevel(cached.value.level ?? reuseDistanceToFoldLevel(cached.value.expectedReuseTurns));
		recordShadowTrace(state, deps, {
			kind: "fold_policy",
			turn: currentTurn,
			blockId: block.id,
			heuristicDecision: { level: heuristicLevel },
			modelDecision: { ...cached.value, level: modelLevel },
			outcome: "pending",
			reason: cached.fallbackReason ?? (heuristicLevel === modelLevel ? "agreement" : "disagreement"),
		});
	}
}

function normalizeReason(reason: string | string[]): string[] {
	return Array.isArray(reason) ? reason : [reason];
}

export function extractConductorTraceLabels(input: ConductorTraceExtractionInput): ConductorTraceDataset {
	const sortedChanges = [...input.state.manualChanges].sort((a, b) => a.turn - b.turn);
	const foldTurnsByBlock = new Map<string, number[]>();
	for (const change of sortedChanges) {
		if (change.action !== "fold") continue;
		const turns = foldTurnsByBlock.get(change.blockId) ?? [];
		turns.push(change.turn);
		foldTurnsByBlock.set(change.blockId, turns);
	}

	const manualChanges = sortedChanges.map((change): ManualChangeTraceLabel => {
		let reuseDistanceTurns: number | undefined;
		if (change.action === "unfold") {
			const priorFold = (foldTurnsByBlock.get(change.blockId) ?? [])
				.filter((turn) => turn <= change.turn)
				.at(-1);
			if (priorFold !== undefined) reuseDistanceTurns = change.turn - priorFold;
		}
		return {
			source: "manualChanges",
			blockId: change.blockId,
			action: change.action,
			actor: change.actor,
			turn: change.turn,
			reuseDistanceTurns,
		};
	});

	const foldDecisions = (input.decisions ?? []).map((decision): FoldDecisionTraceLabel => ({
		source: "foldDecision",
		blockId: decision.blockId,
		action: decision.action,
		turn: decision.turn,
		kind: decision.kind,
		level: normalizeLevel(decision.level ?? (decision.action === "fold" ? 2 : 0)),
		reason: normalizeReason(decision.reason),
	}));

	const niahHoldouts = (input.niahNeedles ?? []).map((needle): NiahHoldoutTraceLabel => ({
		source: "niah",
		blockId: needle.blockId,
		turn: needle.turn,
		needle: needle.needle,
		shouldKeep: true,
	}));

	const compactSweeps = (input.compactSweeps ?? []).map((cell): CompactSweepTraceLabel => {
		const cost = Math.max(1, cell.tokenSpend ?? cell.budgetTokens);
		const cache = cell.cacheHitRate ?? 1;
		return {
			source: "compactSweep",
			scenario: cell.scenario,
			budgetTokens: cell.budgetTokens,
			accordionScore: cell.accordionScore,
			compactScore: cell.compactScore,
			tokenSpend: cell.tokenSpend,
			cacheHitRate: cell.cacheHitRate,
			jointScore: (cell.accordionScore * cache) / cost,
		};
	});

	return { manualChanges, foldDecisions, niahHoldouts, compactSweeps };
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

function ollamaOpenAIBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/$/, "");
	return /\/v\d+(?:\/|$)/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function createOllamaSummaryProvider(options: OllamaSummaryProviderOptions = {}): SummaryProvider {
	return createOpenAICompatibleSummaryProvider({
		baseUrl: ollamaOpenAIBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL),
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
