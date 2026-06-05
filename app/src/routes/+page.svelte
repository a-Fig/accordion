<script lang="ts">
	import { session, isTauriEnv, loadSample, openFile } from "$lib/session.svelte.ts";
	import ContextSummary from "$lib/ui/ContextSummary.svelte";
	import ContextTimeline from "$lib/ui/ContextTimeline.svelte";
	import Timeline from "$lib/ui/Timeline.svelte";

	let view = $state<"summary" | "timeline">("summary");

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

{#if session.error && !session.store}
	<div class="fallback">
		<span class="logo">🪗</span>
		<p class="err">{session.error}</p>
		{#if isTauriEnv}
			<button class="btn-open" onclick={openFile}>Open session file…</button>
		{/if}
		<button class="btn-ghost" onclick={loadSample}>Load sample</button>
	</div>
{:else if !session.store}
	<div class="fallback">
		<span class="hero-logo">🪗</span>
		<h1>Accordion</h1>
		<p class="sub">Context-window visualizer for pi and Claude Code sessions</p>
		{#if isTauriEnv}
			<button class="btn-open" onclick={openFile}>Open session file…</button>
			<p class="hint mono">
				pi → ~/.pi/agent/sessions/ &nbsp;·&nbsp; Claude → ~/.claude/projects/
			</p>
		{:else}
			<p class="hint">Run the native app (<code>npm run tauri dev</code>) to open live sessions.</p>
		{/if}
		<button class="btn-ghost" onclick={loadSample}>Load sample (982 blocks)</button>
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
						{#if session.live}<span class="live-dot" title="Live — polling for changes"></span>{/if}
					</div>
					<div class="t2 mono">
						{s.meta.model || s.meta.format}
						{#if s.meta.cwd}· {baseName(s.meta.cwd)}{/if}
						· {s.blocks.length} blocks
					</div>
				</div>
			</div>
			<div class="nav-row">
				{#if isTauriEnv}
					<button class="nav" onclick={openFile}>Open…</button>
				{/if}
				<a class="nav" href="/map" data-sveltekit-reload={false}>Map view →</a>
			</div>
		</header>

		<section class="contextpane">
			<div class="switch">
				<button class:on={view === "summary"} onclick={() => (view = "summary")}>Summary</button>
				<button class:on={view === "timeline"} onclick={() => (view = "timeline")}>Timeline</button>
			</div>
			{#if view === "summary"}
				<ContextSummary store={s} onpick={pick} />
			{:else}
				<ContextTimeline store={s} onpick={pick} />
			{/if}
		</section>

		<div class="main">
			<main class="scroll">
				<Timeline store={s} />
			</main>

			<aside>
				<div class="ctl">
					<label class="ctl-l" for="budget">
						Context budget <b class="mono">{fmt(s.budget)}</b>
					</label>
					<input
						id="budget"
						type="range"
						min="12000"
						max="160000"
						step="2000"
						value={s.budget}
						oninput={(e) => s.setBudget(+e.currentTarget.value)}
					/>
					<button class="btn" onclick={() => s.resetAll()}>Reset all to auto</button>
				</div>

				<div class="feed">
					<div class="feed-h">Activity</div>
					{#if s.log.length === 0}
						<div class="empty muted">Fold, unfold or pin a block — moves show here, attributed.</div>
					{/if}
					{#each s.log as ev (ev.n)}
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
