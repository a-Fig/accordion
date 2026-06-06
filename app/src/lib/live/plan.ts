/*
 * plan.ts — turn the engine's LOCAL fold decisions into provider-safe wire ops.
 *
 * The engine (AccordionStore) already decides, per block, whether it is folded —
 * that is the brain. This module is the thin, PURE translation layer that mirrors
 * those decisions into the `FoldOp`s the GUI sends back to the pi extension over
 * the live link ("GUI drives, extension is thin"). No Svelte runes, no `$state`,
 * no side effects: given a store, it just reads and returns a plan.
 *
 * It emits one op per block that the store currently folds, BUT only after two
 * defense-in-depth filters on top of the extension's own `applyPlan` kind checks:
 *   • KIND filter — only `text | thinking | tool_result` are ever folded.
 *     A `tool_call` is never folded (altering/removing it orphans its result →
 *     provider 400); a `user` block (the human's intent) is never folded.
 *   • DURABLE-ID guard — only blocks with a durable, content-anchored id
 *     (`isDurableId`) are folded. A positional fallback id is not stable once the
 *     message array shifts (folding makes it non-append-only), so we must never
 *     instruct a fold we can't durably re-identify.
 * It also skips any op whose digest is empty, so a fold never empties a content
 * part. These checks duplicate the extension's safety net on purpose: both sides
 * enforce the invariant so neither alone is a single point of failure.
 *
 * Ops follow block order, matching the conversation's linear order.
 */
import type { AccordionStore } from "../engine/store.svelte";
import type { Block } from "../engine/types";
import type { FoldOp, UnfoldRestored } from "./protocol";
import { isDurableId } from "./mapping";

/** Kinds that are safe to fold. Never `user` (intent) or `tool_call` (orphans result). */
const FOLDABLE_KINDS = new Set(["text", "thinking", "tool_result"]);

/**
 * Compute the fold plan for the current store state: one `FoldOp` per block that
 * the engine folds AND that passes the kind / durable-id / non-empty-digest
 * guards. Pure read; the store is never mutated. Ops preserve block order.
 */
export function computeFoldOps(store: AccordionStore): FoldOp[] {
	const ops: FoldOp[] = [];
	for (const b of store.blocks) {
		if (!store.isFolded(b)) continue;
		if (!FOLDABLE_KINDS.has(b.kind)) continue; // never user / tool_call
		if (!isDurableId(b.id)) continue; // durable-id safety guard
		const digestText = store.digestOf(b);
		if (!digestText) continue; // never empty a content part
		ops.push({ id: b.id, digestText });
	}
	return ops;
}

/** Short, human-readable label for an unfold confirmation (e.g. "tool_result read_file · turn 12"). */
export function blockLabel(b: Block): string {
	const where = b.turn > 0 ? `turn ${b.turn}` : "preamble";
	return b.toolName ? `${b.kind} ${b.toolName} · ${where}` : `${b.kind} · ${where}`;
}

/**
 * Resolve an agent `unfold` request against the live store (protocol v3). For each id
 * the agent sent (read from a `{#<id> FOLDED}` tag), restore the block to full content
 * and record it; collect ids that don't resolve as `missing`.
 *
 * Restoring uses `store.unfold(id, "agent")` — a sticky override (protected from
 * auto-refold) with provenance "agent" so the activity log shows the agent pulled it
 * back and the human stays the source of truth (free to re-fold it). This MUTATES the
 * store; the restored content reaches the model at the next `context` hook (the block
 * drops out of `computeFoldOps`). Pure of the wire — the caller sends the result.
 */
export function resolveUnfold(store: AccordionStore, ids: string[]): { restored: UnfoldRestored[]; missing: string[] } {
	const restored: UnfoldRestored[] = [];
	const missing: string[] = [];
	for (const id of ids) {
		const b = store.get(id);
		// `missing` = nothing to restore for this id. Covers an unknown id AND a block
		// that ISN'T folded — already full, pinned by the human, protected, or a kind that
		// is never folded. Guarding on isFolded is the safety pillar: the agent can only
		// restore what was actually folded, so it can never downgrade a human pin or flip
		// an auto-managed block to a sticky agent-unfold. It can request, never force.
		if (!b || !store.isFolded(b)) {
			missing.push(id);
			continue;
		}
		store.unfold(b.id, "agent");
		restored.push({ id: b.id, kind: b.kind, label: blockLabel(b) });
	}
	return { restored, missing };
}
