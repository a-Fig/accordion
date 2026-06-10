<script lang="ts">
	import Icon from "$lib/ui/Icon.svelte";
	import SegControl from "$lib/ui/SegControl.svelte";
	import { conductor, setConductorMode } from "$lib/conductor/state.svelte";
	import type { ConductorMode } from "$lib/conductor/state.svelte";
	import { relTime } from "$lib/utils";

	let {
		log = [],
		readOnly = false,
	}: {
		log?: { by: string; action: string; detail: string; n: number }[];
		readOnly?: boolean;
	} = $props();

	// ── Seg control options ──
	const SEG_OPTIONS = [
		{ id: "off", label: "OFF" },
		{ id: "deterministic", label: "AUTO" },
		{ id: "attentive", label: "SMART" },
	];

	// ── Popover state ──
	let open = $state(false);
	let panelEl = $state<HTMLElement | undefined>(undefined);

	function toggleOpen() {
		open = !open;
	}

	// Close on outside click and Escape
	$effect(() => {
		if (!open) return;

		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				open = false;
			}
		}
		function onPointerDown(e: PointerEvent) {
			if (panelEl && !panelEl.contains(e.target as Node)) {
				open = false;
			}
		}

		window.addEventListener("keydown", onKey);
		window.addEventListener("pointerdown", onPointerDown);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", onPointerDown);
		};
	});

	// ── Cost formatting: 4 decimals, e.g. "$0.0042" ──
	function fmtCost(n: number): string {
		return "$" + n.toFixed(4);
	}

	// ── Actor chip color class ──
	function actorClass(by: string): string {
		if (by === "you") return "actor-you";
		if (by === "agent") return "actor-agent";
		if (by === "conductor") return "actor-conductor";
		return "actor-auto";
	}

	// ── Derived: log entries for the popover — already newest-first from the store ──
	const recentLog = $derived(log);

	// ── Handle seg change (disabled in readOnly) ──
	function onModeChange(id: string) {
		if (readOnly) return;
		setConductorMode(id as ConductorMode);
	}
</script>

<div class="conductor-wrap" bind:this={panelEl}>
	<!-- Label + toggle -->
	<button
		class="kl conductor-label"
		onclick={toggleOpen}
		aria-expanded={open}
		aria-haspopup="dialog"
		title="Conductor activity log"
	>
		<Icon name="activity" size={11} />
		<span class="kl-text">CONDUCTOR</span>
		<Icon name="chevron-down" size={10} class="chevron {open ? 'open' : ''}" />
	</button>

	<!-- 3-state seg control -->
	{#if readOnly}
		<div
			class="seg-disabled"
			title="read-only session"
			aria-disabled="true"
		>
			<div class="seg-inner">
				{#each SEG_OPTIONS as o (o.id)}
					<span
						class="seg-pill-static"
						class:seg-pill-on={o.id === conductor.mode}
						class:seg-pill-off={o.id !== conductor.mode}
					>{o.label}</span>
				{/each}
			</div>
		</div>
	{:else}
		<SegControl
			options={SEG_OPTIONS}
			value={conductor.mode}
			onchange={onModeChange}
			ariaLabel="Conductor mode"
		/>
	{/if}

	<!-- Status cluster: busy dot + tick count + per-layer costs -->
	<span class="status-cluster tnum">
		<span
			class="busy-dot"
			class:busy={conductor.busy}
			aria-label={conductor.busy ? "tick in flight" : "idle"}
			title={conductor.busy ? "Conductor tick in flight…" : "Idle"}
		></span>
		<span class="tick-count">{conductor.ticks}</span>
		{#if conductor.mode === "attentive" && conductor.tickCostUSD > 0}
			<span class="cost" title="Tick cost (attentive LLM calls)">tick {fmtCost(conductor.tickCostUSD)}</span>
		{/if}
		{#if conductor.summaryCostUSD > 0}
			<span class="cost" title="Summary cost (C2 summarize-ahead)">sum {fmtCost(conductor.summaryCostUSD)}</span>
		{/if}
	</span>

	<!-- Misses / preempts -->
	<span
		class="miss-preempt tnum"
		title="Misses: agent reached for a folded block ({conductor.misses}) / Preempts: already open when needed ({conductor.preempts})"
	>
		<span class="miss">{conductor.misses}↯</span>
		<span class="sep">/</span>
		<span class="preempt">{conductor.preempts}✓</span>
	</span>

	<!-- Anchored popover -->
	{#if open}
		<div class="popover" role="dialog" aria-label="Conductor activity">
			<div class="popover-title">Conductor activity</div>

			<!-- Conductor lastActions -->
			{#if conductor.lastActions.length === 0}
				<p class="empty-hint">No actions yet this session.</p>
			{:else}
				<ul class="action-list">
					{#each conductor.lastActions as a (a.at + a.label)}
						<li class="action-row">
							<span class="action-chip" class:chip-fold={a.kind === "fold"} class:chip-unfold={a.kind === "unfold"}>
								{a.kind === "fold" ? "FOLD" : "UNFOLD"}
							</span>
							<span class="action-label" title={a.label}>{a.label}</span>
							<span class="action-reason">{a.reason}</span>
							<span class="action-time">{relTime(a.at)}</span>
						</li>
					{/each}
				</ul>
			{/if}

			<div class="divider"></div>

			<!-- Store activity log -->
			<div class="log-section-title">Session log</div>
			{#if recentLog.length === 0}
				<p class="empty-hint">No log entries.</p>
			{:else}
				<ul class="log-list">
					{#each recentLog as entry, i (i)}
						<li class="log-row">
							<span class="actor-chip {actorClass(entry.by)}">{entry.by}</span>
							<span class="log-action">{entry.action}</span>
							<span class="log-detail">{entry.detail}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* ── Wrapper: positions the popover anchor ── */
	.conductor-wrap {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
		flex: 0 0 auto;
	}

	/* ── Label button: mirrors .kl from MapHeader ── */
	.conductor-label {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-xs);
		color: var(--faint);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		user-select: none;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		transition: color var(--dur-fast) var(--ease-out);
		white-space: nowrap;
	}
	.conductor-label:hover {
		color: var(--muted);
	}
	/* chevron rotation when open — driven by class set in template */
	.conductor-label :global(.chevron) {
		transition: transform var(--dur-fast) var(--ease-out);
	}
	.conductor-label :global(.chevron.open) {
		transform: rotate(180deg);
	}

	/* ── Disabled seg wrapper ── */
	.seg-disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}
	.seg-inner {
		display: inline-flex;
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 3px;
		gap: 3px;
	}
	.seg-pill-static {
		display: inline-flex;
		align-items: center;
		font-size: var(--fs-xs);
		font-weight: 500;
		padding: var(--sp-1) var(--sp-2);
		border-radius: calc(var(--radius-sm) - 2px);
		white-space: nowrap;
		pointer-events: none;
		user-select: none;
	}
	.seg-pill-off {
		background: transparent;
		color: var(--muted);
	}
	/* Active pill in read-only mode — mirrors the SegControl "on" appearance. */
	.seg-pill-on {
		background: var(--panel-3);
		color: var(--text);
		box-shadow: 0 1px 2px color-mix(in srgb, #000 20%, transparent);
	}

	/* ── Status cluster ── */
	.status-cluster {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: var(--fs-xs);
		color: var(--muted);
	}

	/* Busy dot — mirrors halo-pulse from SessionsSidebar */
	.busy-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--faint);
		flex: 0 0 auto;
		transition:
			background var(--dur-fast) var(--ease-out),
			box-shadow var(--dur-fast) var(--ease-out);
	}
	@keyframes conductor-pulse {
		0%, 100% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--warn) 28%, transparent); }
		50%       { box-shadow: 0 0 0 4px color-mix(in srgb, var(--warn) 10%, transparent); }
	}
	.busy-dot.busy {
		background: var(--warn);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--warn) 28%, transparent);
		animation: conductor-pulse var(--dur-slow) ease-in-out infinite;
	}

	.tick-count {
		font-family: var(--mono);
		font-variant-numeric: tabular-nums;
	}

	.cost {
		font-family: var(--mono);
		font-variant-numeric: tabular-nums;
		color: var(--faint);
		font-size: var(--fs-xs);
	}

	/* ── Misses / preempts readout ── */
	.miss-preempt {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-xs);
		font-family: var(--mono);
		font-variant-numeric: tabular-nums;
		user-select: none;
	}
	.miss {
		color: var(--danger);
		opacity: 0.8;
	}
	.sep {
		color: var(--faint);
	}
	.preempt {
		color: var(--ok);
		opacity: 0.8;
	}

	/* ── Popover ── */
	.popover {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		z-index: 200;
		min-width: 340px;
		max-width: 420px;
		background: var(--panel-2);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-3);
		padding: var(--sp-3);
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		/* Fly-in transition */
		animation: popover-fly var(--dur-mid) var(--ease-out) both;
	}
	@keyframes popover-fly {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.popover-title {
		font-size: var(--fs-xs);
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--muted);
		padding-bottom: var(--sp-1);
	}

	.empty-hint {
		font-size: var(--fs-xs);
		color: var(--faint);
		margin: 0;
		padding: var(--sp-1) 0;
	}

	/* ── Action list (conductor.lastActions) ── */
	.action-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
		max-height: 160px;
		overflow-y: auto;
	}
	.action-row {
		display: grid;
		grid-template-columns: auto 1fr auto auto;
		align-items: center;
		gap: var(--sp-2);
		font-size: var(--fs-xs);
		min-width: 0;
	}
	.action-chip {
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.05em;
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		flex: 0 0 auto;
		user-select: none;
	}
	.chip-fold {
		background: color-mix(in srgb, var(--k-thinking) 18%, var(--panel-3));
		color: var(--k-thinking);
		border: 1px solid color-mix(in srgb, var(--k-thinking) 30%, transparent);
	}
	.chip-unfold {
		background: color-mix(in srgb, var(--k-tool_call) 18%, var(--panel-3));
		color: var(--k-tool_call);
		border: 1px solid color-mix(in srgb, var(--k-tool_call) 30%, transparent);
	}
	.action-label {
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.action-reason {
		color: var(--faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-2xs);
		max-width: 120px;
	}
	.action-time {
		color: var(--faint);
		font-family: var(--mono);
		font-variant-numeric: tabular-nums;
		font-size: var(--fs-2xs);
		white-space: nowrap;
		flex: 0 0 auto;
	}

	/* ── Divider ── */
	.divider {
		height: 1px;
		background: var(--line-soft);
		margin: var(--sp-1) 0;
	}

	/* ── Log section (store activity log) ── */
	.log-section-title {
		font-size: var(--fs-xs);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--faint);
		margin-bottom: 2px;
	}
	.log-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
		max-height: 160px;
		overflow-y: auto;
	}
	.log-row {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		font-size: var(--fs-xs);
		min-width: 0;
	}
	.actor-chip {
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.03em;
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		flex: 0 0 auto;
		text-transform: lowercase;
		user-select: none;
	}
	/* Actor color classes */
	.actor-you {
		background: color-mix(in srgb, var(--accent) 18%, var(--panel-3));
		color: var(--accent);
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
	}
	.actor-agent {
		background: color-mix(in srgb, var(--k-tool_call) 18%, var(--panel-3));
		color: var(--k-tool_call);
		border: 1px solid color-mix(in srgb, var(--k-tool_call) 30%, transparent);
	}
	.actor-conductor {
		background: color-mix(in srgb, var(--warn) 18%, var(--panel-3));
		color: var(--warn);
		border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
	}
	.actor-auto {
		background: color-mix(in srgb, var(--muted) 14%, var(--panel-3));
		color: var(--muted);
		border: 1px solid color-mix(in srgb, var(--muted) 25%, transparent);
	}
	.log-action {
		color: var(--text);
		white-space: nowrap;
	}
	.log-detail {
		color: var(--faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1 1 0;
		min-width: 0;
	}

</style>
