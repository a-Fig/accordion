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
import type { FoldOp, GroupOp, UnfoldRestored } from "./protocol";
import { isDurableId } from "./mapping";
import { foldCode, FOLDABLE_KINDS } from "../engine/digest";

/**
 * Compute the fold plan for the current store state: one `FoldOp` per block that
 * the engine folds AND that passes the kind / durable-id / non-empty-digest
 * guards. Pure read; the store is never mutated. Ops preserve block order.
 */
export function computeFoldOps(store: AccordionStore): FoldOp[] {
	const ops: FoldOp[] = [];
	for (const b of store.blocks) {
		if (!store.isFolded(b)) continue;
		// A FOLDED group's members are collapsed by their GroupOp (the whole message is removed
		// and replaced by the summary). Emitting a per-block FoldOp here too is redundant on the
		// wire (applyPlan removes the message before any in-place fold runs) AND a trap — the op
		// would carry the block's own digest, divergent from the group summary. Skip them.
		if (store.groupOf(b)?.folded) continue;
		if (!FOLDABLE_KINDS.has(b.kind)) continue; // never user / tool_call
		if (!isDurableId(b.id)) continue; // durable-id safety guard
		const digestText = store.digestOf(b);
		if (!digestText) continue; // never empty a content part
		ops.push({ id: b.id, digestText });
	}
	return ops;
}

/**
 * Compute the group-collapse ops for the current store state (ADR 0006, extended for
 * C4 nesting in ADR 0011). One `GroupOp` per FOLDED, TOP-LEVEL group (a group not
 * subsumed by a folded parent). For nested groups, a folded parent already covers all
 * its children's leaf `memberIds` — emitting separate ops for both parent and children
 * would produce redundant (and conflicting) removal sets for `applyPlan`. The rule:
 *
 *   - A folded parent group → emit ONE GroupOp with `memberIds` = the parent's leaf
 *     block ids (union of all descendants). Children are skipped.
 *   - A folded child group whose parent is also folded → SKIP (subsumed).
 *   - A folded child group whose parent is UNFOLDED → emit its own GroupOp (it is now
 *     the top-level group in the display hierarchy at this point).
 *   - A flat (leaf, no children) group → emit as before.
 *
 * `memberIds` is always leaf durable block ids (non-durable filtered out). `summaryText`
 * is the engine's single-source-of-truth recap. Pure read; the store is never mutated.
 * `applyPlan` needs NO changes — its input is still flat `GroupOp[]` with leaf block ids.
 */
export function computeGroupOps(store: AccordionStore): GroupOp[] {
	// Build a set of child group ids that are subsumed by a FOLDED parent.
	const subsumedByFoldedParent = new Set<string>();
	for (const g of store.groups) {
		if (!g.folded || !g.children?.length) continue;
		for (const cid of g.children) subsumedByFoldedParent.add(cid);
	}

	const out: GroupOp[] = [];
	for (const g of store.groups) {
		if (!g.folded) continue;
		if (subsumedByFoldedParent.has(g.id)) continue; // covered by a folded parent's op
		const memberIds = g.memberIds.filter(isDurableId);
		if (!memberIds.length) continue; // nothing durably removable
		const summaryText = store.groupSummary(g);
		if (!summaryText) continue;
		out.push({ id: g.id, memberIds, summaryText });
	}
	return out;
}

/** Short, human-readable label for an unfold confirmation (e.g. "tool_result read_file · turn 12"). */
export function blockLabel(b: Block): string {
	const where = b.turn > 0 ? `turn ${b.turn}` : "preamble";
	return b.toolName ? `${b.kind} ${b.toolName} · ${where}` : `${b.kind} · ${where}`;
}

/**
 * Walk up the group ancestry from `groupId` and return the chain of ancestor group ids
 * from outermost (root) down to `groupId` itself. Used by `resolveUnfold` to ensure
 * every folded ancestor is opened before the target so the content actually reaches the
 * wire on the next plan.
 */
function ancestorChain(store: AccordionStore, groupId: string): string[] {
	// Build a map: child group id → parent group id (only one parent allowed per ADR 0011).
	const parentOf = new Map<string, string>();
	for (const g of store.groups) {
		if (!g.children?.length) continue;
		for (const cid of g.children) parentOf.set(cid, g.id);
	}
	// Walk up from groupId, collecting the chain.
	const chain: string[] = [];
	let cur: string | undefined = groupId;
	while (cur !== undefined) {
		chain.unshift(cur); // prepend so the array is outermost → innermost
		cur = parentOf.get(cur);
	}
	return chain; // [root, ..., groupId]
}

/**
 * Resolve an agent `unfold` request against the live store (protocol v3). For each
 * `code` the agent sent (read from a `{#<code> FOLDED}` tag), restore EVERY folded
 * block carrying that code and record it; a code that matches no folded block is
 * reported in `missing`.
 *
 * Why all matches: the code is a short hash of the durable id (see `foldCode`), so it
 * can rarely collide. Restoring every folded block that shares the code is the cheap,
 * stateless way to handle that — an extra restored block is harmless (it only shows the
 * model more of its own content).
 *
 * Restoring uses `store.unfold(id, "agent")` — a sticky override (protected from
 * auto-refold) with provenance "agent" so the activity log shows the agent pulled it
 * back and the human stays the source of truth (free to re-fold it). Guarding on
 * `isFolded` is the safety pillar: the agent can only restore what was actually folded,
 * so it can never downgrade a human pin or flip an auto-managed block to a sticky
 * agent-unfold. It can request, never force. This MUTATES the store; the restored
 * content reaches the model at the next `context` hook (the block drops out of
 * `computeFoldOps`). Pure of the wire — the caller sends the result.
 *
 * ANCESTOR HONESTY (ADR 0011 §3): when a matched block's group is itself subsumed by a
 * FOLDED ancestor, unfolding only the inner group changes nothing on the wire — the
 * ancestor's GroupOp still removes the whole range. Fix: walk up the full ancestor chain
 * and unfold EVERY folded ancestor from outermost down to the matched group; push a
 * restored entry for EACH group actually opened so "restore is never a lie" holds.
 */
export function resolveUnfold(store: AccordionStore, codes: string[]): { restored: UnfoldRestored[]; missing: string[] } {
	const restored: UnfoldRestored[] = [];
	const missing: string[] = [];
	for (const code of codes) {
		let hit = false;
		// A GROUP code (= foldCode(group.id)) restores the WHOLE range: unfold the group (and
		// any folded ancestors that subsume it), so its members reflow on the agent's next
		// context (ADR 0006 §6). Checked first; a code can in principle match both a group and
		// a block (rare collision) → restore both.
		for (const g of store.groups) {
			if (foldCode(g.id) === code) {
				// Walk the ancestor chain from outermost down; unfold every folded ancestor first,
				// then the group itself, so the content is actually delivered on the next plan.
				const chain = ancestorChain(store, g.id);
				for (const gid of chain) {
					const ancestor = store.groupById(gid);
					if (ancestor?.folded) {
						store.unfoldGroup(gid, "agent");
						restored.push({ code, kind: "text", label: `group · ${ancestor.memberIds.length} blocks` });
					}
				}
				hit = true;
			}
		}
		// Mirror EXACTLY the set `computeFoldOps` sends: folded, a foldable kind, and a
		// durable id. So the agent can only ever restore something it was actually shown a
		// `{#code FOLDED}` tag for — never a human pin, a locally-folded user/tool_call, or
		// a positional-id block that was never on the wire.
		const matches = store.blocks.filter((b) => store.isFolded(b) && FOLDABLE_KINDS.has(b.kind) && isDurableId(b.id) && foldCode(b.id) === code);
		for (const b of matches) {
			// A member of a FOLDED group is controlled by the group, not per-block overrides —
			// `store.unfold` would no-op there (ADR 0006 §2). Route it through `unfoldGroup` (with
			// ancestor chain) so the reported restore is never a lie.
			const grp = store.groupOf(b);
			if (grp) {
				// Unfold the full ancestor chain (outermost → innermost) so subsumed content
				// is actually delivered, not silently blocked by a folded parent.
				const chain = ancestorChain(store, grp.id);
				for (const gid of chain) {
					const ancestor = store.groupById(gid);
					if (ancestor?.folded) {
						store.unfoldGroup(gid, "agent");
						restored.push({ code, kind: "text", label: `group · ${ancestor.memberIds.length} blocks` });
					}
				}
			} else {
				store.unfold(b.id, "agent");
				restored.push({ code, kind: b.kind, label: blockLabel(b) });
			}
			hit = true;
		}
		if (!hit) missing.push(code);
	}
	return { restored, missing };
}
