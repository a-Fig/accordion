/*
 * store.svelte.ts — the accordion model.
 *
 * Owns every block's fold state and runs the automatic folder. This is the
 * single source of truth; the UI only renders it and calls its actions. Folding
 * is content substitution, never removal: a folded block still exists and still
 * carries its callId, so a tool_call/result pair is never structurally broken.
 *
 * The v0 folder is deliberately dumb: no Conductor, no relevance. It folds purely
 * to keep the live context under budget, oldest-first, lowest-value-first —
 * tool_results before thinking before reply text before tool_calls before user
 * intent. Deterministic and explainable; the smarts come later.
 */
import type { Block, BlockKind, Actor, SessionMeta, ParsedSession, TurnGroup } from "./types";
import { digest, digestTokens } from "./digest";

/** Lower value → folded sooner. The whole asymmetry the tool is built around. */
const FOLD_RANK: Record<BlockKind, number> = {
	tool_result: 0, // huge, decays fastest → fold first, hardest
	thinking: 1, // ephemeral reasoning
	text: 2, // conclusions, medium durable value
	tool_call: 3, // tiny + durable record of an action → fold last
	user: 4, // the instruction/intent → fold last of all
};

export interface LogEntry {
	by: Actor;
	action: string;
	detail: string;
	n: number;
}

export class AccordionStore {
	meta: SessionMeta;
	blocks = $state<Block[]>([]);
	/** Token budget for the live context window. */
	budget = $state(70_000);
	/**
	 * The protected working tail: the most recent blocks whose combined full size
	 * reaches this many tokens are NEVER auto-folded. The automatic folder and the
	 * future Conductor only ever operate on context older than this window — the
	 * recent ~N tokens stay verbatim. (Manual fold by the user is still allowed.)
	 */
	protectTokens = $state(20_000);
	log = $state<LogEntry[]>([]);
	private logN = 0;
	/** Bumped on every settled change — a cheap redraw signal for canvas views. */
	version = $state(0);
	/** Block ids that arrived in the last ~1.5s — used to flash new tiles/cards. */
	recentlyAddedIds = $state<Set<string>>(new Set());
	/** Whether the live SSE stream is currently connected (set by the route). */
	liveConnected = $state(false);
	/** Live self-calibrated fold target from the Conductor (read-only in UI). */
	foldTargetCalibrated = $state(0.8);
	/** True when fold target was sourced from a transcript conductor snapshot. */
	conductorFromSession = $state(false);
	/** Replay: only blocks with turn <= this value are visible (Infinity = all). */
	revealUpToTurn = $state(Infinity);
	replayPlaying = $state(false);
	groups = $state<Map<string, TurnGroup>>(new Map());
	groupIdByTurn = $state<Map<number, string>>(new Map());
	private nextGroupId = 1;
	private replayTimer: ReturnType<typeof setInterval> | null = null;
	private recentClearTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(parsed: ParsedSession) {
		this.meta = parsed.meta;
		this.blocks = parsed.blocks;
		this.applyConductorSnapshot(parsed, true);
		this.refold();
	}

	/** Apply the latest conductor snapshot from a parsed session. */
	applyConductorSnapshot(parsed: ParsedSession, seedBudget = false): void {
		if (!parsed.conductor) return;
		this.foldTargetCalibrated = parsed.conductor.foldTargetCalibrated;
		this.conductorFromSession = true;
		if (seedBudget) {
			this.budget = parsed.conductor.config.budgetTokens;
			this.protectTokens = parsed.conductor.config.workingTailTokens;
		}
	}

	// ---- reads -------------------------------------------------------------
	isFolded(b: Block): boolean {
		if (b.override === "folded") return true;
		if (b.override === "pinned" || b.override === "unfolded") return false;
		return b.autoFolded;
	}
	/** Tokens this block currently costs the live context. */
	effTokens(b: Block): number {
		return this.isFolded(b) ? digestTokens(b) : b.tokens;
	}
	digestOf(b: Block): string {
		return digest(b);
	}

	/** Blocks visible in the current view (respects replay reveal pointer). */
	get viewBlocks(): Block[] {
		if (this.revealUpToTurn === Infinity) return this.blocks;
		return this.blocks.filter((b) => b.turn <= this.revealUpToTurn);
	}
	get inReplay(): boolean {
		return this.revealUpToTurn < Infinity;
	}
	get maxTurn(): number {
		let m = 0;
		for (const b of this.blocks) if (b.turn > m) m = b.turn;
		return m;
	}
	get turnCount(): number {
		return new Set(this.blocks.map((b) => b.turn)).size;
	}

	get liveTokens(): number {
		let n = 0;
		for (const b of this.viewBlocks) n += this.effTokens(b);
		return n;
	}
	/** What the context would cost with nothing folded. */
	get fullTokens(): number {
		let n = 0;
		for (const b of this.viewBlocks) n += b.tokens;
		return n;
	}
	get savedTokens(): number {
		return this.fullTokens - this.liveTokens;
	}
	get foldedCount(): number {
		return this.viewBlocks.filter((b) => this.isFolded(b)).length;
	}
	get pinnedCount(): number {
		return this.blocks.filter((b) => b.override === "pinned").length;
	}
	get overBudget(): boolean {
		return this.liveTokens > this.budget;
	}

	/**
	 * Index of the first protected block. Walking back from the newest block, the
	 * most recent blocks whose combined full size reaches `protectTokens` are
	 * protected; blocks at this index and later are never auto-folded. Always
	 * protects at least the newest block. Returns 0 if the whole session is
	 * smaller than the protected window (then nothing is fold-eligible).
	 */
	get protectedFromIndex(): number {
		return this.protectedFromIn(this.blocks);
	}
	/** Protected tail index within `viewBlocks` (for replay-aware map). */
	get viewProtectedFromIndex(): number {
		return this.protectedFromIn(this.viewBlocks);
	}
	private protectedFromIn(blocks: Block[]): number {
		let sum = 0;
		for (let i = blocks.length - 1; i >= 0; i--) {
			sum += blocks[i].tokens;
			if (sum >= this.protectTokens) return i;
		}
		return 0;
	}
	/** Is this block inside the protected working tail (never auto-folded)? */
	isProtected(b: Block): boolean {
		return this.blocks.indexOf(b) >= this.protectedFromIndex;
	}
	/** Full tokens currently held in the protected tail. */
	get protectedTokens(): number {
		let n = 0;
		for (let i = this.protectedFromIndex; i < this.blocks.length; i++) n += this.blocks[i].tokens;
		return n;
	}

	// ---- the automatic folder ---------------------------------------------
	/**
	 * Recompute every auto-controlled block from scratch so the live context fits
	 * the budget. Idempotent: same blocks + budget + overrides → same result.
	 */
	refold(): void {
		// 1) hand all auto-controlled blocks back to full.
		for (const b of this.blocks) {
			if (b.override === null) {
				b.autoFolded = false;
				if (b.by === "auto") b.by = null;
			}
		}
		this.version++;
		let live = this.liveTokens;
		if (live <= this.budget) return;

		// 2) fold lowest-value, oldest candidates until the live context fits.
		// Protect the recent working tail (the newest ~protectTokens of context),
		// and never fold a block whose digest wouldn't actually save tokens — folding
		// it would only grow the live context and churn the view.
		const protectedFrom = this.protectedFromIndex;
		const protectedIds = new Set(this.blocks.slice(protectedFrom).map((b) => b.id));
		const cand = this.foldUnits()
			.filter(
				(unit) =>
					unit.every((b) => b.override === null && !protectedIds.has(b.id)) &&
					unit.reduce((sum, b) => sum + digestTokens(b), 0) < unit.reduce((sum, b) => sum + b.tokens, 0),
			)
			.sort((a, b) => unitRank(a) - unitRank(b) || a[0].order - b[0].order);

		for (const unit of cand) {
			if (live <= this.budget) break;
			for (const b of unit) {
				b.autoFolded = true;
				b.by = "auto";
			}
			live += unit.reduce((sum, b) => sum + digestTokens(b) - b.tokens, 0);
		}
	}

	setBudget(n: number): void {
		this.budget = Math.max(1000, Math.round(n));
		this.refold();
	}

	/** Resize the protected working tail, then re-fold so the change takes effect. */
	setProtect(n: number): void {
		this.protectTokens = Math.max(0, Math.round(n));
		this.refold();
	}

	// ---- pair-aware block units --------------------------------------------
	private pairFor(b: Block): Block[] {
		if (!b.callId || (b.kind !== "tool_call" && b.kind !== "tool_result")) return [b];
		const pair = this.blocks.filter((x) => x.callId === b.callId && (x.kind === "tool_call" || x.kind === "tool_result"));
		const calls = pair.filter((x) => x.kind === "tool_call");
		const results = pair.filter((x) => x.kind === "tool_result");
		return pair.length === 2 && calls.length === 1 && results.length === 1 ? pair.sort((a, z) => a.order - z.order) : [b];
	}

	private foldUnits(): Block[][] {
		const used = new Set<string>();
		const units: Block[][] = [];
		for (const b of this.blocks) {
			if (used.has(b.id)) continue;
			const unit = this.pairFor(b);
			for (const member of unit) used.add(member.id);
			units.push(unit);
		}
		return units;
	}

	// ---- manual actions ----------------------------------------------------
	private emit(by: Actor, action: string, detail: string): void {
		this.log.unshift({ by, action, detail, n: this.logN++ });
		if (this.log.length > 80) this.log.pop();
	}

	fold(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b) return;
		const unit = this.pairFor(b);
		if (unit.some((member) => member.override === "pinned")) return;
		for (const member of unit) {
			member.override = "folded";
			member.by = by;
		}
		this.emit(by, "folded", label(b));
		this.refold();
	}
	unfold(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b) return;
		for (const member of this.pairFor(b)) {
			member.override = "unfolded";
			member.by = by;
		}
		this.emit(by, "unfolded", label(b));
		this.refold();
	}
	toggle(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b) return;
		this.isFolded(b) ? this.unfold(id, by) : this.fold(id, by);
	}
	pin(id: string): void {
		const b = this.get(id);
		if (!b) return;
		for (const member of this.pairFor(b)) {
			member.override = "pinned";
			member.by = "you";
		}
		this.emit("you", "pinned", label(b));
		this.refold();
	}
	unpin(id: string): void {
		const b = this.get(id);
		if (!b || b.override !== "pinned") return;
		for (const member of this.pairFor(b)) {
			if (member.override !== "pinned") continue;
			member.override = null;
			member.by = "you";
		}
		this.emit("you", "unpinned", label(b));
		this.refold();
	}
	/** Hand a block back to the automatic folder. */
	auto(id: string): void {
		const b = this.get(id);
		if (!b) return;
		for (const member of this.pairFor(b)) {
			member.override = null;
			member.by = null;
		}
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

	// ---- replay ------------------------------------------------------------
	resetReplay(): void {
		this.pauseReplay();
		this.revealUpToTurn = Infinity;
		this.ungroupAll();
		this.refold();
	}

	stepReplay(): void {
		if (this.revealUpToTurn === Infinity) this.revealUpToTurn = 0;
		else this.revealUpToTurn = Math.min(this.maxTurn, this.revealUpToTurn + 1);
		this.refold();
		this.version++;
	}

	startReplay(intervalMs = 800): void {
		this.pauseReplay();
		this.ungroupAll();
		this.revealUpToTurn = 0;
		this.refold();
		this.replayPlaying = true;
		this.emit("you", "replay", "started");
		this.replayTimer = setInterval(() => {
			if (this.revealUpToTurn >= this.maxTurn) {
				this.pauseReplay();
				return;
			}
			this.stepReplay();
		}, intervalMs);
	}

	pauseReplay(): void {
		if (this.replayTimer) clearInterval(this.replayTimer);
		this.replayTimer = null;
		this.replayPlaying = false;
	}

	// ---- turn groups -------------------------------------------------------
	turnBlocks(turn: number): Block[] {
		return this.blocks.filter((b) => b.turn === turn);
	}

	groupOfTurn(turn: number): TurnGroup | null {
		const gid = this.groupIdByTurn.get(turn);
		return gid ? (this.groups.get(gid) ?? null) : null;
	}

	isTurnFullyFolded(turn: number): boolean {
		const blocks = this.turnBlocks(turn);
		if (!blocks.length) return false;
		return blocks.every((b) => this.isFolded(b) && b.override !== "pinned");
	}

	leadingFoldedTurnCount(): number {
		const turns = [...new Set(this.viewBlocks.map((b) => b.turn))].sort((a, b) => a - b);
		let n = 0;
		for (const turn of turns) {
			if (this.isTurnFullyFolded(turn) && !this.groupIdByTurn.has(turn)) n++;
			else break;
		}
		return n;
	}

	groupColdHistory(by: Actor = "you"): TurnGroup | null {
		const turns = [...new Set(this.viewBlocks.map((b) => b.turn))].sort((a, b) => a - b);
		const run: number[] = [];
		for (const turn of turns) {
			if (this.isTurnFullyFolded(turn) && !this.groupIdByTurn.has(turn)) run.push(turn);
			else if (run.length) break;
		}
		if (run.length < 2) return null;
		const id = `g${this.nextGroupId++}`;
		const g: TurnGroup = { id, turns: run, collapsed: true, by };
		const nextGroups = new Map(this.groups);
		const nextByTurn = new Map(this.groupIdByTurn);
		nextGroups.set(id, g);
		for (const turn of run) nextByTurn.set(turn, id);
		this.groups = nextGroups;
		this.groupIdByTurn = nextByTurn;
		this.emit(by, "grouped", `${run.length} folded turns`);
		this.version++;
		return g;
	}

	toggleGroup(id: string): void {
		const g = this.groups.get(id);
		if (!g) return;
		const next = new Map(this.groups);
		next.set(id, { ...g, collapsed: !g.collapsed });
		this.groups = next;
		this.emit("you", next.get(id)!.collapsed ? "folded group" : "unfolded group", `${g.turns.length} turns`);
		this.version++;
	}

	ungroup(id: string): void {
		const g = this.groups.get(id);
		if (!g) return;
		const nextGroups = new Map(this.groups);
		const nextByTurn = new Map(this.groupIdByTurn);
		nextGroups.delete(id);
		for (const turn of g.turns) nextByTurn.delete(turn);
		this.groups = nextGroups;
		this.groupIdByTurn = nextByTurn;
		this.version++;
	}

	ungroupAll(): void {
		if (this.groups.size === 0) return;
		this.groups = new Map();
		this.groupIdByTurn = new Map();
		this.version++;
	}

	groupDigestLines(g: TurnGroup): string[] {
		return g.turns.map((turn) => {
			const blocks = this.turnBlocks(turn);
			const parts = blocks.map((b) => this.digestOf(b));
			return `T${turn}: ${parts.join(" · ")}`;
		});
	}

	get(id: string): Block | undefined {
		return this.blocks.find((b) => b.id === id);
	}

	/**
	 * Merge a freshly-parsed block list into the existing one in place.
	 * - Existing blocks (by id) keep their user overrides (`override`, `by`) but
	 *   adopt the latest `text` and `tokens` (tool_result blocks often grow as
	 *   tools stream output).
	 * - New ids are appended in their incoming order and flagged in
	 *   `recentlyAddedIds` for ~1.5s so the UI can flash them.
	 * Re-runs the auto-folder once at the end.
	 */
	mergeFrom(parsed: ParsedSession): void {
		const existing = new Map<string, Block>();
		for (const b of this.blocks) existing.set(b.id, b);
		const newIds: string[] = [];
		const merged: Block[] = [];
		for (const incoming of parsed.blocks) {
			const prev = existing.get(incoming.id);
			if (prev) {
				prev.text = incoming.text;
				prev.tokens = incoming.tokens;
				prev.turn = incoming.turn;
				prev.order = incoming.order;
				if (incoming.toolName !== undefined) prev.toolName = incoming.toolName;
				if (incoming.callId !== undefined) prev.callId = incoming.callId;
				if (incoming.model !== undefined) prev.model = incoming.model;
				if (incoming.isError !== undefined) prev.isError = incoming.isError;
				merged.push(prev);
			} else {
				merged.push(incoming);
				newIds.push(incoming.id);
			}
		}
		this.blocks = merged;
		this.meta = parsed.meta;
		this.applyConductorSnapshot(parsed, false);
		if (newIds.length) this.markRecent(newIds);
		this.refold();
	}

	private markRecent(ids: string[]): void {
		const next = new Set(this.recentlyAddedIds);
		for (const id of ids) next.add(id);
		this.recentlyAddedIds = next;
		if (this.recentClearTimer) clearTimeout(this.recentClearTimer);
		this.recentClearTimer = setTimeout(() => {
			this.recentlyAddedIds = new Set();
			this.recentClearTimer = null;
		}, 1500);
	}
}

function unitRank(unit: Block[]): number {
	return Math.min(...unit.map((b) => FOLD_RANK[b.kind]));
}

function label(b: Block): string {
	const where = b.turn > 0 ? `turn ${b.turn}` : "preamble";
	return b.toolName ? `${b.kind} ${b.toolName} · ${where}` : `${b.kind} · ${where}`;
}
