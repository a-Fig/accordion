<script lang="ts">
	import type { AccordionStore } from "../engine/store.svelte";
	import type { TurnGroup } from "../engine/types";

	let { store, group }: { store: AccordionStore; group: TurnGroup } = $props();

	const lines = $derived(store.groupDigestLines(group));
	const span = $derived(
		group.turns.length === 1
			? `T${group.turns[0]}`
			: `T${group.turns[0]}–T${group.turns[group.turns.length - 1]}`,
	);
	const tok = $derived(
		group.turns.reduce((sum, turn) => {
			for (const b of store.turnBlocks(turn)) sum += store.effTokens(b);
			return sum;
		}, 0),
	);
	const fmt = (n: number) => n.toLocaleString();
</script>

<article class="group-card">
	<header>
		<span class="icon" aria-hidden="true">▤</span>
		<span class="title">{group.turns.length} turns folded · {span}</span>
		<span class="tok mono">{fmt(tok)} tok</span>
		<span class="grow"></span>
		<button class="act" onclick={() => store.toggleGroup(group.id)}>
			{group.collapsed ? "Expand" : "Collapse"}
		</button>
		<button class="act subtle" onclick={() => store.ungroup(group.id)}>Ungroup</button>
	</header>
	{#if group.collapsed}
		<div class="sum">
			{#each lines as line}
				<div class="line">{line}</div>
			{/each}
		</div>
	{/if}
</article>

<style>
	.group-card {
		border: 1px solid var(--border, #2a3140);
		border-radius: 8px;
		background: var(--surface-2, #151a24);
		padding: 8px 10px;
		margin: 2px 0;
	}
	header {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
	}
	.icon {
		opacity: 0.7;
	}
	.title {
		font-weight: 600;
	}
	.tok {
		color: var(--muted, #8b95a8);
		font-size: 11px;
	}
	.grow {
		flex: 1;
	}
	.act {
		font: inherit;
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 4px;
		border: 1px solid var(--border, #2a3140);
		background: transparent;
		color: var(--text, #e8ecf4);
		cursor: pointer;
	}
	.act.subtle {
		opacity: 0.7;
	}
	.sum {
		margin-top: 8px;
		font-size: 11px;
		color: var(--muted, #8b95a8);
		line-height: 1.5;
	}
	.line::before {
		content: "• ";
	}
</style>
