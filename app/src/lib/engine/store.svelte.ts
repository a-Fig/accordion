/*
 * store.svelte.ts — the accordion model.
 *
 * Owns every block's fold state and runs the automatic folder. This is the
 * single source of truth; the UI only renders it and calls its actions. Folding
 * is content substitution, never removal: a folded block still exists and still
 * carries its callId, so a tool_call/result pair is never structurally broken.
 *
 * The conductor pipeline (C1 Cold-Score):
 *   Step 0: pruneProtectedGroups
 *   Step 1: heal protected manual folds
 *   Step 2: lexical pre-unfold — blocks referenced in the tail get a second chance
 *   Step 3: budget clamp — cold-score sorted greedy fold
 *   Step 4: relaxed pass — enforce budget even if hysteresis blocked some candidates
 */
import type { Block, BlockKind, Actor, SessionMeta, ParsedSession, Group } from "./types";
import { digest, digestTokens, foldTag, groupDigest, groupDigestTokens, FOLDABLE_KINDS } from "./digest";
import { estTokens, BLOCK_OVERHEAD } from "./tokens";
import { messageKey } from "./ids";
import { extractIdentifiers, matchBlocks } from "./lexical";
import { sortCandidates } from "./score";
import { findCoalesceRuns, COALESCE_CONFIG } from "./coalesce";

/** Classification of a folded group's members for accounting + the wire (ADR 0006 §4/§5). */
interface GroupShape {
	members: Block[];
	/** Members that collapse into the one summary entry (whole, pair-balanced messages). */
	collapsedMembers: Block[];
	collapsed: Set<string>;
	/** Members kept LIVE at full size — a tool-pair half whose partner is outside the group. */
	stragglers: Set<string>;
	/** First collapsed member (by order): the one block that "carries" the summary's token cost. */
	carrier: string | null;
}

/** Lower value → folded sooner. The whole asymmetry the tool is built around. */
const FOLD_RANK: Record<BlockKind, number> = {
	tool_result: 0, // huge, decays fastest → fold first, hardest
	thinking: 1, // ephemeral reasoning
	text: 2, // conclusions, medium durable value
	tool_call: 3, // tiny + durable record of an action → fold last
	user: 4, // the instruction/intent → fold last of all
};

/** Whole-block slack allowed above `protectTokens` before the next older block is left foldable. */
const PROTECT_OVERFLOW_CAP = 1.25;

export interface LogEntry {
	by: Actor;
	action: string;
	detail: string;
	n: number;
}

/**
 * Hysteresis constants for the conductor pipeline.
 *
 * unfoldCooldownTurns: after a conductor-unfold, the block may not be auto-refolded
 *   for this many turns. Hysteresis is best-effort: if every candidate is on cooldown
 *   and the budget is exceeded, the relaxed pass folds anyway.
 *
 * maxLexicalUnfoldsPerPass: maximum blocks the lexical pre-unfold step restores per
 *   refold() pass. Prevents a noisy tail from unfurling the entire history.
 */
export const HYSTERESIS = {
	unfoldCooldownTurns: 5,
	maxLexicalUnfoldsPerPass: 4,
};

export class AccordionStore {
	meta: SessionMeta;
	blocks = $state<Block[]>([]);
	/** Token budget for the live context window. */
	budget = $state(70_000);
	/** Model's total context window, as reported by pi (null until known). */
	contextWindow = $state<number | null>(null);
	/**
	 * The protected working tail: the most recent blocks up to this token target are
	 * NEVER auto-folded, with a strict 25% whole-block overflow cap so a huge boundary
	 * block cannot silently double the protected region. When target > 0, the newest block
	 * is always protected even if it alone exceeds the cap. When target === 0, protection
	 * is fully disabled — all blocks are foldable. The automatic folder and the future
	 * Conductor only ever operate on context older than this window — the recent ~N
	 * tokens stay verbatim. Protection is absolute: manual folds are refused there too.
	 */
	protectTokens = $state(20_000);
	log = $state<LogEntry[]>([]);
	private logN = 0;
	/** Bumped on every settled change — a cheap redraw signal for canvas views. */
	version = $state(0);
	/**
	 * Multiblock folds (ADR 0006). Human-created groups, each collapsing a contiguous run
	 * of blocks into one tile/entry. An OVERLAY over `blocks` — never mutates a block, so
	 * all block-indexed math (index / protectedFromIndex / append dedup) is untouched.
	 */
	groups = $state<Group[]>([]);
	/**
	 * id → position lookup, kept in lockstep with `blocks` (built in the constructor,
	 * extended in `appendBlocks` — the only two paths that change the array's length or
	 * order). Turns `get(id)`, `appendBlocks` dedup, and `isProtected` from O(n) scans into
	 * O(1) reads; not reactive (it only changes when `blocks` does, and every reactive
	 * consumer already depends on `blocks`).
	 */
	private index = new Map<string, number>();

	// ---- conductor state (non-reactive, internal) ----------------------------
	/**
	 * Recall history: block id → array of turn numbers at which this block was
	 * unfolded by the agent or user. NOT $state — mutated imperatively. Bumps
	 * this.version on change so reactive consumers re-derive.
	 */
	private recalls = new Map<string, number[]>();
	/**
	 * Cooldown: block id → turn number until which auto-refold is forbidden (after
	 * a conductor-unfold). Best-effort: budget is the hard guarantee.
	 */
	private coolUntil = new Map<string, number>();
	/**
	 * Group-level hysteresis (ADR 0009 §5): first-member id → turn number until which
	 * a conductor-built group may NOT re-form. Set when a conductor group is dissolved
	 * (unfoldGroup or deleteGroup). Group hysteresis is 8 turns (vs block hysteresis 5).
	 * Applied by findCoalesceRuns via the groupCoolActive adapter.
	 */
	private groupCool = new Map<string, number>();
	/**
	 * Re-entrancy guard: createGroup() calls refold() internally; when coalesce's
	 * refold() call reaches createGroup() which calls refold() again, the inner refold
	 * must be a no-op. Set to true at refold() entry, false in finally.
	 */
	private _inRefold = false;
	/**
	 * Lexical extraction cache: avoids re-extracting identifiers every refold.
	 * Key = `${blocks.length}:${protectedFromIndex}:${lastBlockId}`. Invalidated
	 * automatically because the key changes whenever the session changes.
	 */
	private lexCache = new Map<string, Set<string>>();
	/**
	 * Churn counter: incremented whenever any block's effective folded state changes
	 * inside refold(). Exposed readonly for tests and the replay driver.
	 */
	foldFlips = 0;

	/**
	 * LLM summary layer (C2). Map of block id → applied summary + its token cost.
	 * NOT deeply reactive — mutations bump summaryVersion ($state) which the token
	 * aggregates read, forcing a re-derive whenever a summary lands.
	 */
	private summaries = new Map<string, { summary: string; tokens: number }>();
	/**
	 * Bumped in setSummary so that all $derived.by() aggregates (liveTokens, etc.)
	 * that read this field re-run the moment a summary is stored.
	 */
	private summaryVersion = $state(0);

	constructor(parsed: ParsedSession) {
		this.meta = parsed.meta;
		this.blocks = parsed.blocks;
		this.reindex();
		this.refold();
	}

	private reindex(): void {
		this.index.clear();
		for (let i = 0; i < this.blocks.length; i++) this.index.set(this.blocks[i].id, i);
	}

	// ---- reads -------------------------------------------------------------
	isFolded(b: Block): boolean {
		// A member of a FOLDED group: collapsed → reads folded; straggler → reads live.
		const w = this.groupWire.get(b.id);
		if (w) return w.collapsed;
		if (b.override === "folded") return true;
		if (b.override === "pinned" || b.override === "unfolded") return false;
		return b.autoFolded;
	}
	/** Tokens this block currently costs the live context. */
	effTokens(b: Block): number {
		// Inside a folded group the contribution is the group's, not the block's own
		// (carrier holds the one summary's tokens; other collapsed members hold 0).
		const w = this.groupWire.get(b.id);
		if (w) return w.tokens;
		return this.isFolded(b) ? this.foldedCostOf(b) : b.tokens;
	}
	digestOf(b: Block): string {
		const s = this.summaries.get(b.id);
		if (s && FOLDABLE_KINDS.has(b.kind)) {
			return `${foldTag(b.id)} ${s.summary}`;
		}
		return digest(b);
	}

	// ---- summary layer (C2) ------------------------------------------------

	/** Cost of a block when folded: uses the LLM summary if available, else the deterministic digest. */
	private foldedCostOf(b: Block): number {
		const s = this.summaries.get(b.id);
		return s !== undefined ? s.tokens : digestTokens(b);
	}

	/** True if a summary has been applied to this block. */
	hasSummary(id: string): boolean {
		return this.summaries.has(id);
	}

	/**
	 * Apply an LLM summary to a block. Bumps version so all $derived sums
	 * (liveTokens / effTokens) recompute immediately.
	 *
	 * Guards:
	 *  - Unknown block id → ignored.
	 *  - Summary text >= block's own text length → not a compression win, keep digest.
	 */
	setSummary(id: string, summary: string): void {
		const b = this.get(id);
		if (!b) return;
		if (summary.length >= b.text.length) return; // no compression
		const tokens = estTokens(`${foldTag(id)} ${summary}`) + BLOCK_OVERHEAD;
		this.summaries.set(id, { summary, tokens });
		// Bump both reactive signals: summaryVersion forces $derived.by aggregates to
		// re-derive (they read summaryVersion), and version keeps the canvas/debug signal.
		this.summaryVersion++;
		this.version++;
	}

	// These aggregates are read many times per render (the header alone reads several
	// repeatedly). As `$derived` they walk the blocks once per real change and dedupe
	// across every reader, instead of re-summing ~1k blocks on each property access.
	//
	// summaryVersion is read here so the aggregate re-derives whenever an LLM summary
	// lands (summaries is a plain Map, not $state, so we need this explicit read).
	liveTokens = $derived.by(() => {
		void this.summaryVersion; // reactive dependency — re-derive when a summary lands
		let n = 0;
		for (const b of this.blocks) n += this.effTokens(b);
		return n;
	});
	/** What the context would cost with nothing folded. (Only changes when blocks change.) */
	fullTokens = $derived.by(() => {
		let n = 0;
		for (const b of this.blocks) n += b.tokens;
		return n;
	});
	savedTokens = $derived.by(() => this.fullTokens - this.liveTokens);
	foldedCount = $derived.by(() => {
		let n = 0;
		for (const b of this.blocks) if (this.isFolded(b)) n++;
		return n;
	});
	pinnedCount = $derived.by(() => {
		let n = 0;
		// A block pinned BEFORE it was grouped keeps its "pinned" override (members keep their
		// override, ADR §2), but a folded group collapses it on the wire — so it reads folded.
		// Don't count it as pinned, or the header contradicts what the user sees (a collapsed
		// tile reported as pinned).
		for (const b of this.blocks) if (b.override === "pinned" && !this.groupWire.get(b.id)?.collapsed) n++;
		return n;
	});
	overBudget = $derived.by(() => this.liveTokens > this.budget);

	/** The current turn number (highest block turn, or 0 for empty session). */
	currentTurn = $derived.by(() => {
		if (!this.blocks.length) return 0;
		return this.blocks[this.blocks.length - 1].turn;
	});

	/** Recall history for a given block id (for tests/replay). */
	recallsOf(id: string): readonly number[] {
		return this.recalls.get(id) ?? [];
	}

	// ---- groups (multiblock folds, ADR 0006) -------------------------------
	/** blockId → the group it belongs to (if any). Reactive on `groups`. */
	private groupAt = $derived.by(() => {
		const m = new Map<string, Group>();
		for (const g of this.groups) for (const id of g.memberIds) m.set(id, g);
		return m;
	});
	/**
	 * For every block inside a FOLDED group, its effective live contribution + folded
	 * state — so `effTokens`/`isFolded` mirror exactly what the wire does (ADR 0006 §5):
	 * the carrier holds the one summary's tokens, other collapsed members hold 0, and a
	 * straggler (split tool-pair half) stays live at full. Reactive on `groups`/`blocks`.
	 * Blocks NOT in a folded group are absent → callers fall back to per-block logic.
	 */
	private groupWire = $derived.by(() => {
		const m = new Map<string, { tokens: number; collapsed: boolean }>();
		for (const g of this.groups) {
			if (!g.folded) continue;
			const c = this.classifyGroup(g);
			const summaryTok = c.carrier ? groupDigestTokens(g, c.collapsedMembers) : 0;
			for (const b of c.members) {
				if (c.collapsed.has(b.id)) m.set(b.id, { tokens: b.id === c.carrier ? summaryTok : 0, collapsed: true });
				else m.set(b.id, { tokens: b.tokens, collapsed: false }); // straggler: live, full
			}
		}
		return m;
	});

	/**
	 * Split a group's members into what collapses (whole, tool-pair-balanced messages →
	 * the one summary) vs. what stays live (a tool-pair half whose partner sits outside the
	 * group — the owner's "leave straggler live" rule). Pure; no durability gate here (that
	 * is the WIRE's concern in `plan.ts` — the GUI shows the logical collapse so the demo /
	 * loaded sessions render real savings).
	 */
	private classifyGroup(g: Group): GroupShape {
		const members: Block[] = [];
		for (const id of g.memberIds) {
			const b = this.get(id);
			if (b) members.push(b);
		}
		// Pairing WITHIN the member set: a tool_call is balanced iff its result is also a
		// member; a tool_result iff its call is. A block whose partner is outside is a straggler.
		const memberCalls = new Set<string>();
		const memberResults = new Set<string>();
		for (const b of members) {
			if (!b.callId) continue;
			if (b.kind === "tool_call") memberCalls.add(b.callId);
			else if (b.kind === "tool_result") memberResults.add(b.callId);
		}
		const balanced = (b: Block): boolean => {
			if (b.kind === "tool_call") return !b.callId || memberResults.has(b.callId);
			if (b.kind === "tool_result") return !b.callId || memberCalls.has(b.callId);
			return true;
		};
		// Removal is per MESSAGE: a message collapses only if ALL its member blocks are
		// balanced (so a message holding an unbalanced tool_call stays whole/live).
		const byMsg = new Map<string, Block[]>();
		for (const b of members) {
			const k = messageKey(b.id);
			const arr = byMsg.get(k);
			if (arr) arr.push(b);
			else byMsg.set(k, [b]);
		}
		const removable = new Set<string>(); // message keys that collapse
		for (const [k, msgBlocks] of byMsg) if (msgBlocks.every(balanced)) removable.add(k);
		const collapsed = new Set<string>();
		const stragglers = new Set<string>();
		const collapsedMembers: Block[] = [];
		for (const b of members) {
			if (removable.has(messageKey(b.id))) {
				collapsed.add(b.id);
				collapsedMembers.push(b);
			} else stragglers.add(b.id);
		}
		return { members, collapsedMembers, collapsed, stragglers, carrier: collapsedMembers[0]?.id ?? null };
	}

	/**
	 * Index of the first protected block. Walking back from the newest block, protect
	 * whole blocks until the target `protectTokens` is reached, but refuse to pull in
	 * the next older block if doing so would exceed a strict 25% whole-block overflow
	 * cap. That keeps the slider honest: 20k means roughly 20k, not 40k just because a
	 * huge boundary block happened to cross the threshold.
	 *
	 * Protection remains absolute for what IS inside the tail, and we always protect at
	 * least the newest block. Therefore a single newest block may exceed the cap by
	 * itself — the cap only decides whether to add another older block.
	 */
	protectedFromIndex = $derived.by(() => {
		if (!this.blocks.length) return 0;
		const target = this.protectTokens;
		// Protection disabled: every block is foldable.
		if (target === 0) return this.blocks.length;
		const cap = target * PROTECT_OVERFLOW_CAP;
		// Always absorb the newest block unconditionally — it is indivisible and the
		// protected tail must never be empty while target > 0.
		let sum = this.blocks[this.blocks.length - 1].tokens;
		if (sum >= target) return this.blocks.length - 1;
		for (let i = this.blocks.length - 2; i >= 0; i--) {
			const next = sum + this.blocks[i].tokens;
			// Stop before adding an older block that would push the protected tail beyond
			// the overflow cap.
			if (next > cap) return i + 1;
			sum = next;
			if (sum >= target) return i;
		}
		return 0;
	});
	/**
	 * Is this block inside the protected working tail (never auto-folded)? Resolves the
	 * block by id, so `b` MUST be store-owned (from `blocks`/`get`) — a foreign object that
	 * merely shares an id resolves to the committed block's position. Every caller passes a
	 * store block today; an off-store/wire/ghost block is out of contract here.
	 */
	isProtected(b: Block): boolean {
		return (this.index.get(b.id) ?? -1) >= this.protectedFromIndex;
	}
	/** Full tokens currently held in the protected tail. */
	protectedTokens = $derived.by(() => {
		let n = 0;
		for (let i = this.protectedFromIndex; i < this.blocks.length; i++) n += this.blocks[i].tokens;
		return n;
	});

	// ---- conductor internal helpers -----------------------------------------

	/** Record that a block was recalled at `turn`. Deduplicates globally per (id, turn). */
	private recordRecall(id: string, turn?: number): void {
		const t = turn ?? this.currentTurn;
		const arr = this.recalls.get(id);
		if (!arr) {
			this.recalls.set(id, [t]);
		} else {
			// Global dedup: skip if ANY entry in the array is already this turn (not just the last),
			// so repeated refolds on the same turn never inflate the recall count.
			if (arr.includes(t)) return;
			arr.push(t);
		}
		this.version++;
	}

	/**
	 * Soft-fold a block by the conductor. Guards:
	 * - block missing
	 * - pinned (never touch pins)
	 * - override !== null (manual state — conductor respects human decisions)
	 * - protected (i >= protectedFromIndex)
	 * - in a folded group wire (already collapsed)
	 * - not a FOLDABLE kind (tool_call / user never folded)
	 * - digestTokens >= tokens (folding would not save tokens)
	 * - cooldown: coolUntil[id] > currentTurn
	 *
	 * Sets autoFolded=true, by="conductor". Does NOT call refold() (caller batches).
	 */
	conductorFold(id: string): void {
		const b = this.get(id);
		if (!b) return;
		if (b.override !== null) return; // respect manual state (covers pinned/unfolded/folded)
		const i = this.index.get(id) ?? -1;
		if (i < 0 || i >= this.protectedFromIndex) return; // protected
		if (this.groupWire.has(id)) return; // in folded group
		if (!FOLDABLE_KINDS.has(b.kind)) return; // not foldable kind
		if (this.foldedCostOf(b) >= b.tokens) return; // no savings
		const T = this.currentTurn;
		const cool = this.coolUntil.get(id) ?? 0;
		if (cool > T) return; // on cooldown
		b.autoFolded = true;
		b.by = "conductor";
		this.emit("conductor", "folded", label(b));
		this.version++;
	}

	/**
	 * Unfold a block by the conductor (relevance signal). Only acts if currently
	 * auto-folded (autoFolded && override===null). Sets a cooldown, records recall,
	 * emits log entry.
	 */
	conductorUnfold(id: string, reason: string): void {
		const b = this.get(id);
		if (!b) return;
		if (!b.autoFolded || b.override !== null) return; // only unfold auto-folded blocks
		b.autoFolded = false;
		b.by = "conductor";
		const T = this.currentTurn;
		this.coolUntil.set(id, T + HYSTERESIS.unfoldCooldownTurns);
		this.recordRecall(id, T);
		this.emit("conductor", "unfolded", `${label(b)} — ${reason}`);
		this.version++;
	}

	// ---- the automatic folder (conductor pipeline) --------------------------
	/**
	 * Dissolve any group that has come to reach into the protected tail (ADR 0006 watch
	 * item). Groups are created entirely older than the tail, but widening `protectTokens`
	 * can later grow the tail over an existing group. Protection is absolute, so rather than
	 * collapse protected content we drop the whole group — keeping the grid (older box uses
	 * the display list, protected box renders raw tiles) and the accounting consistent.
	 */
	private pruneProtectedGroups(): void {
		if (!this.groups.length) return;
		const pf = this.protectedFromIndex;
		const kept = this.groups.filter((g) => {
			const reaches = g.memberIds.some((id) => (this.index.get(id) ?? Infinity) >= pf);
			if (reaches) {
				this.emit("auto", "ungrouped (protected)", `${g.memberIds.length} blocks`);
				// HYSTERESIS (n1): when dissolving a conductor-built group, set group-level
				// cooldown on the first member so the coalesce step won't immediately re-form
				// the same group (mirrors the unfoldGroup/deleteGroup behaviour).
				if (g.by === "conductor" && g.memberIds.length > 0) {
					const firstId = g.memberIds[0];
					this.groupCool.set(firstId, this.currentTurn + COALESCE_CONFIG.cooldownTurns);
				}
			}
			return !reaches;
		});
		if (kept.length !== this.groups.length) this.groups = kept;
	}

	/**
	 * Recompute every auto-controlled block from scratch so the live context fits
	 * the budget. This is the full conductor pipeline:
	 *
	 * Step 0: pruneProtectedGroups
	 * Step 1: reset auto state; heal protected manual folds
	 * Step 2a: preliminary budget clamp to produce initial fold set
	 * Step 2b: LEXICAL PRE-UNFOLD — conductor-unfold auto-folded blocks referenced
	 *           in the protected tail (sets cooldown; runs on the preliminary fold set)
	 * Step 3: BUDGET CLAMP — re-run cold-score sorted greedy fold (respects cooldowns
	 *          set by the lexical pass)
	 * Step 4: RELAXED PASS — enforce budget even if cooldowns blocked some candidates
	 */
	refold(): void {
		// Re-entrancy guard: createGroup() calls refold() as part of group creation.
		// When the coalesce step at the bottom of this refold() calls createGroup(),
		// we don't want another full refold pass to run inside that createGroup().
		if (this._inRefold) return;
		this._inRefold = true;
		try {
			this._refoldImpl();
		} finally {
			this._inRefold = false;
		}
	}

	private _refoldImpl(): void {
		// Step 0: a group can never overlap the protected tail; drop any that now does.
		this.pruneProtectedGroups();
		const protectedFrom = this.protectedFromIndex;
		const T = this.currentTurn;

		// Step 1: reset auto-controlled blocks to full, AND heal any protected block that
		// is still folded by a manual override. Protection is ABSOLUTE.
		this.blocks.forEach((b, i) => {
			if (i >= protectedFrom && b.override === "folded") {
				this.emit(b.by ?? "auto", "unfolded (protected)", label(b));
				b.override = null;
				b.by = null;
			}
			if (b.override === null) {
				b.autoFolded = false;
				if (b.by === "auto" || b.by === "conductor") b.by = null;
			}
		});
		this.version++;

		// Snapshot isFolded state before any folding for churn accounting
		const foldedBefore = new Set<string>();
		for (const b of this.blocks) if (this.isFolded(b)) foldedBefore.add(b.id);

		// Shared context for scoring (used by both clamp passes)
		const tailCallIds = new Set<string>();
		for (let i = protectedFrom; i < this.blocks.length; i++) {
			const b = this.blocks[i];
			if (b.callId) tailCallIds.add(b.callId);
		}
		const ctx = { currentTurn: T, recalls: this.recalls as ReadonlyMap<string, readonly number[]>, tailCallIds };

		// Helper: compute all fold candidates (override===null, old, foldable, saves tokens)
		const allCandidates = (): Block[] =>
			this.blocks.filter(
				(b, i) =>
					b.override === null &&
					i < protectedFrom &&
					!this.groupWire.has(b.id) &&
					FOLDABLE_KINDS.has(b.kind) &&
					this.foldedCostOf(b) < b.tokens,
			);

		let live = this.liveTokens;
		if (live > this.budget) {
			// Step 2a: preliminary budget clamp (no cooldown check) to produce initial fold set
			// that the lexical pass can then inspect.
			const preliminary = sortCandidates(allCandidates(), ctx);
			for (const b of preliminary) {
				if (live <= this.budget) break;
				b.autoFolded = true;
				b.by = "auto";
				live += this.foldedCostOf(b) - b.tokens;
			}

			// Step 2b: LEXICAL PRE-UNFOLD — inspect auto-folded blocks for tail references.
			// Build (or reuse cached) tail text identifier set.
			if (this.blocks.length > 0) {
				const lastId = this.blocks[this.blocks.length - 1].id;
				const cacheKey = `${this.blocks.length}:${protectedFrom}:${lastId}`;
				let tailIds = this.lexCache.get(cacheKey);
				if (!tailIds) {
					// Concat protected tail text, walking back from end, stop after 32k chars
					let tailText = "";
					for (let i = this.blocks.length - 1; i >= protectedFrom && tailText.length < 32_000; i--) {
						tailText = this.blocks[i].text + "\n" + tailText;
					}
					tailIds = extractIdentifiers(tailText);
					this.lexCache.clear();
					this.lexCache.set(cacheKey, tailIds);
				}

				// Candidates: blocks that the preliminary clamp just auto-folded
				const lexCandidates = this.blocks.filter(
					(b, i) => b.autoFolded && b.override === null && i < protectedFrom && !this.groupWire.has(b.id),
				);

				if (tailIds.size > 0 && lexCandidates.length > 0) {
					const matches = matchBlocks(tailIds, lexCandidates);
					// Sort: longest identifier first (most specific signal)
					const matchedEntries = [...matches.entries()].sort((a, b) => b[1].length - a[1].length);

					let unfolded = 0;
					for (const [bid, identifier] of matchedEntries) {
						if (unfolded >= HYSTERESIS.maxLexicalUnfoldsPerPass) break;
						const b = this.get(bid);
						if (!b || !b.autoFolded || b.override !== null) continue;
						// Skip blocks on cooldown — they are already relevance-protected;
						// re-emitting a conductor-unfold would inflate logs and re-record recalls
						// every turn while the identifier persists in the tail.
						if ((this.coolUntil.get(bid) ?? 0) > T) continue;

						// Check if this block is inside a FOLDED group
						const grp = this.groupAt.get(bid);
						if (grp?.folded) {
							// Unfold the whole group, then conductor-unfold this specific member
							this.unfoldGroup(grp.id, "conductor");
							const bNow = this.get(bid);
							if (bNow && bNow.autoFolded && bNow.override === null) {
								this.conductorUnfold(bid, `matched "${identifier}"`);
							}
						} else {
							this.conductorUnfold(bid, `matched "${identifier}"`);
						}
						unfolded++;
					}
				}
			}

			// After lexical pass, reset the auto-folded state again (but NOT cooldowns/recalls)
			// so the final clamp can re-evaluate from scratch with the cooldowns in place.
			for (const b of this.blocks) {
				if (b.override === null && (b.by === "auto" || b.by === "conductor") && b.autoFolded) {
					b.autoFolded = false;
					b.by = null;
				}
			}
			live = this.liveTokens;
		}

		if (live <= this.budget) {
			// Compute churn
			const foldedAfter = new Set<string>();
			for (const b of this.blocks) if (this.isFolded(b)) foldedAfter.add(b.id);
			this.foldFlips += symmetricDiff(foldedBefore, foldedAfter);
			// Still run coalesce even when under budget: Step 1 reset autoFolded on all
			// auto-controlled blocks above, so this call is idempotent for any blocks that
			// were previously in conductor groups — it re-evaluates the coalesce runs after
			// the reset, but groups that survive the prune step above are unaffected.
			this._runCoalesce();
			return;
		}

		// Step 3: BUDGET CLAMP — cold-score sorted greedy fold, excluding cooled blocks
		const cand = allCandidates().filter((b) => (this.coolUntil.get(b.id) ?? 0) <= T);
		const sorted = sortCandidates(cand, ctx);

		for (const b of sorted) {
			if (live <= this.budget) break;
			b.autoFolded = true;
			b.by = "auto";
			live += this.foldedCostOf(b) - b.tokens;
		}

		// Step 4: RELAXED PASS — if still over budget after respecting cooldowns, fold
		// the remaining candidates INCLUDING cooled-down ones (budget is the hard guarantee;
		// hysteresis is best-effort).
		if (live > this.budget) {
			const candRelaxed = allCandidates().filter((b) => !b.autoFolded);
			const sortedRelaxed = sortCandidates(candRelaxed, ctx);
			for (const b of sortedRelaxed) {
				if (live <= this.budget) break;
				b.autoFolded = true;
				b.by = "auto";
				live += this.foldedCostOf(b) - b.tokens;
			}
		}

		// Compute churn (symmetric difference of folded sets)
		const foldedAfter = new Set<string>();
		for (const b of this.blocks) if (this.isFolded(b)) foldedAfter.add(b.id);
		this.foldFlips += symmetricDiff(foldedBefore, foldedAfter);

		// Step 5: AUTO-COALESCE — collapse runs of long-cold auto-folded blocks into
		// conductor-built flat groups (ADR 0009). Runs after the relaxed clamp so it only
		// operates on blocks the clamp has already folded (never folds anything new).
		// createGroup() calls refold() internally, but _inRefold blocks the inner call —
		// safe. createGroup() already emits "grouped" with the passed actor, so no double-log.
		this._runCoalesce();
	}

	/** Run the coalesce step (called at the bottom of _refoldImpl). Separated to keep _refoldImpl readable. */
	private _runCoalesce(): void {
		const T = this.currentTurn;
		const protectedFrom = this.protectedFromIndex;
		// Build a fast inGroup lookup from the current groupAt derived map.
		// groupAt is a $derived, but we can read it here (it recomputes on groups change).
		const inGroup = (id: string): boolean => !!this.groupAt.get(id);
		const isAutoFolded = (b: Block): boolean => b.override === null && b.autoFolded;
		const groupCoolActive = (firstId: string): boolean => (this.groupCool.get(firstId) ?? 0) > T;

		const runs = findCoalesceRuns({
			blocks: this.blocks,
			protectedFromIndex: protectedFrom,
			currentTurn: T,
			inGroup,
			isAutoFolded,
			groupCoolActive,
		});

		for (const run of runs) {
			// createGroup validates, snaps to whole messages, checks protection/overlap,
			// folds on creation, and emits "grouped" with the passed actor ("conductor").
			// The inner refold() call is a no-op due to _inRefold guard.
			const g = this.createGroup(run.startId, run.endId, "conductor");
			if (!g) continue;
			// Mark the group as conductor-built (createGroup sets folded=true already).
			g.by = "conductor";
			// NET-SAVINGS GUARD (defense in depth — the corpus eval caught budget
			// violations from this path): message snapping can pull in blocks whose
			// cost RISES inside a folded group (a folded tool_result split from its
			// call becomes a FULL-cost straggler). A conductor group must never
			// increase live cost; if it would, dissolve it immediately — deleteGroup
			// sets groupCool so the same range isn't retried every refold.
			const members = this.groupMembers(g);
			let ungroupedCost = 0;
			for (const b of members) {
				const foldedAlone = b.override === "folded" || (b.override === null && b.autoFolded);
				ungroupedCost += foldedAlone ? this.foldedCostOf(b) : b.tokens;
			}
			if (this.groupLiveTokens(g) > ungroupedCost) {
				this.deleteGroup(g.id, "auto");
			}
		}
	}

	setBudget(n: number): void {
		this.budget = Math.max(1000, Math.round(n));
		this.refold();
	}

	setContextWindow(n: number): void {
		this.contextWindow = n;
	}

	/**
	 * Live mode: ingest blocks streamed from the pi link, then re-fold. Blocks
	 * arrive in conversation order and are append-only (the live context grows;
	 * folding is the only mutation, and that is the store's own decision).
	 *
	 * Idempotent by durable id. The same block may arrive twice — streamed early
	 * when pi finishes it (the `message_end` view sync), then again in the next
	 * `context` full-array reconcile or a structural resync. The first arrival
	 * commits the block; a repeat id is dropped, so any user fold state already on
	 * that block is preserved (we never touch a block that is already present). The
	 * source of truth therefore never holds two blocks with the same id — including
	 * a duplicate id within a single batch.
	 */
	appendBlocks(blocks: Block[]): void {
		if (!blocks.length) return;
		const fresh: Block[] = [];
		for (const b of blocks) {
			if (this.index.has(b.id)) continue; // already committed (or dup within this batch)
			this.index.set(b.id, this.blocks.length + fresh.length);
			fresh.push(b);
		}
		if (!fresh.length) return;
		this.blocks.push(...fresh);
		this.refold();
	}

	/** Resize the protected working tail, then re-fold so the change takes effect. */
	setProtect(n: number): void {
		this.protectTokens = Math.max(0, Math.round(n));
		this.refold();
	}

	// ---- manual actions ----------------------------------------------------
	private emit(by: Actor, action: string, detail: string): void {
		this.log.unshift({ by, action, detail, n: this.logN++ });
		if (this.log.length > 80) this.log.pop();
	}

	/**
	 * A block inside a FOLDED group is controlled by its parent tile, not per-block
	 * overrides: the group's collapse already decides its fate (ADR 0006 §2). Refuse
	 * fold/unfold/pin/unpin here so a human pin is never silently swallowed by the
	 * group's wire state (the override would be recorded but `groupWire` would ignore
	 * it). Unfold the group first to act on a member. No-op while the group is OPEN.
	 */
	private inFoldedGroup(id: string): boolean {
		return this.groupAt.get(id)?.folded ?? false;
	}

	fold(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b || b.override === "pinned" || this.inFoldedGroup(id)) return;
		// Protected working tail is never folded — not even by an explicit user action.
		// (Pin it or widen the budget instead; protection is the safety pillar.)
		if (this.isProtected(b)) return;
		b.override = "folded";
		b.by = by;
		this.emit(by, "folded", label(b));
		this.refold();
	}
	unfold(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b || this.inFoldedGroup(id)) return;
		b.override = "unfolded";
		b.by = by;
		this.emit(by, "unfolded", label(b));
		// Record recall for agent and user unfolds
		if (by === "agent" || by === "you") {
			this.recordRecall(id);
		}
		this.refold();
	}
	toggle(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b) return;
		this.isFolded(b) ? this.unfold(id, by) : this.fold(id, by);
	}
	pin(id: string): void {
		const b = this.get(id);
		if (!b || this.inFoldedGroup(id)) return;
		b.override = "pinned";
		b.by = "you";
		this.emit("you", "pinned", label(b));
		this.refold();
	}
	unpin(id: string): void {
		const b = this.get(id);
		if (!b || b.override !== "pinned") return;
		b.override = null;
		b.by = "you";
		this.emit("you", "unpinned", label(b));
		this.refold();
	}
	/** Hand a block back to the automatic folder. */
	auto(id: string): void {
		const b = this.get(id);
		if (!b || this.inFoldedGroup(id)) return; // group controls collapsed members (like fold/pin)
		b.override = null;
		b.by = null;
		this.refold();
	}
	/** Clear every manual override — pure budget view. */
	resetAll(): void {
		for (const b of this.blocks) {
			b.override = null;
			b.by = null;
		}
		this.emit("you", "reset", "all blocks to auto");
		this.refold();
	}

	// ---- group actions (multiblock folds, ADR 0006) -----------------------
	/** The group a block belongs to, if any. */
	groupOf(b: Block): Group | undefined {
		return this.groupAt.get(b.id);
	}
	groupById(id: string): Group | undefined {
		return this.groups.find((g) => g.id === id);
	}
	groupMembers(g: Group): Block[] {
		const out: Block[] = [];
		for (const id of g.memberIds) {
			const b = this.get(id);
			if (b) out.push(b);
		}
		return out;
	}
	/** The one summary string the group's folded tile renders / the agent receives. */
	groupSummary(g: Group): string {
		const c = this.classifyGroup(g);
		return groupDigest(g, c.collapsedMembers.length ? c.collapsedMembers : c.members);
	}
	/** Full tokens of the whole range, ignoring fold state. */
	groupFullTokens(g: Group): number {
		let n = 0;
		for (const b of this.groupMembers(g)) n += b.tokens;
		return n;
	}
	/** What the group costs live: folded → one summary (+ any straggler full); open → members' own eff. */
	groupLiveTokens(g: Group): number {
		if (!g.folded) {
			let n = 0;
			for (const b of this.groupMembers(g)) n += this.effTokens(b);
			return n;
		}
		const c = this.classifyGroup(g);
		let n = c.carrier ? groupDigestTokens(g, c.collapsedMembers) : 0;
		for (const id of c.stragglers) n += this.get(id)?.tokens ?? 0;
		return n;
	}
	groupSavedTokens(g: Group): number {
		return this.groupFullTokens(g) - this.groupLiveTokens(g);
	}
	/** How many members stay LIVE on the wire (split tool-pair halves) — surfaced in the tooltip. */
	groupStragglerCount(g: Group): number {
		return g.folded ? this.classifyGroup(g).stragglers.size : 0;
	}

	/**
	 * Create a group from a block range (the human's selection, any two member ids). The
	 * range is SNAPPED outward to whole messages (never splits an assistant message's parts),
	 * then validated: entirely older than the protected tail, no member already grouped
	 * (no overlap), ≥2 members. Folds it on creation. Returns the group, or null if invalid.
	 */
	createGroup(startId: string, endId: string, by: Actor = "you"): Group | null {
		const i0 = this.index.get(startId);
		const i1 = this.index.get(endId);
		if (i0 === undefined || i1 === undefined) return null;
		let lo = Math.min(i0, i1);
		let hi = Math.max(i0, i1);
		// Snap to whole messages so a group never collapses a message's parts in half.
		const keyLo = messageKey(this.blocks[lo].id);
		while (lo > 0 && messageKey(this.blocks[lo - 1].id) === keyLo) lo--;
		const keyHi = messageKey(this.blocks[hi].id);
		while (hi < this.blocks.length - 1 && messageKey(this.blocks[hi + 1].id) === keyHi) hi++;
		// Never reach into the protected tail (ADR 0006 §1).
		if (hi >= this.protectedFromIndex) return null;
		const memberIds: string[] = [];
		for (let i = lo; i <= hi; i++) {
			const b = this.blocks[i];
			if (this.groupAt.get(b.id)) return null; // overlap with an existing group
			memberIds.push(b.id);
		}
		if (memberIds.length < 2) return null;
		const g: Group = { id: `g:${memberIds[0]}`, memberIds, folded: true };
		// A group must actually collapse something. If EVERY member is a split tool-pair half
		// (its partner sits outside the range), nothing folds into the summary — the tile would
		// hide live blocks for zero benefit. That isn't a fold; refuse it (ADR 0006 §4: a folded
		// group replaces its blocks WITH the parent summary).
		if (this.classifyGroup(g).carrier === null) return null;
		this.groups = [...this.groups, g];
		this.emit(by, "grouped", `${memberIds.length} blocks`);
		this.refold();
		return g;
	}
	/** Delete a group (members return to normal). The UI's "edit membership" is delete + recreate. */
	deleteGroup(id: string, by: Actor = "you"): void {
		const g = this.groupById(id);
		if (!g) return;
		// HYSTERESIS (ADR 0009 §5): if this is a conductor-built group, set group-level cooldown
		// so the coalesce step won't immediately re-form the same group.
		// This covers: human delete, lexical restore (opens groups via unfoldGroup),
		// and agent unfolds (resolveUnfold → unfoldGroup) — all go through here.
		if (g.by === "conductor" && g.memberIds.length > 0) {
			const firstId = g.memberIds[0];
			this.groupCool.set(firstId, this.currentTurn + COALESCE_CONFIG.cooldownTurns);
		}
		this.groups = this.groups.filter((x) => x.id !== id);
		this.emit(by, "ungrouped", `${g.memberIds.length} blocks`);
		this.refold();
	}
	foldGroup(id: string, by: Actor = "you"): void {
		const g = this.groupById(id);
		if (!g || g.folded) return;
		g.folded = true;
		this.groups = [...this.groups];
		this.emit(by, "group folded", `${g.memberIds.length} blocks`);
		this.refold();
	}
	unfoldGroup(id: string, by: Actor = "you"): void {
		const g = this.groupById(id);
		if (!g || !g.folded) return;
		// HYSTERESIS (ADR 0009 §5): if this is a conductor-built group, set group-level cooldown
		// on the first member so the coalesce step won't immediately re-form the group.
		// Applies to ALL unfolds of conductor groups regardless of caller (agent, lexical, human).
		if (g.by === "conductor" && g.memberIds.length > 0) {
			const firstId = g.memberIds[0];
			this.groupCool.set(firstId, this.currentTurn + COALESCE_CONFIG.cooldownTurns);
		}
		g.folded = false;
		this.groups = [...this.groups];
		this.emit(by, "group unfolded", `${g.memberIds.length} blocks`);
		// Record recalls for agent/conductor group unfolds
		if (by === "agent" || by === "conductor") {
			for (const mid of g.memberIds) {
				this.recordRecall(mid);
			}
		}
		this.refold();
	}
	toggleGroup(id: string, by: Actor = "you"): void {
		const g = this.groupById(id);
		if (!g) return;
		g.folded ? this.unfoldGroup(id, by) : this.foldGroup(id, by);
	}

	/** Group hysteresis cooldown for a first-member id (turn until which re-coalesce is blocked). For tests/replay. */
	groupCoolUntil(firstId: string): number {
		return this.groupCool.get(firstId) ?? 0;
	}

	get(id: string): Block | undefined {
		const i = this.index.get(id);
		return i === undefined ? undefined : this.blocks[i];
	}
}

function label(b: Block): string {
	const where = b.turn > 0 ? `turn ${b.turn}` : "preamble";
	return b.toolName ? `${b.kind} ${b.toolName} · ${where}` : `${b.kind} · ${where}`;
}

/** Count of elements in the symmetric difference of two sets. */
function symmetricDiff(a: Set<string>, b: Set<string>): number {
	let n = 0;
	for (const x of a) if (!b.has(x)) n++;
	for (const x of b) if (!a.has(x)) n++;
	return n;
}
