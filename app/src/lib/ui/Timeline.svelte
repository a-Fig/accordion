<script lang="ts">
	import type { AccordionStore } from "../engine/store.svelte";
	import type { Block } from "../engine/types";
	import BlockCard from "./BlockCard.svelte";
	import GroupCard from "./GroupCard.svelte";

	let { store }: { store: AccordionStore } = $props();

	type Row =
		| { kind: "group"; groupId: string }
		| { kind: "divider"; turn: number }
		| { kind: "block"; block: Block };

	const rows = $derived.by((): Row[] => {
		const out: Row[] = [];
		const seenGroups = new Set<string>();
		let prev = -1;
		for (const b of store.viewBlocks) {
			const g = store.groupOfTurn(b.turn);
			if (g?.collapsed) {
				if (!seenGroups.has(g.id)) {
					out.push({ kind: "group", groupId: g.id });
					seenGroups.add(g.id);
				}
				continue;
			}
			if (b.turn !== prev) {
				out.push({ kind: "divider", turn: b.turn });
				prev = b.turn;
			}
			out.push({ kind: "block", block: b });
		}
		return out;
	});
</script>

<div class="timeline">
	{#each rows as row (row.kind === "group" ? "g" + row.groupId : row.kind === "divider" ? "d" + row.turn : row.block.id)}
		{#if row.kind === "group"}
			{@const g = store.groups.get(row.groupId)}
			{#if g}
				<GroupCard {store} group={g} />
			{/if}
		{:else if row.kind === "divider"}
			<div class="divider">
				<span class="ln"></span>
				<span class="lbl">{row.turn === 0 ? "Session start" : `Turn ${row.turn}`}</span>
				<span class="ln"></span>
			</div>
		{:else}
			<BlockCard {store} block={row.block} />
		{/if}
	{/each}
</div>

<style>
	.timeline {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 4px 2px 40vh;
	}
	.divider {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 14px 2px 6px;
	}
	.divider .ln {
		height: 1px;
		flex: 1;
		background: var(--border, #2a3140);
		opacity: 0.6;
	}
	.divider .lbl {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted, #8b95a8);
		white-space: nowrap;
	}
</style>
