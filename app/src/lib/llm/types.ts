/*
 * types.ts — shared vocabulary for the LLM gateway layer.
 *
 * Node-safe: no Svelte imports, no browser-only APIs. Imported by both the
 * webview gateway (gateway.ts) and the Node script twin (scripts/lib/llm-node.mjs).
 */

// ── Request / response ────────────────────────────────────────────────────────

/**
 * A single generation request. `role` identifies the call site so the right
 * model tier is picked; `jsonSchema` opts into JSON-mode (responseMimeType +
 * responseSchema forwarded to the provider).
 */
export interface LlmRequest {
	role: "summary" | "tick";
	system?: string;
	user: string;
	jsonSchema?: unknown;
	maxOutputTokens?: number;
}

export interface LlmResponse {
	text: string;
	inTokens: number;
	outTokens: number;
	model: string;
	provider: "aistudio" | "vertex";
}

// ── Error discriminant ────────────────────────────────────────────────────────

export type LlmErrorKind =
	/** No LLM backend available in this environment (e.g. no Tauri, no key). */
	| "unavailable"
	/** Quota / rate-limit exhausted (429). */
	| "quota"
	/** Non-quota HTTP error from the provider. */
	| "http"
	/** Response received but could not be parsed. */
	| "parse";

export class LlmError extends Error {
	readonly kind: LlmErrorKind;
	readonly statusCode?: number;

	constructor(kind: LlmErrorKind, message: string, statusCode?: number) {
		super(message);
		this.name = "LlmError";
		this.kind = kind;
		this.statusCode = statusCode;
	}
}

// ── Provider / model registry ─────────────────────────────────────────────────

/**
 * Which model to use per provider × role.
 *
 * Vertex only has gemini-2.5-flash-lite available; other models 404/417.
 * AI Studio uses the -latest aliases so we track the best available model
 * without pinning a specific checkpoint version.
 */
export const PROVIDER_MODELS = {
	aistudio: {
		summary: "gemini-flash-lite-latest",
		tick: "gemini-flash-latest",
	},
	vertex: {
		summary: "gemini-2.5-flash-lite",
		tick: "gemini-2.5-flash-lite",
	},
} as const;

export const VERTEX_PROJECT = "runner-frontier-74255";
export const VERTEX_LOCATION = "us-central1";
