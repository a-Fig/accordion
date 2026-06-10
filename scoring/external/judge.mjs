/*
 * judge.mjs — "judge" scorer for the Relevance Lab.
 *
 * Scorer id: "judge"  version: "1"
 * Model: gemini-2.5-flash-lite (Vertex AI generateContent)
 * Score: 0–10 LLM rating of block usefulness given the tail context.
 *
 * Hook contract (run.mjs):
 *   default export async ({ session, ticks, contexts, paths }) => void
 *   Mutates ticks[i].scores.judge and ticks[i].scorers.judge in place.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  vertexFetch,
  recordSpend,
  assertBudget,
  sha256,
} from "./vertex.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SCORER_ID = "judge";
const VERSION = "1";
const MODEL = "gemini-2.5-flash-lite";
const PROMPT_VERSION = "1";
const BATCH_SIZE = 12;
const MAX_CONCURRENCY = 4;

const TAIL_MAX_CHARS = 5000;
const BLOCK_HEAD_CHARS = 500;
const BLOCK_TAIL_CHARS = 200;

// Cache dir
const CACHE_DIR = path.join(os.homedir(), ".accordion", "relevance", "cache", "judge");

// ---------------------------------------------------------------------------
// Pinned prompt (promptVersion "1")
// ---------------------------------------------------------------------------
function buildPrompt(tailExcerpt, blockItems) {
  return (
    `You are a context librarian for a coding agent.\n\n` +
    `CURRENT WORK (agent's recent context tail):\n` +
    `---\n${tailExcerpt}\n---\n\n` +
    `For each numbered earlier block below, rate 0–10 how useful its FULL content ` +
    `would be to the agent's IMMEDIATE next steps.\n` +
    `0 = dead weight, 10 = the agent will need this verbatim.\n\n` +
    `Blocks:\n` +
    blockItems.map((b) => `[${b.i}] (${b.kind}, turn ${b.turn}) ${b.text}`).join("\n") +
    `\n\nOutput STRICT JSON only — an array where each element has "i" (integer) and "s" (integer 0-10).`
  );
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------
function judgeCachePath(tailHash, blockTextHash) {
  const key = sha256(`${PROMPT_VERSION}||${MODEL}||${tailHash}||${blockTextHash}`);
  return path.join(CACHE_DIR, `${key}.json`);
}

function cacheRead(tailHash, blockTextHash) {
  const p = judgeCachePath(tailHash, blockTextHash);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch { /* cache miss */ }
  }
  return null;
}

function cacheWrite(tailHash, blockTextHash, scores) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const p = judgeCachePath(tailHash, blockTextHash);
  fs.writeFileSync(p, JSON.stringify(scores), "utf8");
}

// ---------------------------------------------------------------------------
// Text truncation
// ---------------------------------------------------------------------------
function truncateTail(text) {
  if (text.length <= TAIL_MAX_CHARS) return text;
  return text.slice(text.length - TAIL_MAX_CHARS);
}

function renderBlockText(text) {
  const total = BLOCK_HEAD_CHARS + BLOCK_TAIL_CHARS;
  if (!text || text.length <= total) return text ?? "";
  return text.slice(0, BLOCK_HEAD_CHARS) + " … " + text.slice(text.length - BLOCK_TAIL_CHARS);
}

// ---------------------------------------------------------------------------
// Token estimation for budget projection
// ---------------------------------------------------------------------------
function estTokens(text) {
  return Math.ceil((text?.length ?? 0) / 4);
}

// ---------------------------------------------------------------------------
// Run a single batch of blocks through generateContent
// ---------------------------------------------------------------------------
async function runBatch(tailExcerpt, tailHash, blockBatch, blocks) {
  // blockBatch: array of { localI, blockI, block }
  // First check cache for the whole batch
  const batchKey = blockBatch.map((b) => b.block.text ?? "").join("|||");
  const blockTextHash = sha256(batchKey);
  const cached = cacheRead(tailHash, blockTextHash);
  if (cached) {
    return { scores: cached, fromCache: true, costUsd: 0 };
  }

  const blockItems = blockBatch.map((b, j) => ({
    i: j,
    kind: b.block.kind,
    turn: b.block.turn,
    text: renderBlockText(b.block.text ?? ""),
  }));

  const prompt = buildPrompt(tailExcerpt, blockItems);
  const promptTokens = estTokens(prompt);
  const projectedUsd = (promptTokens / 1e6) * 0.10 + (200 / 1e6) * 0.40;
  assertBudget(projectedUsd);

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            i: { type: "INTEGER" },
            s: { type: "INTEGER" },
          },
          required: ["i", "s"],
        },
      },
    },
  };

  let resp;
  try {
    resp = await vertexFetch(MODEL, "generateContent", body);
  } catch (err) {
    console.error(`    [judge] batch error: ${err.message}`);
    return { scores: null, fromCache: false, costUsd: 0 };
  }

  const json = await resp.json();
  const usage = json.usageMetadata ?? {};
  const inTokens = usage.promptTokenCount ?? promptTokens;
  const outTokens = usage.candidatesTokenCount ?? 50;
  const costUsd = recordSpend({ model: MODEL, inTokens, outTokens });

  const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.error(`    [judge] JSON parse failure, will retry once`);
    // One retry
    try {
      const resp2 = await vertexFetch(MODEL, "generateContent", body);
      const json2 = await resp2.json();
      const usage2 = json2.usageMetadata ?? {};
      recordSpend({
        model: MODEL,
        inTokens: usage2.promptTokenCount ?? promptTokens,
        outTokens: usage2.candidatesTokenCount ?? 50,
      });
      const rawText2 = json2.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
      parsed = JSON.parse(rawText2);
    } catch {
      console.error(`    [judge] retry also failed — nulling batch`);
      return { scores: null, fromCache: false, costUsd };
    }
  }

  // Validate: parse scores, accept partial responses (missing i → null for that block)
  if (!Array.isArray(parsed)) {
    console.error(`    [judge] response not array — nulling batch`);
    return { scores: null, fromCache: false, costUsd };
  }

  const scoresMap = new Map();
  for (const item of parsed) {
    if (typeof item.i !== "number" || typeof item.s !== "number") continue;
    const s = Math.round(item.s);
    if (s < 0 || s > 10) continue;
    scoresMap.set(item.i, s);
  }

  // Accept partial responses — only null the whole batch if <50% returned
  const hitCount = blockItems.filter((b) => scoresMap.has(b.i)).length;
  if (hitCount < Math.ceil(blockItems.length * 0.5)) {
    console.error(
      `    [judge] too few indices returned (${hitCount}/${blockItems.length}) — nulling batch`,
    );
    return { scores: null, fromCache: false, costUsd };
  }

  const scoresArr = blockItems.map((b) => scoresMap.get(b.i) ?? null);
  cacheWrite(tailHash, blockTextHash, scoresArr);
  return { scores: scoresArr, fromCache: false, costUsd };
}

// ---------------------------------------------------------------------------
// Promise pool — up to MAX_CONCURRENCY in flight
// ---------------------------------------------------------------------------
async function promisePool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Score a single tick
// ---------------------------------------------------------------------------
async function scoreTick(tickScores, ctx) {
  const t0 = performance.now();

  const scoredBlocks = ctx.blocks.slice(0, ctx.atBlock);
  const tailExcerpt = truncateTail(ctx.tailText);
  const tailHash = sha256(tailExcerpt);

  // Split into batches
  const batches = [];
  for (let start = 0; start < scoredBlocks.length; start += BATCH_SIZE) {
    const slice = scoredBlocks.slice(start, start + BATCH_SIZE).map((block, j) => ({
      localI: j,
      blockI: start + j,
      block,
    }));
    batches.push({ start, slice });
  }

  // Build tasks for the promise pool
  const tasks = batches.map((b) => () => runBatch(tailExcerpt, tailHash, b.slice, ctx.blocks));

  const batchResults = await promisePool(tasks, MAX_CONCURRENCY);

  // Assemble final scores array (null for empty/whitespace blocks handled by null batch)
  const finalScores = new Array(scoredBlocks.length).fill(null);
  let totalCostUsd = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const { start, slice } = batches[bi];
    const result = batchResults[bi];
    totalCostUsd += result.costUsd ?? 0;
    if (result.fromCache) cacheHits++;
    else cacheMisses++;

    if (!result.scores) {
      // Null batch — leave nulls
      continue;
    }
    for (let j = 0; j < slice.length; j++) {
      finalScores[start + j] = result.scores[j] ?? null;
    }
  }

  const wallMs = Math.round(performance.now() - t0);
  const nonNull = finalScores.filter((s) => s !== null).length;

  tickScores.scores[SCORER_ID] = finalScores;
  tickScores.scorers[SCORER_ID] = {
    version: VERSION,
    wallMs,
    costUsd: totalCostUsd,
    params: { model: MODEL, promptVersion: PROMPT_VERSION, batchSize: BATCH_SIZE },
  };

  console.log(
    `    [judge] v${VERSION}  ${wallMs}ms  ${nonNull}/${finalScores.length} scored` +
    `  batches=${batches.length} cacheHits=${cacheHits} cacheMisses=${cacheMisses}` +
    `  cost=$${totalCostUsd.toFixed(4)}`,
  );
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------
export default async function judgeHook({ ticks, contexts }) {
  for (let i = 0; i < ticks.length; i++) {
    await scoreTick(ticks[i], contexts[i]);
  }
}
