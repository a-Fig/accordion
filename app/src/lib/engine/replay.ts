/*
 * replay.ts — deterministic replay driver for the accordion engine.
 *
 * Feeds a pre-parsed block array through AccordionStore turn-by-turn, collecting
 * performance metrics: budget violations, fold churn, agent unfold hits/misses.
 *
 * This is the eval backbone for later milestones — import it from tests and scripts.
 * Node-safe; no Svelte imports.
 */
import type { Block, ParsedSession } from "./types";
import { AccordionStore } from "./store.svelte";
import { foldCode } from "./digest";
import { messageKey } from "./ids";

export interface ReplayOptions {
	/** Token budget (default: store default 70_000). */
	budget?: number;
	/** Protected tail target in tokens (default: store default 20_000). */
	protectTokens?: number;
	/** If true (default), apply agent unfold tool_calls via store.unfold. */
	applyAgentUnfolds?: boolean;
}

export interface ReplayMiss {
	/** Turn number at which the agent called unfold. */
	turn: number;
	/** The fold code the agent sent. */
	code: string;
	/** Block id the code resolves to (null if no matching block found at all). */
	blockId: string | null;
	/** True if that block was actually folded at the moment the agent requested unfold. */
	wasFolded: boolean;
	/**
	 * True if the block was already live due to conductor action (cooldown / conductor-unfold).
	 * A preempted block is one the conductor already restored — so the agent's request was
	 * redundant but not a true miss (the content was available).
	 */
	preempted: boolean;
}

export interface ReplayMetrics {
	/** Number of turns processed. */
	turns: number;
	/** Agent unfold requests where the target block was folded at request time. */
	misses: ReplayMiss[];
	/** Fold churn delta per turn (entries === turns). */
	churnPerTurn: number[];
	/** Number of turns where liveTokens > budget after refold. */
	budgetViolations: number;
	/** Final live token count. */
	finalLive: number;
	/** Final saved token count. */
	finalSaved: number;
	/** Final folded block count. */
	foldedCount: number;
	/** Total lexical conductor unfolds across the whole session. */
	lexicalUnfolds: number;
}

/**
 * Extract unfold tokens from a tool_call block's text.
 *
 * parse.ts emits pi tool_call text as: `${b.name} ${JSON.stringify(b.arguments ?? {})}`
 * and Claude Code tool_call text as: `${b.name} ${JSON.stringify(b.input ?? {})}`
 *
 * The real pi corpus uses `arguments.ids` with full durable block ids
 * (e.g. "a:what-i-learned:p202"), while the live tool contract uses `codes`
 * with 6-char fold codes (e.g. "abc123"). We parse BOTH arrays and return
 * all tokens found in either field.
 */
function extractUnfoldCodes(text: string): string[] {
	// Try to parse: skip tool name prefix, then parse JSON
	const jsonStart = text.indexOf("{");
	if (jsonStart < 0) return [];
	try {
		const obj = JSON.parse(text.slice(jsonStart));
		if (obj) {
			const tokens: string[] = [];
			// Parse `ids` array (real pi corpus: full durable block ids)
			if (Array.isArray(obj.ids)) {
				for (const t of obj.ids) if (typeof t === "string") tokens.push(t);
			}
			// Parse `codes` array (live tool contract: 6-char fold codes)
			if (Array.isArray(obj.codes)) {
				for (const t of obj.codes) if (typeof t === "string") tokens.push(t);
			}
			if (tokens.length > 0) return tokens;
		}
	} catch {
		// fallback: regex extraction for robustly handling partial JSON
	}
	// Fallback: regex for both "ids":[...] and "codes":[...] patterns
	const tokens: string[] = [];
	for (const field of ["ids", "codes"]) {
		const re = new RegExp(`"${field}"\\s*:\\s*\\[([^\\]]*)\\]`);
		const match = text.match(re);
		if (match) {
			const inner = match[1];
			const itemRe = /"([^"]+)"/g;
			let m: RegExpExecArray | null;
			while ((m = itemRe.exec(inner)) !== null) {
				tokens.push(m[1]);
			}
		}
	}
	return tokens;
}

/**
 * Resolve an unfold token (which may be a full block id, a message-key prefix, or a
 * 6-char fold code) to the matching store blocks.
 *
 * Resolution order:
 *   1. token === b.id  (exact full id match — real corpus `arguments.ids`)
 *   2. messageKey(token) === messageKey(b.id)  (message-key match)
 *   3. foldCode(b.id) === token  (6-char fold code — live tool contract)
 */
function resolveToken(token: string, blocks: readonly Block[]): Block[] {
	// Pass 1: exact id match
	const exact = blocks.filter((b) => b.id === token);
	if (exact.length > 0) return exact;
	// Pass 2: message-key match (e.g. token = "a:what-i-learned" matches "a:what-i-learned:p202")
	const tokenKey = messageKey(token);
	const byKey = blocks.filter((b) => messageKey(b.id) === tokenKey);
	if (byKey.length > 0) return byKey;
	// Pass 3: fold code match
	return blocks.filter((b) => foldCode(b.id) === token);
}

/**
 * Replay a parsed block array through the engine, turn by turn.
 *
 * Blocks are grouped by `b.turn` (all blocks of turn t in one appendBlocks call).
 * Turn 0 (preamble) is fed first as its own group.
 *
 * For each turn:
 *   1. Feed the turn's blocks via appendBlocks (triggers refold).
 *   2. Detect agent unfold tool_calls; resolve codes → blocks; record misses.
 *   3. Record churn delta and budget violation.
 */
export function replay(blocks: Block[], opts: ReplayOptions = {}): ReplayMetrics {
	const applyAgentUnfolds = opts.applyAgentUnfolds !== false; // default true

	// Build a minimal ParsedSession — the store needs meta but doesn't use it for replay
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "replay", cwd: "", model: "" },
		blocks: [],
		lineCount: 0,
		skipped: 0,
	};

	const store = new AccordionStore(parsed);

	if (opts.budget !== undefined) store.setBudget(opts.budget);
	if (opts.protectTokens !== undefined) store.setProtect(opts.protectTokens);

	// Group blocks by turn
	const byTurn = new Map<number, Block[]>();
	for (const b of blocks) {
		const t = b.turn;
		const arr = byTurn.get(t);
		if (arr) arr.push(b);
		else byTurn.set(t, [b]);
	}

	// Sort turns (0 = preamble first, then 1, 2, 3, ...)
	const turns = [...byTurn.keys()].sort((a, b) => a - b);

	const metrics: ReplayMetrics = {
		turns: 0,
		misses: [],
		churnPerTurn: [],
		budgetViolations: 0,
		finalLive: 0,
		finalSaved: 0,
		foldedCount: 0,
		lexicalUnfolds: 0,
	};

	for (const t of turns) {
		const turnBlocks = byTurn.get(t)!;
		const flipsBefore = store.foldFlips;

		// Feed the turn's blocks
		store.appendBlocks(turnBlocks);

		// Record churn for this turn
		const churnDelta = store.foldFlips - flipsBefore;
		metrics.churnPerTurn.push(churnDelta);
		metrics.turns++;

		// Check budget violation
		if (store.liveTokens > store.budget) {
			metrics.budgetViolations++;
		}

		// Detect agent unfold tool_calls in this turn's blocks
		const unfoldCalls = turnBlocks.filter((b) => b.kind === "tool_call" && b.toolName === "unfold");
		for (const call of unfoldCalls) {
			const tokens = extractUnfoldCodes(call.text);
			for (const code of tokens) {
				// Resolve the token (full id, message key, or fold code) to matching blocks
				const matching = resolveToken(code, store.blocks);
				const blockId = matching[0]?.id ?? null;

				let wasFolded = false;
				let preempted = false;

				if (matching.length > 0) {
					const target = matching[0];
					wasFolded = store.isFolded(target);
					// Preempted: block is live, but it was unfurled by the conductor
					// (by === "conductor" means conductor did something; coolUntil > 0 means cooldown active)
					if (!wasFolded && (target.by === "conductor" || store.recallsOf(target.id).length > 0)) {
						preempted = true;
					}
				}

				if (wasFolded) {
					metrics.misses.push({ turn: t, code, blockId, wasFolded: true, preempted: false });
				} else if (!preempted && blockId !== null) {
					// Block exists and is live for some other reason — not a miss, not preempted
					// Still record for completeness but do NOT count as a miss
					// (spec: "still count as non-miss with preempted=false but wasFolded=false")
				}

				// Apply the unfold if requested
				if (applyAgentUnfolds && matching.length > 0) {
					for (const target of matching) {
						if (store.isFolded(target)) {
							store.unfold(target.id, "agent");
						}
					}
				}
			}
		}
	}

	// Count lexical unfolds: log entries with action "unfolded" and by "conductor"
	metrics.lexicalUnfolds = store.log.filter((e) => e.by === "conductor" && e.action === "unfolded").length;

	metrics.finalLive = store.liveTokens;
	metrics.finalSaved = store.savedTokens;
	metrics.foldedCount = store.foldedCount;

	return metrics;
}
