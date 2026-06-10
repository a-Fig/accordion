/*
 * rerank.mjs — "rerank" scorer hook for the Relevance Lab.
 *
 * Scorer id: "rerank"  version: "1"
 * Model: BAAI/bge-reranker-v2-m3  (cross-encoder, raw logit per pair)
 *
 * Hook contract (run.mjs):
 *   default export async ({ session, ticks, contexts, paths }) => void
 *   Mutates ticks[i].scores.rerank and ticks[i].scorers.rerank in place.
 *
 * Python sidecar: scoring/probe/reranker.py
 * Runs per-tick: input JSON -> temp file -> spawn Python -> read output JSON.
 *
 * Cache: ~/.accordion/relevance/cache/rerank/<sha256(model+tailText+blockIds)>.json
 * Timeout: 20 minutes per tick.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SCORER_ID = "rerank";
const VERSION = "1";
const MODEL = "BAAI/bge-reranker-v2-m3";

// Text caps (matching reranker.py intent, in chars as a rough pre-filter)
// These are generous — the Python side further truncates by token count.
const TAIL_MAX_CHARS = 12_000;   // ~1024 tokens worth of chars, kept from the end
const BLOCK_HEAD_CHARS = 1_536;  // ~384 tokens
const BLOCK_TAIL_CHARS = 512;    // ~128 tokens

const TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

const CACHE_DIR = path.join(os.homedir(), ".accordion", "relevance", "cache", "rerank");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VENV_PYTHON = path.join(REPO_ROOT, "scoring", "probe", ".venv", "Scripts", "python.exe");
const RERANKER_SCRIPT = path.join(REPO_ROOT, "scoring", "probe", "reranker.py");

function resolvePython() {
  if (fs.existsSync(VENV_PYTHON)) return VENV_PYTHON;
  const envPy = process.env["PYTHON"];
  if (envPy && fs.existsSync(envPy)) return envPy;
  return "python"; // last resort — system PATH
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------
function cacheKey(tailText, blockIds) {
  const payload = `${MODEL}||${tailText}||${blockIds.join(",")}`;
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function cacheRead(key) {
  const p = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch { /* corrupt cache — ignore */ }
  }
  return null;
}

function cacheWrite(key, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const p = path.join(CACHE_DIR, `${key}.json`);
  fs.writeFileSync(p, JSON.stringify(data), "utf8");
}

// ---------------------------------------------------------------------------
// Text truncation helpers (char-level pre-trim before Python token-level trim)
// ---------------------------------------------------------------------------
function truncateTailText(text) {
  if (text.length <= TAIL_MAX_CHARS) return text;
  return text.slice(text.length - TAIL_MAX_CHARS);
}

function truncateBlockText(text) {
  const total = BLOCK_HEAD_CHARS + BLOCK_TAIL_CHARS;
  if (text.length <= total) return text;
  return text.slice(0, BLOCK_HEAD_CHARS) + text.slice(text.length - BLOCK_TAIL_CHARS);
}

// ---------------------------------------------------------------------------
// Score a single tick
// ---------------------------------------------------------------------------
async function scoreTick(tickScores, ctx) {
  const t0 = performance.now();

  const scoredBlocks = ctx.blocks.slice(0, ctx.atBlock);
  if (scoredBlocks.length === 0) {
    tickScores.scores[SCORER_ID] = [];
    tickScores.scorers[SCORER_ID] = { version: VERSION, wallMs: 0, params: { note: "no scored blocks" } };
    return;
  }

  // Prepare texts
  const tailText = truncateTailText(ctx.tailText);
  const blockIds = scoredBlocks.map((b) => b.id);
  const blockPayload = scoredBlocks.map((b) => ({
    id: b.id,
    text: truncateBlockText(b.text ?? ""),
  }));

  // Cache check
  const key = cacheKey(tailText, blockIds);
  const cached = cacheRead(key);
  if (cached) {
    const wallMs = Math.round(performance.now() - t0);
    const scores = blockIds.map((id) => cached.scores?.[id] ?? null);
    const meta = cached.meta ?? {};
    tickScores.scores[SCORER_ID] = scores;
    tickScores.scorers[SCORER_ID] = {
      version: VERSION,
      wallMs,
      params: { ...meta.params, cached: true },
    };
    const nonNull = scores.filter((s) => s !== null).length;
    console.log(`    [rerank] v${VERSION}  ${wallMs}ms  ${nonNull}/${scores.length} scored  (cached)`);
    return;
  }

  // Write input temp file
  const tmpIn = path.join(os.tmpdir(), `rerank-in-${Date.now()}.json`);
  const tmpOut = path.join(os.tmpdir(), `rerank-out-${Date.now()}.json`);

  const inputData = { tail: tailText, blocks: blockPayload };
  fs.writeFileSync(tmpIn, JSON.stringify(inputData), "utf8");

  // Spawn Python sidecar
  const python = resolvePython();
  const result = spawnSync(
    python,
    [RERANKER_SCRIPT, "--in", tmpIn, "--out", tmpOut, "--model", MODEL],
    {
      stdio: ["ignore", "inherit", "inherit"],
      timeout: TIMEOUT_MS,
      encoding: "utf8",
    },
  );

  // Cleanup temp input
  try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }

  if (result.status !== 0 || result.error) {
    const msg = result.error?.message ?? `exit code ${result.status}`;
    // Cleanup temp output if it exists
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
    throw new Error(`reranker.py failed: ${msg}`);
  }

  // Read output
  let outputData;
  try {
    outputData = JSON.parse(fs.readFileSync(tmpOut, "utf8"));
  } finally {
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }

  // Cache the raw output
  cacheWrite(key, outputData);

  // Map scores to blockIds-aligned array (missing → null)
  const scoresMap = outputData.scores ?? {};
  const scores = blockIds.map((id) => {
    const v = scoresMap[id];
    return (v === undefined || v === null) ? null : Number(v);
  });

  const wallMs = Math.round(performance.now() - t0);
  const meta = outputData.meta ?? {};

  tickScores.scores[SCORER_ID] = scores;
  tickScores.scorers[SCORER_ID] = {
    version: VERSION,
    wallMs,
    params: meta.params ?? {},
  };

  const nonNull = scores.filter((s) => s !== null).length;
  console.log(`    [rerank] v${VERSION}  ${wallMs}ms  ${nonNull}/${scores.length} scored  device=${meta.device ?? "?"}`);
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------
export default async function rerankHook({ ticks, contexts }) {
  for (let i = 0; i < ticks.length; i++) {
    await scoreTick(ticks[i], contexts[i]);
  }
}
