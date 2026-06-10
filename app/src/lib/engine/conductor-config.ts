/** Runtime Conductor settings — mirrors root `src/conductor.ts` defaults for the UI. */

export interface ConductorConfig {
	budgetTokens: number;
	workingTailTokens: number;
	foldTargetMin: number;
	foldTargetMax: number;
	foldTargetInitial: number;
	summaryModel: string;
	ollamaBaseUrl: string;
	ollamaModel: string;
	embeddingModel: string;
	summariesEnabled: boolean;
	embeddingsEnabled: boolean;
	summaryTimeoutMs: number;
}

export type ProviderStatus = "connected" | "disconnected" | "error";
export type SummaryBackend = "haiku" | "ollama" | "gemini" | "disabled";

const CONDUCTOR_STATE_TYPE = "accordion-conductor-state";

export function conductorConfigFromPersisted(partial?: Partial<ConductorConfig> | null): ConductorConfig {
	const d = defaultConductorConfig();
	if (!partial || typeof partial !== "object") return { ...d };
	return { ...d, ...partial };
}

export function conductorSnapshotFromEntry(data: Record<string, unknown> | null | undefined): import("./types").ConductorSnapshot | undefined {
	if (!data || typeof data !== "object") return undefined;
	const fold = data.foldTargetCalibrated;
	const foldTargetCalibrated = typeof fold === "number" && Number.isFinite(fold) ? fold : defaultConductorConfig().foldTargetInitial;
	const config = conductorConfigFromPersisted(data.config as Partial<ConductorConfig> | undefined);
	return { config, foldTargetCalibrated };
}

export function isConductorStateEntry(e: { type?: string; customType?: string }): boolean {
	return e.type === "custom" && e.customType === CONDUCTOR_STATE_TYPE;
}

export function defaultConductorConfig(): ConductorConfig {
	return {
		budgetTokens: 150_000,
		workingTailTokens: 20_000,
		foldTargetMin: 0.6,
		foldTargetMax: 0.92,
		foldTargetInitial: 0.8,
		summaryModel: "claude-haiku-4-5",
		ollamaBaseUrl: "http://localhost:11434/v1",
		ollamaModel: "llama3.2:3b",
		embeddingModel: "Xenova/all-MiniLM-L6-v2",
		summariesEnabled: true,
		embeddingsEnabled: false,
		summaryTimeoutMs: 30_000,
	};
}

export function summaryBackend(config: ConductorConfig): { backend: SummaryBackend; model: string } {
	if (!config.summariesEnabled) return { backend: "disabled", model: "" };
	const m = config.summaryModel.trim();
	// UI inference only — real selection happens in the pi extension.
	if (m.includes("gemini")) return { backend: "gemini", model: m };
	if (m.includes("claude") || m.includes("haiku")) return { backend: "haiku", model: m };
	if (!m || m === config.ollamaModel) return { backend: "ollama", model: config.ollamaModel };
	return { backend: "haiku", model: m };
}
