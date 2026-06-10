/**
 * llm-smoke.mjs — real-network smoke test for the LLM gateway layer.
 *
 * Run: node scripts/llm-smoke.mjs (from the app/ directory)
 *
 * Makes ONE summary call through llm-node.mjs and prints:
 *   - Provider used (expect "vertex")
 *   - Token usage
 *   - The generated summary
 */

import { llmGenerate, usage } from "./lib/llm-node.mjs";

// Fixed sample block text drawn from the bundled session.
const SAMPLE_TEXT = `\
I'll read the configuration file and check the current state of the store.
Looking at the file, I can see the AccordionStore is initialized with a budget of 80000 tokens.
The protected tail is set to 20000 tokens via protectTokens. The refold() method builds
fold candidates from blocks with index < protectedFromIndex. I'll now update the threshold
in app/src/lib/engine/store.svelte.ts to use 25000 instead of 20000 as requested.`;

const req = {
  role: "summary",
  system: undefined,
  user: SAMPLE_TEXT,
  maxOutputTokens: 150,
};

// Add a summary-appropriate system prompt.
req.system = [
  "You are a compression engine for an AI coding session visualizer called Accordion.",
  "Output PLAIN TEXT only. No markdown. Target ≤80 words.",
  "VERBATIM PRESERVATION: copy file paths, identifiers, and quoted strings exactly.",
  "This block is an ASSISTANT REPLY. Summarize: claims made, commitments given, answers provided.",
].join("\n");

console.log("Running LLM smoke test...\n");

const result = await llmGenerate(req);

console.log(`Provider : ${result.provider}`);
console.log(`Model    : ${result.model}`);
console.log(`Tokens   : ${result.inTokens} in / ${result.outTokens} out`);
console.log(`\nSummary:\n${result.text}`);
console.log(`\nTotal usage: ${usage.calls} call(s), ${usage.inTokens} in, ${usage.outTokens} out`);
