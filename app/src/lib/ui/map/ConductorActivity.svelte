<script lang="ts">
	import Icon from "$lib/ui/Icon.svelte";
	import type { AccordionStore, LogEntry } from "../../engine/store.svelte";

	let { store }: { store: AccordionStore } = $props();

	const ACTOR_LABEL: Record<string, string> = {
		conductor: "Conductor",
		you: "You",
		agent: "Agent",
		auto: "Auto",
	};

	const ACTOR_CLASS: Record<string, string> = {
		conductor: "actor-conductor",
		you: "actor-you",
		agent: "actor-agent",
		auto: "actor-auto",
	};

	const ACTION_ICON: Record<string, string> = {
		folded: "chevrons-down-up",
		unfolded: "chevrons-up-down",
		pinned: "pin",
		unpinned: "pin-off",
		grouped: "layers",
		ungrouped: "layers",
		"group folded": "chevrons-down-up",
		"group unfolded": "chevrons-up-down",
		reset: "refresh-cw",
		"unfolded (protected)": "chevrons-up-down",
		"ungrouped (protected)": "layers",
		fold: "chevrons-down-up",
		unfold: "chevrons-up-down",
		pin: "pin",
		unpin: "pin-off",
	};

	function iconFor(action: string) {
		return (ACTION_ICON[action] ?? "activity") as any;
	}
</script>

<aside class="activity">
	<header class="act-header">
		<Icon name="activity" size={13} stroke={2} />
		<span class="act-title">Activity</span>
		<span class="act-count tnum">{store.log.length}</span>
	</header>

	{#if store.log.length === 0}
		<div class="empty">No activity yet — changes appear here as they happen.</div>
	{:else}
		<ul class="log-list">
			{#each store.log as entry (entry.n)}
				<li class="log-entry">
					<span class="actor-badge {ACTOR_CLASS[entry.by] ?? 'actor-auto'}">
						{ACTOR_LABEL[entry.by] ?? entry.by}
					</span>
					<Icon name={iconFor(entry.action)} size={11} stroke={2} class="act-icon" />
					<span class="act-action">{entry.action}</span>
					<span class="act-detail">{entry.detail}</span>
				</li>
			{/each}
		</ul>
	{/if}
</aside>

<style>
	.activity {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--panel);
		border-left: 1px solid var(--line-soft);
		overflow: hidden;
	}

	.act-header {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-3) var(--sp-4);
		border-bottom: 1px solid var(--line-soft);
		background: var(--panel);
		position: sticky;
		top: 0;
		z-index: 2;
	}

	.act-title {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--muted);
		letter-spacing: .01em;
		flex: 1;
	}

	.act-count {
		font-size: var(--fs-xs);
		color: var(--faint);
	}

	.empty {
		padding: var(--sp-6) var(--sp-4);
		font-size: var(--fs-sm);
		color: var(--faint);
		text-align: center;
		line-height: 1.5;
	}

	.log-list {
		list-style: none;
		margin: 0;
		padding: var(--sp-2) 0;
		overflow-y: auto;
		flex: 1;
	}

	.log-entry {
		display: flex;
		align-items: baseline;
		gap: var(--sp-2);
		padding: var(--sp-1) var(--sp-4);
		font-size: var(--fs-xs);
		line-height: 1.5;
		border-bottom: 1px solid var(--line-soft);
	}

	.log-entry:last-child {
		border-bottom: none;
	}

	.actor-badge {
		flex-shrink: 0;
		font-size: 10px;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: var(--radius-pill);
		letter-spacing: .04em;
		text-transform: uppercase;
	}

	.actor-conductor {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--accent);
	}

	.actor-you {
		background: color-mix(in srgb, var(--k-user) 18%, transparent);
		color: var(--k-user);
	}

	.actor-agent {
		background: color-mix(in srgb, var(--k-thinking) 18%, transparent);
		color: var(--k-thinking);
	}

	.actor-auto {
		background: var(--panel-3);
		color: var(--muted);
	}

	.act-action {
		font-weight: 600;
		color: var(--text);
		flex-shrink: 0;
	}

	.act-detail {
		color: var(--faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
