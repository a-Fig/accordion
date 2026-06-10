/*
 * conductor-settings.svelte.ts — shared Conductor config for Map + Classic views.
 *
 * Offline: localStorage holds user edits. Live: applySession() overlays config
 * and fold target from the SSE snapshot (authoritative from pi).
 */
import {
	conductorConfigFromPersisted,
	defaultConductorConfig,
	type ConductorConfig,
	type ProviderStatus,
} from "./conductor-config";
import type { AccordionStore } from "./store.svelte";
import type { ConductorSnapshot } from "./types";

const LS_KEY = "accordion.conductorConfig";

class ConductorSettingsState {
	config = $state<ConductorConfig>(defaultConductorConfig());
	open = $state(false);
	liveConnected = $state(false);
	private syncing = false;

	constructor() {
		if (typeof window === "undefined") return;
		try {
			const raw = window.localStorage.getItem(LS_KEY);
			if (raw) this.config = conductorConfigFromPersisted(JSON.parse(raw));
		} catch {
			/* ignore corrupt localStorage */
		}
	}

	get providerStatus(): ProviderStatus {
		return this.liveConnected ? "connected" : "disconnected";
	}

	patch(p: Partial<ConductorConfig>): void {
		this.config = { ...this.config, ...p };
		this.persist();
		this.pushToExtension();
	}

	reset(): void {
		this.config = defaultConductorConfig();
		this.persist();
		this.pushToExtension();
	}

	persist(): void {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(LS_KEY, JSON.stringify(this.config));
		} catch {
			/* quota / private mode */
		}
	}

	setLiveConnected(v: boolean): void {
		this.liveConnected = v;
	}

	/** Overlay read-only fields from a live/session conductor snapshot. */
	applySession(conductor?: ConductorSnapshot): void {
		if (!conductor) return;
		this.config = conductorConfigFromPersisted(conductor.config);
		this.persist();
	}

	pushToExtension(): void {
		// TODO: wire to pi extension via Tauri invoke → /conductor-config
	}

	syncToStore(store: AccordionStore): void {
		if (this.syncing) return;
		this.syncing = true;
		if (store.budget !== this.config.budgetTokens) store.setBudget(this.config.budgetTokens);
		if (store.protectTokens !== this.config.workingTailTokens) store.setProtect(this.config.workingTailTokens);
		this.syncing = false;
	}

	syncFromStore(store: AccordionStore): void {
		if (this.syncing) return;
		const budget = store.budget;
		const tail = store.protectTokens;
		if (this.config.budgetTokens === budget && this.config.workingTailTokens === tail) return;
		this.syncing = true;
		this.config = { ...this.config, budgetTokens: budget, workingTailTokens: tail };
		this.persist();
		this.syncing = false;
	}

	/** Bidirectional sync — call from a route $effect (not at module scope). */
	syncWithStore(store: AccordionStore | null): void {
		if (!store) return;
		this.syncToStore(store);
		this.syncFromStore(store);
	}
}

export const conductorSettings = new ConductorSettingsState();
