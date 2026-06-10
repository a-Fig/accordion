/**
 * tick-smoke.mjs — smoke test for the attentive tick prompt (C3).
 *
 * Constructs a realistic small tick prompt inline (same line format as tick.ts),
 * calls llmGenerate with the jsonSchema via role "tick", asserts the response
 * parses as valid JSON matching {fold:[],unfold:[]}, prints decision + usage.
 *
 * Run: node scripts/tick-smoke.mjs (from the app/ directory)
 *
 * Expects vertex gemini-2.5-flash-lite (1-2 calls only).
 */

import { llmGenerate, usage } from "./lib/llm-node.mjs";

// ── Inline tick prompt (mirrors tick.ts / prompts.ts) ─────────────────────────

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

// Realistic index for a small session (same format as tick.ts buildIndex)
const indexLines = [
  "#1 [3f9a2c] tool_result t1 2800tok FOLDED :: read_file → 47 lines, ~2800 tok · import { AccordionStore } from",
  "#2 [7b1e4d] thinking t2 1200tok FOLDED :: thought · ~1200 tok · I need to refactor the engine to support",
  "#3 [2c8f1a] text t2 900tok FOLDED :: Looked at store.svelte.ts and identified the protectTokens mechanism.",
  "#4 [5d3c7e] tool_result t3 3400tok FOLDED :: read_file → 89 lines, ~3400 tok · export class AccordionStore",
  "#5 [1a9b4f] thinking t4 800tok live :: thought · ~800 tok · Now I need to check the digest.ts foldCode function",
  "#6 [8e2d5c] tool_result t4 600tok live :: read_file → 12 lines, ~600 tok · export function foldCode(id: string)",
];

const tailText = `\
I'll now implement the tick.ts module for milestone C3. The key function is buildIndex which
scans store.blocks up to protectedFromIndex, skipping user and tool_call kinds. Each entry
needs: n (1-based), id, code (from foldCode), kind, turn, tokens, folded, and a 160-char snippet.
The snippet for folded blocks strips the leading {#code FOLDED} tag from digestOf().

Let me also check the foldCode function signature to make sure I'm calling it correctly.
I'll read app/src/lib/engine/digest.ts to verify the export.`;

const budgetLine = "BUDGET: 9700 / 70000 tokens live (60300 headroom)";
const indexSection = `INDEX (oldest first):\n${indexLines.join("\n")}`;
const tailSection = `RECENT ACTIVITY (the agent's current work):\n${tailText}`;
const userPrompt = `${budgetLine}\n\n${indexSection}\n\n${tailSection}`;

// jsonSchema — Gemini OBJECT format (same as prompts.ts tickPrompt)
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

// ── Run ───────────────────────────────────────────────────────────────────────

console.log("Running tick-smoke test...\n");

let result;
try {
  result = await llmGenerate({
    role: "tick",
    system: TICK_SYSTEM,
    user: userPrompt,
    maxOutputTokens: 800,
    jsonSchema,
  });
} catch (err) {
  // If the provider rejected responseSchema, retry without it (instructed JSON-only)
  console.warn(`[tick-smoke] First call failed (${err.message}), retrying without responseSchema...`);
  result = await llmGenerate({
    role: "tick",
    system: TICK_SYSTEM + "\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown, no code fences.",
    user: userPrompt,
    maxOutputTokens: 800,
  });
}

console.log(`Provider : ${result.provider}`);
console.log(`Model    : ${result.model}`);
console.log(`Tokens   : ${result.inTokens} in / ${result.outTokens} out`);
console.log(`\nRaw response:\n${result.text}`);

// ── Parse and validate ────────────────────────────────────────────────────────

function parseDecision(text) {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (!Array.isArray(parsed.fold) || !Array.isArray(parsed.unfold)) return null;
  return parsed;
}

const decision = parseDecision(result.text);

if (!decision) {
  console.error("\nASSERTION FAILED: response is not valid {fold:[],unfold:[]} JSON");
  process.exit(1);
}

// Validate each op has {n: integer, reason: string}
for (const op of [...decision.fold, ...decision.unfold]) {
  if (typeof op.n !== "number" || !isFinite(op.n)) {
    console.error(`\nASSERTION FAILED: op.n is not a number: ${JSON.stringify(op)}`);
    process.exit(1);
  }
  if (typeof op.reason !== "string") {
    console.error(`\nASSERTION FAILED: op.reason is not a string: ${JSON.stringify(op)}`);
    process.exit(1);
  }
}

console.log(`\nParsed decision:`);
console.log(`  fold   (${decision.fold.length}): ${JSON.stringify(decision.fold)}`);
console.log(`  unfold (${decision.unfold.length}): ${JSON.stringify(decision.unfold)}`);
console.log(`\nTotal usage: ${usage.calls} call(s), ${usage.inTokens} in, ${usage.outTokens} out`);
console.log("\ntick-smoke PASSED");
