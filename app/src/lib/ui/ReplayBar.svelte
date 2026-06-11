<script lang="ts">
	import type { AccordionStore } from "../engine/store.svelte";

	let { store }: { store: AccordionStore } = $props();

	const canReplay = $derived(store.turnCount >= 3);
	const canGroup = $derived(store.leadingFoldedTurnCount() >= 2);
</script>

<div class="replay-bar">
	<button
		class="btn"
		disabled={!canReplay}
		onclick={() => (store.replayPlaying ? store.pauseReplay() : store.startReplay())}
		title={canReplay ? "Step through turns" : "Need ≥3 turns to replay"}
	>
		{store.replayPlaying ? "Pause" : "Replay"}
	</button>
	<button class="btn" disabled={!store.inReplay && !store.replayPlaying} onclick={() => store.stepReplay()} title="Advance one turn">
		Step
	</button>
	<button class="btn" disabled={!store.inReplay && !store.replayPlaying} onclick={() => store.resetReplay()} title="Show full session">
		Reset
	</button>
	{#if store.inReplay}
		<span class="hint mono">turn {store.revealUpToTurn} / {store.maxTurn}</span>
	{/if}
	<span class="grow"></span>
	<button
		class="btn"
		disabled={!canGroup}
		onclick={() => {
			if (!store.groupColdHistory("you")) return;
		}}
		title={canGroup ? "Bundle leading folded turns" : "Need ≥2 leading folded turns"}
	>
		Group folds
	</button>
</div>

<style>
	.replay-bar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 0 2px;
		flex-wrap: wrap;
	}
	.grow {
		flex: 1;
	}
	.btn {
		font: inherit;
		font-size: var(--ctl-fs, 11px);
		height: var(--ctl-h, 24px);
		padding: 0 10px;
		border-radius: 6px;
		border: 1px solid var(--border, #2a3140);
		background: var(--surface-2, #1a1f2b);
		color: var(--text, #e8ecf4);
		cursor: pointer;
	}
	.btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.hint {
		font-size: 11px;
		color: var(--muted, #8b95a8);
	}
</style>
