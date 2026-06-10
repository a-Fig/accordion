<script lang="ts">
	import { summaryBackend } from "../engine/conductor-config";
	import { conductorSettings } from "../engine/conductor-settings.svelte";

	let { foldTargetCalibrated = 0.8 }: { foldTargetCalibrated?: number } = $props();

	const config = $derived(conductorSettings.config);
	const summary = $derived(summaryBackend(config));
	const providerStatus = $derived(conductorSettings.providerStatus);
	const pct = (n: number) => `${Math.round(n * 100)}%`;
</script>

<div class="wrap">
	<button
		class="gear"
		onclick={() => (conductorSettings.open = !conductorSettings.open)}
		aria-expanded={conductorSettings.open}
		aria-label="Conductor settings"
	>⚙</button>
	{#if conductorSettings.open}
		<div class="panel" role="region" aria-label="Conductor settings">
			<div class="ro">
				<span>Summary</span>
				<span class="mono">{summary.backend}{summary.model ? ` · ${summary.model}` : ""}</span>
			</div>
			<div class="ro">
				<span>Embeddings</span>
				<span class="mono">{config.embeddingsEnabled ? config.embeddingModel : "disabled"}</span>
			</div>
			<div class="ro">
				<span>Provider</span>
				<span class="mono status-{providerStatus}">{providerStatus}</span>
			</div>
			<label class="fld"><span>Budget</span><input class="mono" type="number" min="12000" max="500000" step="1000" value={config.budgetTokens} oninput={(e) => conductorSettings.patch({ budgetTokens: +e.currentTarget.value })} /></label>
			<label class="fld"><span>Protected tail</span><input class="mono" type="number" min="0" max="60000" step="1000" value={config.workingTailTokens} oninput={(e) => conductorSettings.patch({ workingTailTokens: +e.currentTarget.value })} /></label>
			<div class="band">
				<span>Fold band <b class="mono">{pct(foldTargetCalibrated)}</b> live</span>
				<label class="rng"><span class="mono">min {pct(config.foldTargetMin)}</span><input type="range" min="0.6" max="0.92" step="0.01" value={config.foldTargetMin} oninput={(e) => conductorSettings.patch({ foldTargetMin: +e.currentTarget.value })} /></label>
				<label class="rng"><span class="mono">max {pct(config.foldTargetMax)}</span><input type="range" min="0.6" max="0.92" step="0.01" value={config.foldTargetMax} oninput={(e) => conductorSettings.patch({ foldTargetMax: +e.currentTarget.value })} /></label>
				<label class="fld sm"><span>Initial</span><input class="mono" type="number" min="0.6" max="0.92" step="0.01" value={config.foldTargetInitial} oninput={(e) => conductorSettings.patch({ foldTargetInitial: +e.currentTarget.value })} /></label>
			</div>
			<label class="fld"><span>Summary model</span><input class="mono" type="text" placeholder="default" value={config.summaryModel} oninput={(e) => conductorSettings.patch({ summaryModel: e.currentTarget.value })} /></label>
			{#if summary.backend === "ollama"}
				<label class="fld"><span>Ollama URL</span><input class="mono" type="text" value={config.ollamaBaseUrl} oninput={(e) => conductorSettings.patch({ ollamaBaseUrl: e.currentTarget.value })} /></label>
			{/if}
			<label class="fld"><span>Embedding model</span><input class="mono" type="text" value={config.embeddingModel} oninput={(e) => conductorSettings.patch({ embeddingModel: e.currentTarget.value })} /></label>
			<div class="toggles">
				<label class="tog"><input type="checkbox" checked={config.summariesEnabled} onchange={(e) => conductorSettings.patch({ summariesEnabled: e.currentTarget.checked })} /> Summaries</label>
				<label class="tog"><input type="checkbox" checked={config.embeddingsEnabled} onchange={(e) => conductorSettings.patch({ embeddingsEnabled: e.currentTarget.checked })} /> Embeddings</label>
			</div>
			<p class="hint">Changes apply on the next Conductor run.</p>
			<button class="reset" onclick={() => conductorSettings.reset()}>Reset to defaults</button>
		</div>
	{/if}
</div>

<style>
	.wrap { position: relative; }
	.gear { background: var(--panel-3); border: 1px solid var(--line); color: var(--muted); padding: 4px 8px; border-radius: var(--radius-sm); font-size: 13px; line-height: 1; }
	.gear:hover { color: var(--text); background: var(--line); }
	.panel {
		position: absolute; right: 0; top: calc(100% + 6px); z-index: 20;
		width: min(320px, 92vw); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
		background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
	}
	.ro { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--faint); }
	.ro .mono { color: var(--muted); font-size: 10px; text-align: right; }
	.status-connected { color: var(--ok); }
	.status-error { color: var(--danger); }
	.fld { display: flex; flex-direction: column; gap: 3px; font-size: 10px; color: var(--faint); }
	.fld.sm { margin-top: 2px; }
	.fld input { background: var(--bg); border: 1px solid var(--line); color: var(--text); padding: 4px 6px; border-radius: var(--radius-sm); font-size: 11px; }
	.band { display: flex; flex-direction: column; gap: 4px; font-size: 10px; color: var(--faint); }
	.band b { color: var(--accent); font-weight: 600; }
	.rng { display: flex; flex-direction: column; gap: 2px; }
	.rng input { width: 100%; accent-color: var(--accent); margin: 0; }
	.toggles { display: flex; gap: 12px; font-size: 11px; color: var(--muted); }
	.tog { display: flex; align-items: center; gap: 5px; cursor: pointer; }
	.hint { margin: 0; font-size: 10px; color: var(--faint); font-style: italic; }
	.reset { align-self: flex-start; background: var(--panel-3); border: 1px solid var(--line); color: var(--text); padding: 4px 10px; border-radius: var(--radius-sm); font-size: 11px; }
	.reset:hover { background: var(--line); }
	.mono { font-family: var(--mono); }
</style>
