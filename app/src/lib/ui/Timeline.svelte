<script lang="ts">
	import type { AccordionStore } from "../engine/store.svelte";
	import type { Block } from "../engine/types";
	import BlockCard from "./BlockCard.svelte";
	import GroupCard from "./GroupCard.svelte";

	let { store }: { store: AccordionStore } = $props();

	type Row =
		| { kind: "group"; groupId: string }
		| { kind: "divider"; turn: number }
		| { kind: "block"; block: Block }
		| { kind: "l3group"; blocks: Block[]; turns: number[] }
		| { kind: "l3block"; block: Block };

	const rows = $derived.by((): Row[] => {
		const out: Row[] = [];
		const seenGroups = new Set<string>();
		let prev = -1;
		const blocks = store.viewBlocks;
		let i = 0;
		while (i < blocks.length) {
			const b = blocks[i];
			const g = store.groupOfTurn(b.turn);
			if (g?.collapsed) {
				if (!seenGroups.has(g.id)) {
					out.push({ kind: "group", groupId: g.id });
					seenGroups.add(g.id);
				}
				i++;
				continue;
			}
			// Group consecutive foldLevel === 3 blocks
			if (b.foldLevel === 3) {
				const groupBlocks: Block[] = [];
				while (i < blocks.length && blocks[i].foldLevel === 3) {
					groupBlocks.push(blocks[i]);
					i++;
				}
				const turnSet = new Set(groupBlocks.map((x) => x.turn));
				const turns = [...turnSet].sort((a, z) => a - z);
				out.push({ kind: "l3group", blocks: groupBlocks, turns });
				for (const gb of groupBlocks) {
					out.push({ kind: "l3block", block: gb });
				}
				continue;
			}
			if (b.turn !== prev) {
				out.push({ kind: "divider", turn: b.turn });
				prev = b.turn;
			}
			out.push({ kind: "block", block: b });
			i++;
		}
		return out;
	});
</script>

<div class="timeline">
	{#each rows as row (row.kind === "group" ? "g" + row.groupId : row.kind === "divider" ? "d" + row.turn : row.kind === "l3group" ? "l3g" + row.turns[0] : row.kind === "l3block" ? "l3b" + row.block.id : row.block.id)}
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
		{:else if row.kind === "l3group"}
			<div class="l3-group-header mono">
				⟦group · turns {row.turns[0]}{row.turns.length > 1 ? `–${row.turns.at(-1)}` : ""} · {row.blocks.length} units⟧
			</div>
		{:else if row.kind === "l3block"}
			<div class="l3-indent">
				<BlockCard {store} block={row.block} />
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
	.l3-group-header {
		font-size: 11px;
		color: var(--faint);
		padding: 4px 8px;
		border-left: 2px solid var(--line);
		margin: 4px 0 2px;
	}
	.l3-indent {
		margin-left: 20px;
	}
</style>
