<script lang="ts">
	import { onMount } from "svelte";
	import { conductorSettings } from "$lib/engine/conductor-settings.svelte";
	import { parse } from "$lib/engine/parse";
	import { AccordionStore } from "$lib/engine/store.svelte";
	import { live } from "$lib/live.svelte";
	import MapHeader from "$lib/ui/map/MapHeader.svelte";
	import ContextMap from "$lib/ui/map/ContextMap.svelte";
	import Inspector from "$lib/ui/map/Inspector.svelte";

	let sampleStore = $state<AccordionStore | null>(null);
	let error = $state("");
	let selectedId = $state<string | null>(null);

	const store = $derived(live.enabled && live.store ? live.store : sampleStore);
	const selected = $derived(store && selectedId ? store.blocks.find((b) => b.id === selectedId) ?? null : null);

	$effect(() => {
		const s = store;
		if (!s) return;
		const _cfg = conductorSettings.config;
		const _budget = s.budget;
		const _tail = s.protectTokens;
		conductorSettings.syncWithStore(s);
	});

	async function loadSample() {
		try {
			const res = await fetch("/sample-session.jsonl");
			if (!res.ok) throw new Error(`failed to load session (${res.status})`);
			sampleStore = new AccordionStore(parse(await res.text()));
			if (typeof window !== "undefined" && !live.enabled) (window as any).__store = sampleStore;
			error = "";
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	onMount(loadSample);

	function baseName(p: string): string {
		return p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p : "";
	}
</script>

<svelte:head><title>Accordion · Map</title></svelte:head>

{#if error}
	<div class="fallback"><h1>🪗 Accordion · Map</h1><p class="err">Couldn't load the session: {error}</p></div>
{:else if !store}
	<div class="fallback"><p class="muted">Loading session…</p></div>
{:else}
	<div class="app">
		<header class="topbar">
			<div class="brand">
				<span class="logo">🪗</span>
				<div class="titles">
					<div class="t1">{store.meta.title}</div>
					<div class="t2 mono">
						{store.meta.model || store.meta.format}
						{#if store.meta.cwd}· {baseName(store.meta.cwd)}{/if}
						· map view
					</div>
				</div>
			</div>
			<div class="navrow">
				{#if live.enabled && live.hint}
					<span class="live-hint" title={live.hint}>{live.hint}</span>
				{/if}
				<button
					class="live-btn"
					class:live-on={live.enabled}
					class:live-connected={live.enabled && live.connected}
					onclick={() => live.toggle()}
					aria-pressed={live.enabled}
				>
					<span class="dot" aria-hidden="true"></span>
					{live.enabled ? (live.connected ? "LIVE" : "RECONNECTING") : "Go live"}
				</button>
				<a class="nav" href="/" data-sveltekit-reload={false}>Classic view →</a>
			</div>
		</header>

		<MapHeader {store} />

		<div class="main" class:open={!!selected}>
			<div class="canvas">
				<ContextMap {store} {selectedId} onselect={(id) => (selectedId = selectedId === id ? null : id)} />
			</div>
			{#if selected}
				<Inspector {store} block={selected} onclose={() => (selectedId = null)} />
			{/if}
		</div>
	</div>
{/if}

<style>
	.app {
		height: 100vh;
		display: flex;
		flex-direction: column;
	}
	.fallback {
		height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
	}
	.fallback .err {
		color: var(--danger);
	}
	.muted {
		color: var(--muted);
	}

	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 16px;
		border-bottom: 1px solid var(--line);
		background: var(--panel);
		flex: 0 0 auto;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 11px;
		min-width: 0;
	}
	.logo {
		font-size: 22px;
	}
	.t1 {
		font-weight: 600;
		font-size: 14px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 52vw;
	}
	.t2 {
		font-size: 11px;
		color: var(--muted);
	}
	.navrow {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.live-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.06em;
		padding: 5px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		white-space: nowrap;
		transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
	}
	.live-btn .dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--muted);
		flex: 0 0 7px;
	}
	.live-btn.live-on {
		color: #f0a35e;
		border-color: color-mix(in srgb, #f0a35e 55%, var(--line));
		background: color-mix(in srgb, #f0a35e 8%, transparent);
	}
	.live-btn.live-on .dot {
		background: #f0a35e;
	}
	.live-btn.live-connected {
		color: #2ecc71;
		border-color: color-mix(in srgb, #2ecc71 55%, var(--line));
		background: color-mix(in srgb, #2ecc71 10%, transparent);
	}
	.live-btn.live-connected .dot {
		background: #2ecc71;
		box-shadow: 0 0 0 0 rgba(46, 204, 113, 0.7);
		animation: live-pulse 1.4s ease-out infinite;
	}
	@keyframes live-pulse {
		0% { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0.7); }
		70% { box-shadow: 0 0 0 6px rgba(46, 204, 113, 0); }
		100% { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0); }
	}
	.live-hint {
		font-size: 11px;
		color: var(--muted);
		background: var(--panel-2);
		border: 1px solid var(--line);
		padding: 3px 8px;
		border-radius: var(--radius-sm);
		max-width: 38vw;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.nav {
		font-size: 12px;
		color: var(--accent);
		text-decoration: none;
		padding: 5px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		white-space: nowrap;
	}
	.nav:hover {
		background: var(--panel-2);
	}

	.main {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		overflow: hidden;
	}
	.main.open {
		grid-template-columns: minmax(0, 1fr) minmax(360px, 30vw);
	}
	.canvas {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
</style>
