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

/**
 * Move a slice boundary away from a surrogate pair by one code unit if needed.
 * JS strings are UTF-16; a high surrogate at `text[i-1]` means the boundary
 * falls inside a surrogate pair — step back one position to keep the pair intact.
 */
function safeBoundary(text: string, index: number): number {
	if (index <= 0 || index >= text.length) return index;
	const code = text.charCodeAt(index - 1);
	// High surrogate: U+D800–U+DBFF followed by a low surrogate U+DC00–U+DFFF.
	if (code >= 0xd800 && code <= 0xdbff) return index - 1;
	return index;
}

/** Trim blockText to ≤24 k chars (head 16 k + tail 8 k) with a visible marker. */
function truncateInput(text: string): string {
	if (text.length <= TOTAL_CHARS) return text;
	const headEnd = safeBoundary(text, HEAD_CHARS);
	const tailStart = safeBoundary(text, text.length - TAIL_CHARS);
	return text.slice(0, headEnd) + TRUNCATION_MARKER + text.slice(tailStart);
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

// ── Tick prompt (C3 Attentive Tick) ──────────────────────────────────────────

export const TICK_PROMPT_VERSION = 1;

export interface TickPromptInput {
	indexLines: string[];
	tailText: string;
	liveTokens: number;
	budget: number;
	truncatedCount: number;
}

export interface TickPromptResult {
	system: string;
	user: string;
	maxOutputTokens: number;
	jsonSchema: unknown;
}

const TICK_SYSTEM = `\
You are a LIBRARIAN curating an AI coding agent's working context window for the Accordion tool.
Your only job is to SELECT entry numbers from the index you are shown — you never write content.

FOLD = archive entries that are no longer relevant to the agent's current work. Each archived block
shrinks to a one-line stub the agent can reopen by calling the unfold tool.

UNFOLD = restore entries that are about to become relevant again: they are mentioned (exact or
conceptual), implied, or clearly needed by the work visible in the RECENT ACTIVITY section.

Strong bias to do NOTHING when unsure. Empty arrays are a good answer. The agent's budget and
safety are enforced by a deterministic layer that runs after you — your job is relevance, not
accounting. You may select at most 8 entries per side.

Output JSON only. No prose outside the JSON object.
Reasons must be ≤12 words, concrete (e.g. "config setup no longer referenced by current task").`;

/**
 * Build a tick prompt for the LLM conductor.
 *
 * The index line format is defined HERE (one home for the format):
 *   #<n> [<code>] <kind> t<turn> <tokens>tok <FOLDED|live> :: <snippet>
 *
 * This matches the format produced by tick.ts buildIndex + the indexLines array.
 */
export function tickPrompt(input: TickPromptInput): TickPromptResult {
	const headroom = input.budget - input.liveTokens;
	const budgetLine =
		headroom >= 0
			? `BUDGET: ${input.liveTokens.toLocaleString()} / ${input.budget.toLocaleString()} tokens live (${headroom.toLocaleString()} headroom)`
			: `BUDGET: ${input.liveTokens.toLocaleString()} / ${input.budget.toLocaleString()} tokens — OVER by ${(-headroom).toLocaleString()} tokens`;

	const truncNote =
		input.truncatedCount > 0
			? `\n(Note: ${input.truncatedCount} older entries omitted — only the newest ${input.indexLines.length} are shown.)`
			: "";

	const indexSection = `INDEX (oldest first):${truncNote}\n${input.indexLines.join("\n")}`;

	const tailSection = `RECENT ACTIVITY (the agent's current work):\n${input.tailText.trimEnd() || "(no recent activity)"}`;

	const user = `${budgetLine}\n\n${indexSection}\n\n${tailSection}`;

	// Gemini responseSchema (OBJECT format)
	const jsonSchema = {
		type: "OBJECT",
		properties: {
			fold: {
				type: "ARRAY",
				items: {
					type: "OBJECT",
					properties: {
						n: { type: "INTEGER" },
						reason: { type: "STRING" },
					},
					required: ["n", "reason"],
				},
			},
			unfold: {
				type: "ARRAY",
				items: {
					type: "OBJECT",
					properties: {
						n: { type: "INTEGER" },
						reason: { type: "STRING" },
					},
					required: ["n", "reason"],
				},
			},
		},
		required: ["fold", "unfold"],
	};

	return {
		system: TICK_SYSTEM,
		user,
		maxOutputTokens: 800,
		jsonSchema,
	};
}
