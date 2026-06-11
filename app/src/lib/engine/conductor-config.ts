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
	const missingApiKeyLogged = data.missingApiKeyLogged === true;
	const providerError = typeof data.providerError === "string" && data.providerError ? data.providerError : undefined;
	const foldedBlockIds = Array.isArray(data.foldedBlockIds) ? (data.foldedBlockIds as string[]) : undefined;
	const foldLevels =
		data.foldLevels && typeof data.foldLevels === "object" && !Array.isArray(data.foldLevels)
			? (data.foldLevels as Record<string, 0 | 1 | 2 | 3>)
			: undefined;
	const foldedSummaries =
		data.foldedSummaries && typeof data.foldedSummaries === "object" && !Array.isArray(data.foldedSummaries)
			? (data.foldedSummaries as Record<string, string>)
			: undefined;
	const calibrationEvents = Array.isArray(data.calibrationEvents)
		? (data.calibrationEvents as Array<{ turn: number; from: number; to: number; reason: string }>)
		: undefined;
	return { config, foldTargetCalibrated, missingApiKeyLogged, providerError, foldedBlockIds, foldLevels, foldedSummaries, calibrationEvents };
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
		summaryModel: "",
		ollamaBaseUrl: "http://localhost:11434",
		ollamaModel: "llama3.2:3b",
		embeddingModel: "Xenova/all-MiniLM-L6-v2",
		summariesEnabled: true,
		embeddingsEnabled: true,
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
