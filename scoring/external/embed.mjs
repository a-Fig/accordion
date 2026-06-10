/*
 * embed.mjs — "embed" scorer for the Relevance Lab.
 *
 * Scorer id: "embed"  version: "1"
 * Model: text-embedding-005 (Vertex AI)
 * Score: cosine similarity between query (tail) and block vectors.
 *
 * Hook contract (run.mjs):
 *   default export async ({ session, ticks, contexts, paths }) => void
 *   Mutates ticks[i].scores.embed and ticks[i].scorers.embed in place.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
const SCORER_ID = "embed";
const VERSION = "1";
const MODEL = "text-embedding-005";
const QUERY_TASK = "RETRIEVAL_QUERY";
const DOC_TASK = "RETRIEVAL_DOCUMENT";

// text-embedding-005 caps at 2048 tokens/instance (~8192 chars at 4 chars/tok)
// Use a conservative 6000 char limit for queries, 4000+2000 for docs
const QUERY_MAX_CHARS = 6000;
const DOC_HEAD_CHARS = 4000;
const DOC_TAIL_CHARS = 2000;

// Batch limits: text-embedding-005 hard limit is 20k tokens total per request.
// chars/4 underestimates real token counts (BPE tokenization is ~1.5–2× denser
// than chars/4 for code). Cap estimated tokens at 8k so real usage stays ~12–16k.
const BATCH_MAX_INSTANCES = 50;
const BATCH_MAX_EST_TOKENS = 8_000; // chars/4 conservative cap

// Cache dir
const CACHE_DIR = path.join(os.homedir(), ".accordion", "relevance", "cache", "embed");

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------
function cachePath(taskType, text) {
  const key = sha256(`${taskType}||${MODEL}||${text}`);
  return path.join(CACHE_DIR, `${key}.json`);
}

function cacheRead(taskType, text) {
  const p = cachePath(taskType, text);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch { /* cache miss */ }
  }
  return null;
}

function cacheWrite(taskType, text, vector) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const p = cachePath(taskType, text);
  fs.writeFileSync(p, JSON.stringify(vector), "utf8");
}

// ---------------------------------------------------------------------------
// Text truncation helpers
// ---------------------------------------------------------------------------
function truncateQuery(text) {
  if (text.length <= QUERY_MAX_CHARS) return text;
  // Keep the NEWEST (tail end) chars
  return text.slice(text.length - QUERY_MAX_CHARS);
}

function truncateDoc(text) {
  const total = DOC_HEAD_CHARS + DOC_TAIL_CHARS;
  if (text.length <= total) return text;
  return text.slice(0, DOC_HEAD_CHARS) + text.slice(text.length - DOC_TAIL_CHARS);
}

// ---------------------------------------------------------------------------
// Embedding request
// ---------------------------------------------------------------------------
async function fetchEmbeddings(instances) {
  // Each instance: { content, task_type }
  // Project estimated tokens for budget check
  const estTokens = instances.reduce((s, inst) => s + Math.ceil(inst.content.length / 4), 0);
  const projectedUsd = (estTokens / 1e6) * 0.025;
  assertBudget(projectedUsd);

  const body = { instances };
  const resp = await vertexFetch(MODEL, "predict", body);
  const json = await resp.json();

  // Record spend from response statistics if available, else estimate
  let inTokens = estTokens;
  if (json.metadata?.billableCharacterCount != null) {
    inTokens = Math.ceil(json.metadata.billableCharacterCount / 4);
  } else if (json.metadata?.tokenCount != null) {
    inTokens = json.metadata.tokenCount;
  }
  // Check for per-instance token counts in the predictions
  if (Array.isArray(json.predictions)) {
    const reportedTotal = json.predictions.reduce((s, p) => {
      return s + (p.embeddings?.statistics?.token_count ?? 0);
    }, 0);
    if (reportedTotal > 0) inTokens = reportedTotal;
  }
  recordSpend({ model: MODEL, inTokens, outTokens: 0 });

  return json.predictions;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ---------------------------------------------------------------------------
// In-memory dedup map for this run (text → vector)
// ---------------------------------------------------------------------------
const _inMemoryDocVecs = new Map();

// ---------------------------------------------------------------------------
// Score a single tick
// ---------------------------------------------------------------------------
async function scoreTick(tickScores, ctx) {
  const t0 = performance.now();

  const blockTexts = ctx.blocks
    .slice(0, ctx.atBlock)
    .map((b) => b.text ?? "");

  // 1) Get query vector
  const queryText = truncateQuery(ctx.tailText);
  let queryVec = cacheRead(QUERY_TASK, queryText);
  let newQueryInst = [];
  if (!queryVec) {
    newQueryInst = [{ content: queryText, task_type: QUERY_TASK }];
  }

  // 2) Determine which doc texts need embedding (cache misses only)
  const truncatedTexts = blockTexts.map(truncateDoc);
  const docVecs = new Array(truncatedTexts.length).fill(null);
  const missIndices = []; // indices that need embedding

  for (let i = 0; i < truncatedTexts.length; i++) {
    const t = truncatedTexts[i];
    if (!t || !t.trim()) {
      // Empty/whitespace — skip
      continue;
    }
    // Check in-memory first (same text same run)
    if (_inMemoryDocVecs.has(t)) {
      docVecs[i] = _inMemoryDocVecs.get(t);
      continue;
    }
    // Check disk cache
    const cached = cacheRead(DOC_TASK, t);
    if (cached) {
      docVecs[i] = cached;
      _inMemoryDocVecs.set(t, cached);
      continue;
    }
    missIndices.push(i);
  }

  // 3) Batch the misses + optional query into requests
  // Combine query miss + doc misses into one pool
  const allInstances = []; // { content, task_type, idx, isQuery }
  if (newQueryInst.length) {
    allInstances.push({ content: queryText, task_type: QUERY_TASK, idx: -1, isQuery: true });
  }
  for (const i of missIndices) {
    allInstances.push({ content: truncatedTexts[i], task_type: DOC_TASK, idx: i, isQuery: false });
  }

  // Batch into groups respecting size limits
  const batches = [];
  let currentBatch = [];
  let currentEst = 0;

  for (const inst of allInstances) {
    const estTok = Math.ceil(inst.content.length / 4);
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= BATCH_MAX_INSTANCES || currentEst + estTok > BATCH_MAX_EST_TOKENS)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentEst = 0;
    }
    currentBatch.push(inst);
    currentEst += estTok;
  }
  if (currentBatch.length) batches.push(currentBatch);

  // Execute batches
  for (const batch of batches) {
    const predictions = await fetchEmbeddings(
      batch.map((inst) => ({ content: inst.content, task_type: inst.task_type })),
    );
    for (let j = 0; j < batch.length; j++) {
      const inst = batch[j];
      const vec = predictions[j]?.embeddings?.values ?? null;
      if (!vec) continue;
      if (inst.isQuery) {
        queryVec = vec;
        cacheWrite(QUERY_TASK, inst.content, vec);
      } else {
        docVecs[inst.idx] = vec;
        _inMemoryDocVecs.set(inst.content, vec);
        cacheWrite(DOC_TASK, inst.content, vec);
      }
    }
  }

  // 4) Compute scores
  const scores = blockTexts.map((text, i) => {
    if (!text || !text.trim()) return null;
    if (!queryVec) return null;
    return cosine(queryVec, docVecs[i]);
  });

  const wallMs = Math.round(performance.now() - t0);
  const costUsd = 0; // already recorded in recordSpend; approximate post-hoc below
  // Approximate cost for meta (sum from what we did in this tick)
  // We just report wallMs; actual spend is in the ledger

  tickScores.scores[SCORER_ID] = scores;
  tickScores.scorers[SCORER_ID] = {
    version: VERSION,
    wallMs,
    costUsd: 0, // recorded atomically in ledger; not trivially attributable per tick
    params: { model: MODEL, queryChars: QUERY_MAX_CHARS },
  };

  const nonNull = scores.filter((s) => s !== null).length;
  console.log(`    [embed] v${VERSION}  ${wallMs}ms  ${nonNull}/${scores.length} scored`);
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------
export default async function embedHook({ ticks, contexts }) {
  for (let i = 0; i < ticks.length; i++) {
    await scoreTick(ticks[i], contexts[i]);
  }
}
