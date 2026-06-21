<script lang="ts">
	import Icon from "$lib/ui/Icon.svelte";
	import type { IconName } from "$lib/ui/Icon.svelte";

	export type SegOption = { id: string; label: string; icon?: IconName };

	let {
		options,
		value,
		onchange,
		ariaLabel = undefined,
		iconSize = 13,
	}: {
		options: SegOption[];
		value: string;
		onchange: (id: string) => void;
		ariaLabel?: string;
		iconSize?: number;
	} = $props();
</script>

<div class="seg" role="group" aria-label={ariaLabel}>
	{#each options as o (o.id)}
		<button class="seg-pill" class:on={value === o.id} onclick={() => onchange(o.id)}>
			{#if o.icon}<Icon name={o.icon} size={iconSize} />{/if}
			<span>{o.label}</span>
		</button>
	{/each}
</div>

<style>
	.seg {
		display: inline-flex;
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 3px;
		gap: 2px;
		flex: 0 0 auto;
	}
	.seg-pill {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		background: transparent;
		border: none;
		color: var(--muted);
		font-family: var(--sans);
		font-size: var(--fs-xs);
		font-weight: 500;
		line-height: 1.4;
		letter-spacing: 0.01em;
		padding: var(--sp-1) var(--sp-3);
		border-radius: calc(var(--radius-sm) - 3px);
		transition:
			background var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out),
			box-shadow var(--dur-fast) var(--ease-out);
		white-space: nowrap;
		cursor: pointer;
	}
	.seg-pill:hover {
		color: var(--text);
	}
	.seg-pill.on {
		background: var(--panel-4);
		color: var(--text);
		font-weight: 600;
		box-shadow: var(--shadow-1);
	}
</style>
