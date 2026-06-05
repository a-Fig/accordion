<script lang="ts">
	import { session, isTauriEnv, loadSample, openFile } from "$lib/session.svelte.ts";
	import { connectLive, disconnectLive, live } from "$lib/live/liveClient.svelte";
	import MapHeader from "$lib/ui/map/MapHeader.svelte";
	import ContextMap from "$lib/ui/map/ContextMap.svelte";
	import Inspector from "$lib/ui/map/Inspector.svelte";

	let selectedId = $state<string | null>(null);

	const selected = $derived(
		session.store && selectedId ? session.store.blocks.find((b) => b.id === selectedId) ?? null : null,
	);

	function baseName(p: string): string {
		return p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p : "";
	}
</script>

<svelte:head><title>Accordion · Map</title></svelte:head>

{#if session.error && !session.store}
	<div class="fallback">
		<span class="hero-logo">🪗</span>
		<p class="err">{session.error}</p>
		{#if isTauriEnv}
			<button class="btn-open" onclick={openFile}>Open session file…</button>
		{/if}
		<button class="btn-ghost" onclick={loadSample}>Load sample</button>
	</div>
{:else if !session.store}
	<div class="fallback">
		<span class="hero-logo">🪗</span>
		<h1>Accordion · Map</h1>
		<p class="sub">Context-window visualizer for pi and Claude Code sessions</p>
		{#if isTauriEnv}
			<button class="btn-open" onclick={openFile}>Open session file…</button>
			<p class="hint mono">
				pi → ~/.pi/agent/sessions/ &nbsp;·&nbsp; Claude → ~/.claude/projects/
			</p>
		{:else}
			<p class="hint">Run the native app (<code>npm run tauri dev</code>) to open live sessions.</p>
		{/if}
		<button class="btn-open" onclick={() => connectLive()} disabled={live.status === "connecting"}>
			{live.status === "connecting" ? "Connecting to pi…" : "Connect to live pi session"}
		</button>
		<button class="btn-ghost" onclick={loadSample}>Load sample (982 blocks)</button>
		{#if live.status === "error"}<p class="err">{live.detail}</p>{/if}
		{#if session.error}<p class="err">{session.error}</p>{/if}
	</div>
{:else}
	{@const s = session.store}
	<div class="app">
		<header class="topbar">
			<div class="brand">
				<span class="logo">🪗</span>
				<div class="titles">
					<div class="t1">
						{session.filePath ? baseName(session.filePath) : s.meta.title}
						{#if live.status === "connected"}<span class="live-dot" title="Live — connected to pi"></span>
						{:else if session.live}<span class="live-dot" title="Live — polling for changes"></span>{/if}
					</div>
					<div class="t2 mono">
						{s.meta.model || s.meta.format}
						{#if s.meta.cwd}· {baseName(s.meta.cwd)}{/if}
						· map view
					</div>
				</div>
			</div>
			<div class="nav-row">
				{#if live.status === "connected"}
					<button class="nav" onclick={disconnectLive}>Disconnect</button>
				{:else if isTauriEnv}
					<button class="nav" onclick={openFile}>Open…</button>
				{/if}
				<a class="nav" href="/" data-sveltekit-reload={false}>Classic view →</a>
			</div>
		</header>

		<MapHeader store={s} />

		<div class="main" class:open={!!selected}>
			<div class="canvas">
				<ContextMap store={s} {selectedId} onselect={(id) => (selectedId = selectedId === id ? null : id)} />
			</div>
			{#if selected}
				<Inspector store={s} block={selected} onclose={() => (selectedId = null)} />
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
		gap: 12px;
	}
	.fallback .err {
		color: var(--danger);
		font-size: 13px;
	}
	.hero-logo {
		font-size: 48px;
		line-height: 1;
	}
	.fallback h1 {
		font-size: 22px;
		font-weight: 700;
		margin: 0;
	}
	.sub {
		font-size: 13px;
		color: var(--muted);
		margin: 0;
	}
	.btn-open {
		margin-top: 8px;
		background: var(--accent);
		color: #fff;
		border: none;
		padding: 10px 24px;
		border-radius: var(--radius-sm);
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: opacity 120ms ease;
	}
	.btn-open:hover {
		opacity: 0.85;
	}
	.btn-ghost {
		background: transparent;
		border: 1px solid var(--line);
		color: var(--muted);
		padding: 7px 18px;
		border-radius: var(--radius-sm);
		font-size: 13px;
		cursor: pointer;
		transition: color 120ms ease, border-color 120ms ease;
	}
	.btn-ghost:hover {
		color: var(--text);
		border-color: var(--muted);
	}
	.hint {
		font-size: 11px;
		color: var(--faint);
		margin: 0;
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
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.t2 {
		font-size: 11px;
		color: var(--muted);
	}
	.live-dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--ok);
		flex: 0 0 auto;
	}
	.nav-row {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 0 0 auto;
	}
	.nav {
		font-size: 12px;
		color: var(--accent);
		text-decoration: none;
		padding: 5px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		white-space: nowrap;
		background: transparent;
		cursor: pointer;
		transition: background 120ms ease;
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
