/*
 * sliding-window.ts — "group everything old when the window fills" conductor.
 *
 * The dead-simple baseline:
 *  - Trigger: liveTokens > budget * 0.90
 *  - Action: ONE group command spanning every non-protected block. The host snaps it
 *    to whole messages and folds it to a single summary entry.
 *  - State: none. Recomputed from the raw baseline every pass (the host clears the
 *    prior conductor state before each call, so `liveTokens` is always the unfolded
 *    size). Once over 90% it stays grouped; once the protected tail alone fits, it
 *    clears back to raw.
 *
 * No ranking, no kind-skipping, no incremental chopping — just "fold the old stuff."
 */
import type { Conductor, ConductorView, Command } from "../contract";

/** Fraction of budget that triggers the fold. */
const TRIGGER_RATIO = 0.9;

export class SlidingWindowConductor implements Conductor {
	readonly id = "sliding-window";
	readonly label = "Sliding window";

	conduct(view: ConductorView): Command[] {
		if (view.budget <= 0 || view.blocks.length === 0) return [];

		// Under the threshold → nothing folded (clear to raw).
		if (view.liveTokens <= view.budget * TRIGGER_RATIO) return [];

		// Group every block older than the protected tail. A group needs ≥2 members;
		// the host snaps the [first, last] range outward to whole messages and folds it.
		const eligible = view.blocks.slice(0, view.protectedFromIndex);
		if (eligible.length < 2) return [];

		return [{ kind: "group", ids: [eligible[0].id, eligible[eligible.length - 1].id] }];
	}
}
