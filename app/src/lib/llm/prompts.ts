/*
 * prompts.ts — LLM prompt construction for accordion summaries.
 *
 * Node-safe: no Svelte imports, no browser-only APIs.
 */

export const PROMPT_VERSION = 1;

/** Characters to preserve in the head/tail window (24 k chars total: 16 k head + 8 k tail). */
const HEAD_CHARS = 16_000;
const TAIL_CHARS = 8_000;
const TOTAL_CHARS = HEAD_CHARS + TAIL_CHARS;

const TRUNCATION_MARKER =
	"\n\n[... content truncated for summarization; head and tail preserved ...]\n\n";

/** Trim blockText to ≤24 k chars (head 16 k + tail 8 k) with a visible marker. */
function truncateInput(text: string): string {
	if (text.length <= TOTAL_CHARS) return text;
	return text.slice(0, HEAD_CHARS) + TRUNCATION_MARKER + text.slice(-TAIL_CHARS);
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SHARED_RULES = `\
You are a compression engine for an AI coding session visualizer called Accordion.
Your output is shown IN-APP as a one-line summary replacing a long context block.

HARD RULES — violating any of these is a critical failure:
1. Output PLAIN TEXT only. No markdown, no bullet points, no headers, no preamble, no trailing period unless it flows naturally.
2. Do NOT start with "The", "This", "Here", or the word "Summary". Lead with the substance.
3. Target length: ≤120 tokens (roughly ≤80 words). Shorter is better.
4. VERBATIM PRESERVATION — you MUST copy the following EXACTLY as they appear in the source, character-for-character:
   - File paths (e.g. src/lib/engine/store.svelte.ts, /home/user/.config/app.json)
   - Identifiers and symbols (function names, variable names, type names, enum values)
   - Quoted strings (any text inside " " or ' ')
   - Error messages and error codes
   - Shell commands and flags
   A lexical matcher and the agent will grep the summary for these — any paraphrase breaks search.
5. Output a single paragraph. No list formatting.`;

function systemForKind(kind: "text" | "thinking" | "tool_result", toolName?: string): string {
	let kindGuidance: string;

	switch (kind) {
		case "tool_result":
			kindGuidance = `\
This block is a TOOL RESULT${toolName ? ` from the "${toolName}" tool` : ""}.
Summarize: what was asked (the call context), what came back (the outcome).
Keep key values, file paths, error strings, and numeric results VERBATIM.
If the result is an error, include the exact error message.`;
			break;

		case "thinking":
			kindGuidance = `\
This block is AGENT THINKING (internal reasoning).
Summarize: the decisions reached and why — the conclusion of the reasoning, not the exploration.
Surface any key hypotheses accepted or rejected, and any action decided upon.`;
			break;

		case "text":
			kindGuidance = `\
This block is an ASSISTANT REPLY.
Summarize: the claims made, commitments given, and answers provided.
If code is referenced or written, name the file(s) and function(s) involved.`;
			break;
	}

	return `${SHARED_RULES}\n\n${kindGuidance}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface PromptResult {
	system: string;
	user: string;
	maxOutputTokens: number;
}

/**
 * Build a summarization prompt for a single block.
 *
 * @param kind - block kind being summarized
 * @param blockText - the block's full text (will be truncated if > 24k chars)
 * @param toolName - optional tool name for tool_result blocks
 */
export function summaryPrompt(
	kind: "text" | "thinking" | "tool_result",
	blockText: string,
	toolName?: string
): PromptResult {
	const truncated = truncateInput(blockText);
	return {
		system: systemForKind(kind, toolName),
		user: truncated,
		maxOutputTokens: 150, // generous ceiling; system instructs ≤120 tok
	};
}

/**
 * Tick prompt stub — milestone C3 fills this.
 * @throws always
 */
export function tickPrompt(..._args: unknown[]): never {
	throw new Error("C3");
}
