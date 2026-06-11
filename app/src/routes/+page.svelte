<script lang="ts">
	import { onMount } from "svelte";
	import { conductorSettings } from "$lib/engine/conductor-settings.svelte";
	import { parse } from "$lib/engine/parse";
	import { AccordionStore } from "$lib/engine/store.svelte";
	import { live } from "$lib/live.svelte";
	import ConductorSettings from "$lib/ui/ConductorSettings.svelte";
	import ContextSummary from "$lib/ui/ContextSummary.svelte";
	import ContextTimeline from "$lib/ui/ContextTimeline.svelte";
	import ReplayBar from "$lib/ui/ReplayBar.svelte";
	import Timeline from "$lib/ui/Timeline.svelte";

	let sampleStore = $state<AccordionStore | null>(null);
	let error = $state("");
	let view = $state<"summary" | "timeline">("summary");

	// When live is on we show its (shared, persistent) store; otherwise the sample.
	const store = $derived(live.enabled && live.store ? live.store : sampleStore);

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
			const parsed = parse(await res.text());
			sampleStore = new AccordionStore(parsed);
			if (typeof window !== "undefined" && !live.enabled) (window as any).__store = sampleStore;
			error = "";
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	onMount(loadSample);

	const fmt = (n: number) => n.toLocaleString();

	function pick(id: string) {
		const el = document.getElementById("block-" + id);
		if (!el) return;
		el.scrollIntoView({ behavior: "smooth", block: "center" });
		el.classList.add("flash");
		setTimeout(() => el.classList.remove("flash"), 900);
	}

	function baseName(p: string): string {
		return p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p : "";
	}
</script>

<svelte:head><title>Accordion</title></svelte:head>

{#if error}
	<div class="fallback">
		<h1>🪗 Accordion</h1>
		<p class="err">Couldn't load the session: {error}</p>
	</div>
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
						· {store.blocks.length} blocks
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
					<span class="dot state-dot state-{live.state}" aria-hidden="true"></span>
					{live.enabled ? (live.connected ? "LIVE" : "RECONNECTING") : "Go live"}
				</button>
				<a class="nav" href="/map" data-sveltekit-reload={false}>Map view →</a>
			</div>
		</header>

		<section class="contextpane">
			<ReplayBar {store} />
			<div class="switch">
				<button class:on={view === "summary"} onclick={() => (view = "summary")}>Summary</button>
				<button class:on={view === "timeline"} onclick={() => (view = "timeline")}>Timeline</button>
			</div>
			{#if view === "summary"}
				<ContextSummary {store} onpick={pick} />
			{:else}
				<ContextTimeline {store} onpick={pick} />
			{/if}
		</section>

		{#if live.enabled && (live.state === "waiting" || live.state === "error")}
			<div class="live-state-banner" class:is-error={live.state === "error"}>
				{#if live.state === "error"}
					<span class="ls-glyph">⌯</span>
					<span class="ls-head">Cannot reach live session</span>
					<span class="ls-body">{live.hint}</span>
				{:else}
					<span class="ls-glyph">⌯</span>
					<span class="ls-head">Waiting for a live session</span>
					<span class="ls-body">{live.hint || "Start pi with the accordion extension and run /accordion."}</span>
					<code class="ls-cmd">pi /accordion</code>
				{/if}
			</div>
		{/if}

		<div class="main">
			<main class="scroll">
				<Timeline {store} />
			</main>

			<aside>
				<div class="ctl">
					<label class="ctl-l" for="budget">
						Context budget <b class="mono">{fmt(store.budget)}</b>
					</label>
					<input
						id="budget"
						type="range"
						min="12000"
						max="160000"
						step="2000"
						value={store.budget}
						oninput={(e) => store!.setBudget(+e.currentTarget.value)}
					/>
					<button class="btn" onclick={() => store!.resetAll()}>Reset all to auto</button>
					<ConductorSettings foldTargetCalibrated={store.foldTargetCalibrated} {store} />
				</div>

				<div class="feed">
					<div class="feed-h">Activity</div>
					{#if store.log.length === 0}
						<div class="empty muted">Fold, unfold or pin a block — moves show here, attributed.</div>
					{/if}
					{#each store.log as ev (ev.n)}
						<div class="ev">
							<span class="who who-{ev.by}">{ev.by}</span>
							<span class="ev-a">{ev.action}</span>
							<span class="ev-d">{ev.detail}</span>
						</div>
					{/each}
				</div>
			</aside>
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
	.titles {
		min-width: 0;
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

	.contextpane {
		padding: 14px 16px;
		border-bottom: 1px solid var(--line);
		background: var(--bg);
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		gap: 11px;
	}
	.switch {
		display: inline-flex;
		align-self: flex-start;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 2px;
		gap: 2px;
	}
	.switch button {
		background: transparent;
		border: none;
		color: var(--muted);
		font-size: 12px;
		font-weight: 600;
		padding: 4px 14px;
		border-radius: 5px;
		transition: background 120ms ease, color 120ms ease;
	}
	.switch button:hover {
		color: var(--text);
	}
	.switch button.on {
		background: var(--panel-3);
		color: var(--text);
	}

	.main {
		flex: 1;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 290px;
		overflow: hidden;
	}
	.scroll {
		overflow-y: auto;
		padding: 8px 16px;
	}
	aside {
		border-left: 1px solid var(--line);
		background: var(--panel);
		overflow-y: auto;
		padding: 14px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.ctl {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.ctl-l {
		font-size: 12px;
		color: var(--muted);
		display: flex;
		justify-content: space-between;
	}
	.ctl-l b {
		color: var(--text);
	}
	input[type="range"] {
		width: 100%;
		accent-color: var(--accent);
	}
	.btn {
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--text);
		padding: 6px 10px;
		border-radius: var(--radius-sm);
		font-size: 12px;
		transition: background 120ms ease;
	}
	.btn:hover {
		background: var(--line);
	}

	.feed {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-height: 0;
	}
	.feed-h {
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--faint);
		font-weight: 600;
	}
	.empty {
		font-size: 12px;
		line-height: 1.5;
	}
	.ev {
		font-size: 12px;
		display: flex;
		gap: 6px;
		align-items: baseline;
	}
	.who {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 1px 5px;
		border-radius: 4px;
		background: var(--panel-3);
		color: var(--muted);
		flex: 0 0 auto;
	}
	.who-you {
		color: var(--accent);
	}
	.who-auto {
		color: var(--warn);
	}
	.who-agent {
		color: var(--ok);
	}
	.ev-a {
		color: var(--text);
	}
	.ev-d {
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.muted {
		color: var(--muted);
	}

	/* live state dot */
	.state-dot { transition: background 160ms ease; }
	.state-off { background: var(--faint); }
	.state-connecting { background: var(--warn); animation: live-pulse 1.2s ease-in-out infinite; }
	.state-waiting { background: var(--warn); animation: live-pulse 1.2s ease-in-out infinite; }
	.state-connected { background: var(--ok); }
	.state-error { background: var(--danger); }

	/* live empty/error banner */
	.live-state-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 16px;
		background: var(--panel-2);
		border-bottom: 1px solid var(--line-soft);
		font-size: 12px;
		color: var(--muted);
		flex: 0 0 auto;
	}
	.live-state-banner.is-error { color: var(--danger); border-bottom-color: color-mix(in srgb, var(--danger) 30%, var(--line)); }
	.ls-glyph { font-size: 18px; opacity: 0.5; flex: 0 0 auto; }
	.ls-head { font-weight: 600; color: var(--text); white-space: nowrap; }
	.ls-body { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.live-state-banner.is-error .ls-body { color: var(--danger); opacity: 0.8; }
	.ls-cmd { font-family: var(--mono); font-size: 11px; background: var(--panel-3); border: 1px solid var(--line); padding: 2px 8px; border-radius: var(--radius-sm); color: var(--accent); white-space: nowrap; user-select: all; }
	:global(.flash) {
		animation: flash 0.9s ease;
	}
	@keyframes flash {
		0%,
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
		30% {
			box-shadow: 0 0 0 2px var(--accent);
		}
	}
</style>
