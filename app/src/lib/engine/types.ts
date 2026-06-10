/*
 * types.ts — the shared vocabulary of the engine.
 *
 * The atomic unit is a BLOCK: a typed slice of a single message. One assistant
 * message explodes into several blocks (its thinking, its reply text, each tool
 * call). A tool call and the tool result that answers it are SEPARATE blocks —
 * they are shown together but fold independently, because their value to the
 * agent decays at very different rates. See VISION.md.
 */

export type BlockKind =
	| "user" // the human's instruction/intent — highest durable value
	| "text" // an assistant reply / conclusion
	| "thinking" // ephemeral assistant reasoning
	| "tool_call" // WHAT the agent did (tiny, durable record of an action)
	| "tool_result"; // WHAT the agent saw (often huge, decays fast)

/** Who last changed a block's fold state. */
export type Actor = "you" | "agent" | "auto" | "conductor";

/**
 * A manual override that the automatic folder must respect:
 *  - "pinned"   — locked full; never auto-folds (a protection on top of Full).
 *  - "folded"   — force-folded by hand; stays folded regardless of budget.
 *  - "unfolded" — held open by hand; protected from auto-fold but not a hard pin.
 *  - null       — handed to the automatic folder.
 */
export type Override = "pinned" | "folded" | "unfolded" | null;

export interface Block {
	/** Stable, unique id derived from the source message id + position. */
	id: string;
	kind: BlockKind;
	/** 1-based index of the user turn this block belongs to (0 = preamble). */
	turn: number;
	/** Global 0-based position in the conversation. */
	order: number;
	/** Full, normalized text content. Never mutated by folding. */
	text: string;
	/** Estimated token cost at full fidelity. */
	tokens: number;
	/** Tool name, for tool_call / tool_result blocks. */
	toolName?: string;
	/**
	 * Pairing key. For a tool_call it is the call's own id; for a tool_result it
	 * is the id of the call it answers. This is the provider-safety invariant: a
	 * folded result keeps this id, and a call may never be dropped while a result
	 * still references it.
	 */
	callId?: string;
	/** Model that produced an assistant block, if known. */
	model?: string;
	isError?: boolean;

	// --- mutable, reactive state -------------------------------------------
	override: Override;
	/** Set by the automatic folder; only meaningful when override is null. */
	autoFolded: boolean;
	/** Who last touched this block's fold state. */
	by: Actor | null;
}

/**
 * A multiblock fold (ADR 0006, extended for C4 nesting ADR 0011). A group is an ENGINE
 * OVERLAY, never a `Block`: it references a CONTIGUOUS, non-overlapping run of member
 * blocks (by id) that the human or conductor collapses into a single tile. `folded` is
 * the group's own state, orthogonal to each member's per-block override.
 *
 * `memberIds` is ALWAYS LEAF BLOCK IDS (never group ids), even for a parent group — a
 * parent's `memberIds` is the union of all its descendants' leaf block ids. This keeps
 * every existing consumer (computeGroupOps, applyPlan, classifyGroup, groupAt) unchanged.
 *
 * `children` (optional) carries the immediate child GROUP ids when this is a parent group.
 * The absence of `children` (or an empty array) means this is a leaf group (ADR 0006
 * flat group — a flat manual group or a conductor episode). A parent group is created
 * only by the internal `createParentGroup` path; `createGroup` (manual) always produces
 * leaf groups.
 *
 * The id is `g:<firstMemberDurableId>` for leaf groups; `era:<firstMemberDurableId>` for
 * parent groups created by the conductor's upward-coalescing schedule. Its agent-unfold
 * handle is `foldCode(id)`. Invariants (enforced at creation): contiguous · non-overlapping
 * · flat members (leaf block ids, never group ids) · ≥2 members · entirely older than the
 * protected tail. `memberIds` is in conversation (block) order.
 *
 * `by` records who created the group: "conductor" for auto-coalesced groups (ADR 0009),
 * "you" (or absent) for human-created groups. Used for hysteresis: dissolving a conductor
 * group sets a group-level cooldown that prevents immediate re-coalescing.
 */
export interface Group {
	id: string;
	/** Leaf BLOCK ids — always blocks, never group ids, even for parent groups (ADR 0011). */
	memberIds: string[];
	folded: boolean;
	/** Who created this group. Absent = "you" (legacy / human-created). */
	by?: Actor;
	/**
	 * Child GROUP ids (C4 nesting, ADR 0011). Absent/empty for leaf groups (the ADR 0006
	 * manual flat group and conductor episodes). Present for parent groups created by the
	 * conductor's upward-coalescing schedule (`createParentGroup`). When a parent is
	 * unfolded (level-by-level semantics), its children remain folded — one unfold reveals
	 * child summaries, not full text.
	 */
	children?: string[];
}

export interface SessionMeta {
	format: "pi" | "claude" | "unknown";
	title: string;
	cwd: string;
	model: string;
}

export interface ParsedSession {
	meta: SessionMeta;
	blocks: Block[];
	/** Diagnostics. */
	lineCount: number;
	skipped: number;
}
