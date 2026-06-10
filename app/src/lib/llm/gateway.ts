/*
 * gateway.ts — webview-side LLM access.
 *
 * Thin shim: detects the Tauri environment and delegates to the Rust
 * `llm_generate` command. In plain browser dev (no Tauri) it throws an
 * LlmError("unavailable") — all LLM work requires the desktop runtime.
 */
import { LlmError } from "./types";
import type { LlmRequest, LlmResponse } from "./types";

// Same detection pattern used throughout the codebase (see session.svelte.ts).
export const isTauriEnv =
	typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True when LLM calls can be made from this environment. */
export function llmAvailable(): boolean {
	return isTauriEnv;
}

/**
 * Generate text via the LLM backend. Requires the Tauri desktop runtime; throws
 * LlmError("unavailable") in plain browser dev.
 *
 * Re-throws LlmError for known error kinds (quota, http, parse) so callers can
 * handle them without depending on Rust's string format.
 */
export async function llmGenerate(req: LlmRequest): Promise<LlmResponse> {
	if (!isTauriEnv) {
		throw new LlmError("unavailable", "LLM generation requires the Tauri desktop runtime");
	}

	const { invoke } = await import("@tauri-apps/api/core");

	try {
		const result = await invoke<LlmResponse>("llm_generate", { req });
		return result;
	} catch (e: unknown) {
		// Rust returns errors as strings via Tauri's Result<_, String> convention.
		const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

		// Surface structured error kinds based on the Rust error messages.
		if (msg.includes("unavailable") || msg.includes("no provider")) {
			throw new LlmError("unavailable", msg);
		}
		if (msg.includes("quota") || msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("prepay")) {
			throw new LlmError("quota", msg, 429);
		}
		if (msg.includes("parse") || msg.includes("unexpected response")) {
			throw new LlmError("parse", msg);
		}
		// Generic HTTP error — try to extract a status code.
		const statusMatch = msg.match(/\b([45]\d{2})\b/);
		throw new LlmError("http", msg, statusMatch ? parseInt(statusMatch[1], 10) : undefined);
	}
}
