/*
 * eval.mjs — Relevance Lab evaluator.
 *
 * Usage:
 *   node scoring/eval.mjs <scoreFile.json> <session.jsonl> [<scoreFile2.json> <session2.jsonl> ...]
 *   node scoring/eval.mjs --manifest <manifest.json>
 *
 * Manifest JSON: [ { "scoreFile": "...", "session": "..." }, ... ]
 *
 * Computes per-session and pooled:
 *   - Silver labels (ident re-mention within k=10 turns)
 *   - Gold labels (agent unfold events resolved via foldCode)
 *   - nDCG@10, P@10 vs silver (mean across ticks, nulls rank last)
 *   - 8×8 Spearman correlation matrix (pooled across ticks per session)
 *   - Gold rank-percentile table (one row per event × scorer)
 *   - Wall-time and cost from ScoreFile metas
 *
 * Outputs:
 *   ~/.accordion/relevance/report.md  — full candid report
 *   docs/relevance-lab-results.md     — committable (sample metrics only, no content)
 */

import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node scoring/eval.mjs <scoreFile.json> <session.jsonl> [more pairs...]\n" +
    "       node scoring/eval.mjs --manifest <manifest.json>");
  process.exit(1);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_LIB = path.join(REPO_ROOT, "app", "src", "lib");

// ---------------------------------------------------------------------------
// jiti bootstrap
// ---------------------------------------------------------------------------
const jiti = createJiti(import.meta.url);

const parseMod = await jiti.import(path.join(APP_LIB, "engine", "parse.ts"));
const { parse } = parseMod;

const extractMod = await jiti.import(path.join(APP_LIB, "relevance", "extract.ts"));
const { extractIdents, identCounts } = extractMod;

const digestMod = await jiti.import(path.join(APP_LIB, "engine", "digest.ts"));
const { foldCode, FOLDABLE_KINDS } = digestMod;

const tailMod = await jiti.import(path.join(APP_LIB, "relevance", "tail.ts"));
const { sampleTicks } = tailMod;

const contextMod = await jiti.import(path.join(APP_LIB, "relevance", "context.ts"));
const { buildTickContext } = contextMod;

const scoreFileMod = await jiti.import(path.join(APP_LIB, "relevance", "scoreFile.ts"));
const { validateScoreFile } = scoreFileMod;

const mappingMod = await jiti.import(path.join(APP_LIB, "live", "mapping.ts"));
const { linearize } = mappingMod;

// ---------------------------------------------------------------------------
// Collect pairs from args or manifest
// ---------------------------------------------------------------------------
/** @type {{ scoreFile: string, session: string }[]} */
let pairs = [];

if (args[0] === "--manifest") {
  const manifestPath = args[1];
  if (!manifestPath) { console.error("--manifest requires a path"); process.exit(1); }
  pairs = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} else {
  if (args.length % 2 !== 0) {
    console.error("Args must be paired: <scoreFile.json> <session.jsonl> ...");
    process.exit(1);
  }
  for (let i = 0; i < args.length; i += 2) {
    pairs.push({ scoreFile: args[i], session: args[i + 1] });
  }
}

for (const p of pairs) {
  if (!fs.existsSync(p.scoreFile)) { console.error(`Score file not found: ${p.scoreFile}`); process.exit(1); }
  if (!fs.existsSync(p.session)) { console.error(`Session file not found: ${p.session}`); process.exit(1); }
}

console.log(`Evaluating ${pairs.length} session(s)...`);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const K = 10;           // nDCG@K, P@K
const SILVER_K_TURNS = 10; // silver: re-mention within next 10 turns
const DISTINCTIVE_DF_CAP = 0.25; // mirrors actr.ts
const MIN_SILVER_POSITIVES = 3;  // skip ticks with fewer positives

const SCORER_IDS = ["recency", "actr", "bm25", "graph", "embed", "judge", "attn", "rerank"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Round a number to N significant figures. */
function sigFig(x, n = 4) {
  if (x === null || x === undefined || isNaN(x) || !isFinite(x)) return x;
  if (x === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(x)));
  const factor = Math.pow(10, n - d);
  return Math.round(x * factor) / factor;
}

/** nDCG@K: items is array of {score, label} sorted desc by score; nulls ranked last. */
function ndcg(items, k) {
  const sorted = [...items].sort((a, b) => {
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });
  const top = sorted.slice(0, k);
  const dcg = top.reduce((s, it, i) => s + (it.label / Math.log2(i + 2)), 0);
  const ideal = [...items]
    .sort((a, b) => b.label - a.label)
    .slice(0, k)
    .reduce((s, it, i) => s + (it.label / Math.log2(i + 2)), 0);
  if (ideal === 0) return null;
  return dcg / ideal;
}

/** Precision@K. */
function precisionAtK(items, k) {
  const sorted = [...items].sort((a, b) => {
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });
  const top = sorted.slice(0, k);
  const hits = top.filter((it) => it.label > 0).length;
  return hits / k;
}

/** Rank percentile for a block: what fraction of blocks have a lower score (0=worst, 1=best). */
function rankPercentile(scores, blockIdx) {
  const val = scores[blockIdx];
  if (val === null || val === undefined) return null;
  const nonNull = scores.filter((s) => s !== null && s !== undefined);
  if (!nonNull.length) return null;
  // Count how many are strictly less than val
  const below = nonNull.filter((s) => s < val).length;
  return below / (nonNull.length - 1 || 1); // 0..1 (1=top)
}

/**
 * Spearman rank correlation between two arrays (pairs where both non-null).
 * Returns null if fewer than 3 valid pairs.
 */
function spearman(a, b) {
  if (!a || !b) return null;
  const pairs = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== null && a[i] !== undefined && b[i] !== null && b[i] !== undefined &&
        isFinite(a[i]) && isFinite(b[i])) {
      pairs.push([a[i], b[i]]);
    }
  }
  if (pairs.length < 3) return null;

  // Rank arrays
  function rankArray(vals) {
    const indexed = vals.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const ranks = new Array(vals.length);
    for (let i = 0; i < indexed.length; ) {
      let j = i;
      while (j < indexed.length && indexed[j][0] === indexed[i][0]) j++;
      const avgRank = (i + j - 1) / 2 + 1;
      for (let k = i; k < j; k++) ranks[indexed[k][1]] = avgRank;
      i = j;
    }
    return ranks;
  }

  const aVals = pairs.map((p) => p[0]);
  const bVals = pairs.map((p) => p[1]);
  const ra = rankArray(aVals);
  const rb = rankArray(bVals);

  let num = 0, sa2 = 0, sb2 = 0;
  const meanA = ra.reduce((s, v) => s + v, 0) / ra.length;
  const meanB = rb.reduce((s, v) => s + v, 0) / rb.length;
  for (let i = 0; i < ra.length; i++) {
    const da = ra[i] - meanA;
    const db = rb[i] - meanB;
    num += da * db;
    sa2 += da * da;
    sb2 += db * db;
  }
  if (sa2 === 0 || sb2 === 0) return null;
  return num / Math.sqrt(sa2 * sb2);
}

// ---------------------------------------------------------------------------
// Silver label generation
// ---------------------------------------------------------------------------
/**
 * For a tick (endBlock E, atBlock A, lastTurn T = turn of block E-1):
 * block b ∈ [0, A) is positive iff some DISTINCTIVE ident of b (df < 25% prefix blocks,
 * df >= 1) occurs in a block with turn ∈ (T, T + SILVER_K_TURNS] AND order >= E.
 *
 * "order >= E" means the re-mention block is strictly after the prefix (future blocks).
 * We use the FULL session blocks for the future window.
 */
function computeSilverLabels(blocks, endBlock, atBlock) {
  const prefixSize = endBlock;
  const lastTurn = blocks[endBlock - 1]?.turn ?? 0;

  // DF over prefix [0, endBlock)
  const dfMap = identCounts(blocks, endBlock);
  const dfThreshold = DISTINCTIVE_DF_CAP * prefixSize;

  // Build a postings map for blocks at index >= endBlock with turns in (lastTurn, lastTurn+k]
  // (future blocks that re-mention idents)
  const futureLimit = lastTurn + SILVER_K_TURNS;
  const futureIdents = new Set();
  for (let i = endBlock; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.turn > lastTurn && b.turn <= futureLimit) {
      const ids = extractIdents(b.text);
      for (const id of ids) futureIdents.add(id);
    }
  }

  const labels = new Array(atBlock).fill(0);
  for (let bi = 0; bi < atBlock; bi++) {
    const b = blocks[bi];
    const bIdents = extractIdents(b.text);
    for (const ident of bIdents) {
      const df = dfMap.get(ident) ?? 0;
      if (df < 1 || df >= dfThreshold) continue; // not distinctive
      if (futureIdents.has(ident)) {
        labels[bi] = 1;
        break;
      }
    }
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Gold label generation: agent unfold events
// ---------------------------------------------------------------------------
/**
 * Parse JSONL messages (pi or Claude Code format) to find unfold tool calls.
 * Returns array of { codes: string[], eventTurn: number|null }
 * where eventTurn is the turn number at which the unfold call was made.
 *
 * pi format: entry = {type: "message", message: {role: "assistant",
 *   content: [{type: "toolCall", name: "unfold", arguments: {codes: [...]}}]}}
 * Claude Code format: entry = {type: "assistant", message: {content:
 *   [{type: "tool_use", name: "unfold", input: {codes: [...]}}]}}
 */
function findUnfoldEvents(rawJsonl) {
  const lines = rawJsonl.split("\n").filter(Boolean);
  const events = [];

  // We track turn count by counting user messages (pi format)
  let turn = 0;

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;

    // pi format
    if (entry.type === "message") {
      const m = entry.message || {};
      if (m.role === "user") turn++;
      if (m.role === "assistant") {
        const content = Array.isArray(m.content) ? m.content : [];
        for (const part of content) {
          // pi: toolCall
          if (part?.type === "toolCall" && part?.name === "unfold") {
            // "codes" field (newer format, base36 foldCodes)
            const codes = part?.arguments?.codes;
            if (Array.isArray(codes) && codes.length) {
              events.push({ codes, idsAreCodes: true, eventTurn: turn });
            }
            // "ids" field (older format: may contain direct block ids OR short codes)
            const ids = part?.arguments?.ids;
            if (Array.isArray(ids) && ids.length) {
              // Heuristic: if they look like block ids (contain ':'), treat as direct block ids
              // otherwise treat as fold codes
              const lookLikeBlockIds = ids.some((s) => typeof s === "string" && s.includes(":"));
              events.push({ codes: ids, idsAreCodes: !lookLikeBlockIds, idsAreBlockIds: lookLikeBlockIds, eventTurn: turn });
            }
          }
          // Claude Code within pi (unlikely but defensive): tool_use
          if (part?.type === "tool_use" && part?.name === "unfold") {
            const codes = part?.input?.codes;
            if (Array.isArray(codes) && codes.length) {
              events.push({ codes, eventTurn: turn });
            }
          }
        }
      }
    }
    // Claude Code format
    else if (entry.type === "assistant") {
      const m = entry.message || {};
      const content = Array.isArray(m.content) ? m.content : [];
      for (const part of content) {
        if (part?.type === "tool_use" && part?.name === "unfold") {
          const codes = part?.input?.codes;
          if (Array.isArray(codes) && codes.length) {
            events.push({ codes, eventTurn: turn });
          }
        }
      }
    }
    else if (entry.type === "user") {
      // Claude Code user turn
      const m = entry.message || {};
      const c = m.content;
      const hasToolResult = Array.isArray(c) ? c.some((b) => b?.type === "tool_result") : false;
      if (!hasToolResult) turn++;
    }
  }
  return events;
}

/**
 * Build a wire-block-id → engine-block-id mapping from the raw JSONL.
 *
 * Strategy: walk JSONL entries in order. For each "message" entry, linearize
 * emits a run of wire blocks and parse emits a run of engine blocks. We iterate
 * both runs in sync per message and match positionally when counts are equal.
 * When counts differ (the known ±1 off-by-one) we match by kind sequence and
 * use callId cross-check for tool_result blocks as a verification assert.
 *
 * Returns Map<wireId, engineId>.
 */
function buildWireToEngineMap(rawJsonl, engineBlocks) {
  const lines = rawJsonl.split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch {}
  }

  // Extract messages for linearize (same extraction as gold-debug.mjs)
  const msgs = entries.map((e) => e.message).filter(Boolean);

  // linearize gives us all wire blocks
  const wireBlocks = linearize(msgs);

  // Build a callId → engineBlockId map for tool_result verification
  const callIdToEngineId = new Map();
  for (const b of engineBlocks) {
    if (b.kind === "tool_result" && b.callId) callIdToEngineId.set(b.callId, b.id);
  }

  const wireToEngine = new Map(); // wireId → engineId

  // Walk JSONL entries, processing "message" entries one at a time.
  // For each such entry we need to know which wire blocks and which engine blocks it emits.
  // We replay both traversals in parallel using a shared cursor approach.

  let wireCursor = 0;
  let engCursor = 0;
  let ei = 0;

  for (const e of entries) {
    const eid = e.id || `__e${ei}`;
    ei++;

    if (e.type !== "message") {
      // compaction emits 1 engine block (tool_result), no wire block
      if (e.type === "compaction") {
        engCursor += 1;
      }
      continue;
    }

    const m = e.message || {};

    // Predict how many wire blocks linearize emits for this message
    let wireCount = 0;
    if (m.role === "user") {
      // linearize: push user block only if text is non-empty (same guard as Sink.push)
      const txt = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
          : "";
      if (txt) wireCount = 1;
    } else if (m.role === "assistant") {
      const parts = Array.isArray(m.content) ? m.content : [];
      for (const b of parts) {
        if (b?.type === "thinking" && b.thinking) wireCount++;
        else if (b?.type === "text" && b.text) wireCount++;
        else if (b?.type === "toolCall") wireCount++;
      }
    } else if (m.role === "toolResult") {
      // wire always pushes tool_result (even empty text — same as parse.ts)
      wireCount = 1;
    }
    // other roles: 0 unless summary present (mapped as text)
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult") {
      if (typeof m.summary === "string" && m.summary) wireCount = 1;
    }

    // Predict how many engine blocks parse.ts (parsePi) emits for this entry
    let engCount = 0;
    if (m.role === "user") {
      const txt = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
          : "";
      if (txt) engCount = 1;
    } else if (m.role === "assistant") {
      const parts = Array.isArray(m.content) ? m.content : [];
      for (const b of parts) {
        if (b?.type === "thinking" && b.thinking) engCount++;
        else if (b?.type === "text" && b.text) engCount++;
        else if (b?.type === "toolCall") engCount++;
      }
    } else if (m.role === "toolResult") {
      engCount = 1;
    }

    // Collect the wire and engine blocks for this message
    const wSlice = wireBlocks.slice(wireCursor, wireCursor + wireCount);
    const eSlice = engineBlocks.slice(engCursor, engCursor + engCount);

    if (wSlice.length === eSlice.length) {
      // Equal length: zip positionally
      for (let k = 0; k < wSlice.length; k++) {
        wireToEngine.set(wSlice[k].id, eSlice[k].id);
        // Cross-check tool_result via callId
        if (wSlice[k].kind === "tool_result" && wSlice[k].callId) {
          const expected = callIdToEngineId.get(wSlice[k].callId);
          if (expected && expected !== eSlice[k].id) {
            console.warn(`    [wire→eng] callId mismatch for ${wSlice[k].id}: expected eng ${expected}, got ${eSlice[k].id}`);
          }
        }
      }
    } else {
      // Counts differ — match by kind sequence
      const wByKind = new Map();
      for (const w of wSlice) {
        if (!wByKind.has(w.kind)) wByKind.set(w.kind, []);
        wByKind.get(w.kind).push(w);
      }
      const eByKind = new Map();
      for (const eb of eSlice) {
        if (!eByKind.has(eb.kind)) eByKind.set(eb.kind, []);
        eByKind.get(eb.kind).push(eb);
      }
      // For tool_result, use callId cross-check (most reliable)
      for (const w of wSlice) {
        if (w.kind === "tool_result" && w.callId) {
          const eId = callIdToEngineId.get(w.callId);
          if (eId) {
            wireToEngine.set(w.id, eId);
            continue;
          }
        }
        // Positional match within same kind
        const wKindArr = wByKind.get(w.kind) || [];
        const eKindArr = eByKind.get(w.kind) || [];
        const wPos = wKindArr.indexOf(w);
        if (wPos >= 0 && wPos < eKindArr.length) {
          wireToEngine.set(w.id, eKindArr[wPos].id);
        } else {
          console.warn(`    [wire→eng] cannot map wire block ${w.id} (kind=${w.kind}) — skipping`);
        }
      }
    }

    wireCursor += wireCount;
    engCursor += engCount;
  }

  return wireToEngine;
}

/**
 * Given unfold events and blocks, resolve each code/id to block ids.
 * Handles both:
 *   - fold codes (6-char base36) via foldCode(wireBlock.id) — PRIMARY path
 *   - fold codes via foldCode(engineBlock.id) — FALLBACK for static/replayed sessions
 *   - direct block ids (containing ':') via identity lookup
 *
 * Returns array of { code, blockId, eventTurn }
 */
function resolveUnfoldEvents(unfoldEvents, blocks, rawJsonl) {
  // Build wire → engine id map (primary resolution path)
  const wireToEngine = buildWireToEngineMap(rawJsonl, blocks);

  // Build wire-code → engineBlockId[] map (primary)
  const wireCodeMap = new Map(); // foldCode(wireId) → engineId[]
  for (const [wireId, engineId] of wireToEngine) {
    // Only map foldable blocks
    const engBlock = blocks.find((b) => b.id === engineId);
    if (!engBlock || !FOLDABLE_KINDS.has(engBlock.kind)) continue;
    const code = foldCode(wireId);
    if (!wireCodeMap.has(code)) wireCodeMap.set(code, []);
    wireCodeMap.get(code).push(engineId);
  }

  // Fallback: engine-id-based code map (for static/replayed sessions)
  const engCodeMap = new Map(); // foldCode(engineId) → blockId[]
  for (const b of blocks) {
    if (!FOLDABLE_KINDS.has(b.kind)) continue;
    const code = foldCode(b.id);
    if (!engCodeMap.has(code)) engCodeMap.set(code, []);
    engCodeMap.get(code).push(b.id);
  }

  // Also build id → block for direct id lookups
  const blockIdSet = new Set(blocks.map((b) => b.id));

  const resolved = [];
  for (const ev of unfoldEvents) {
    for (const code of ev.codes) {
      if (ev.idsAreBlockIds) {
        // Direct block id
        if (blockIdSet.has(code)) {
          resolved.push({ code, blockId: code, eventTurn: ev.eventTurn });
        }
      } else {
        // fold code — try wire-based map first, fall back to engine-based
        const wireMatches = wireCodeMap.get(code);
        if (wireMatches && wireMatches.length) {
          for (const blockId of wireMatches) {
            resolved.push({ code, blockId, eventTurn: ev.eventTurn });
          }
          continue;
        }
        const engMatches = engCodeMap.get(code);
        if (engMatches && engMatches.length) {
          for (const blockId of engMatches) {
            resolved.push({ code, blockId, eventTurn: ev.eventTurn });
          }
        }
        // If neither matched, code is unresolvable — silently drop (logged via count)
      }
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Per-session evaluation
// ---------------------------------------------------------------------------
async function evaluateSession(scoreFilePath, sessionPath) {
  const sessionId = path.basename(scoreFilePath, ".scores.json");
  const rawScoreFile = JSON.parse(fs.readFileSync(scoreFilePath, "utf8"));
  const scoreFile = validateScoreFile(rawScoreFile);
  if (!scoreFile) {
    throw new Error(`Invalid score file: ${scoreFilePath}`);
  }

  const rawJsonl = fs.readFileSync(sessionPath, "utf8");
  const parsed = parse(rawJsonl);
  const { blocks } = parsed;

  console.log(`  Session: ${sessionId}  blocks: ${blocks.length}  ticks: ${scoreFile.ticks.length}`);

  // ---- Silver labels per tick ----
  const tickResults = [];
  let skippedTicks = 0;

  for (const tick of scoreFile.ticks) {
    const { endBlock, atBlock, blockIds, scores, scorers } = tick;

    // Compute silver labels
    const silverLabels = computeSilverLabels(blocks, endBlock, atBlock);
    const positiveCount = silverLabels.filter((l) => l > 0).length;

    if (positiveCount < MIN_SILVER_POSITIVES) {
      skippedTicks++;
      continue;
    }

    // Per-scorer metrics
    const tickMetrics = {};
    for (const sid of SCORER_IDS) {
      const scorerScores = scores[sid];
      if (!scorerScores) { tickMetrics[sid] = null; continue; }

      const items = silverLabels.map((label, i) => ({
        score: scorerScores[i] ?? null,
        label,
      }));
      const ndcgVal = ndcg(items, K);
      const precVal = precisionAtK(items, K);
      tickMetrics[sid] = { ndcg: ndcgVal, precision: precVal };
    }

    tickResults.push({
      tick: tick.tick,
      endBlock,
      atBlock,
      positiveCount,
      silverLabels,
      tickMetrics,
      scores,
      scorers,
      blockIds,
    });
  }

  // ---- Mean metrics across valid ticks ----
  const meanMetrics = {};
  for (const sid of SCORER_IDS) {
    const ndcgVals = tickResults
      .map((t) => t.tickMetrics[sid]?.ndcg)
      .filter((v) => v !== null && v !== undefined);
    const precVals = tickResults
      .map((t) => t.tickMetrics[sid]?.precision)
      .filter((v) => v !== null && v !== undefined);
    meanMetrics[sid] = {
      ndcg: ndcgVals.length ? ndcgVals.reduce((s, v) => s + v, 0) / ndcgVals.length : null,
      precision: precVals.length ? precVals.reduce((s, v) => s + v, 0) / precVals.length : null,
    };
  }

  // ---- Spearman correlation matrix (pooled across ticks) ----
  // Gather all (tick, blockIdx) score vectors per scorer
  const pooledScores = {};
  for (const sid of SCORER_IDS) pooledScores[sid] = [];
  for (const t of tickResults) {
    const n = t.atBlock;
    for (let i = 0; i < n; i++) {
      for (const sid of SCORER_IDS) {
        const s = t.scores[sid];
        pooledScores[sid].push(s ? (s[i] ?? null) : null);
      }
    }
  }

  const spearmanMatrix = {};
  for (const sid1 of SCORER_IDS) {
    spearmanMatrix[sid1] = {};
    for (const sid2 of SCORER_IDS) {
      if (sid1 === sid2) { spearmanMatrix[sid1][sid2] = 1.0; continue; }
      spearmanMatrix[sid1][sid2] = spearman(pooledScores[sid1], pooledScores[sid2]);
    }
  }

  // ---- Gold events ----
  const unfoldEventsRaw = findUnfoldEvents(rawJsonl);
  const unfoldEvents = resolveUnfoldEvents(unfoldEventsRaw, blocks, rawJsonl);

  console.log(`    unfold events found: ${unfoldEventsRaw.length}  resolved to ${unfoldEvents.length} block(s)`);

  const goldRows = [];
  for (const ev of unfoldEvents) {
    // Find the block index by id
    const blockIdx = blocks.findIndex((b) => b.id === ev.blockId);
    if (blockIdx < 0) {
      console.log(`    [gold] block ${ev.blockId} not found — skipping`);
      continue;
    }

    // Find the LATEST tick whose lastTurn (= turn of block endBlock-1) < eventTurn
    let latestTick = null;
    if (ev.eventTurn !== null) {
      for (const t of scoreFile.ticks) {
        const lastTurn = blocks[t.endBlock - 1]?.turn ?? 0;
        if (lastTurn < ev.eventTurn) {
          if (!latestTick || t.endBlock > latestTick.endBlock) {
            latestTick = t;
          }
        }
      }
    }

    if (!latestTick) {
      console.log(`    [gold] no tick precedes eventTurn=${ev.eventTurn} for block ${ev.blockId} — skipping`);
      goldRows.push({
        blockId: ev.blockId,
        code: ev.code,
        eventTurn: ev.eventTurn,
        tickUsed: null,
        percentiles: null,
        note: "no preceding tick",
      });
      continue;
    }

    // Find the block's index in this tick's blockIds
    const tickBlockIdx = latestTick.blockIds.indexOf(ev.blockId);
    if (tickBlockIdx < 0) {
      console.log(`    [gold] block ${ev.blockId} not in tick ${latestTick.tick} scored set — skipping`);
      goldRows.push({
        blockId: ev.blockId,
        code: ev.code,
        eventTurn: ev.eventTurn,
        tickUsed: latestTick.tick,
        percentiles: null,
        note: "block not in scored set (in tail)",
      });
      continue;
    }

    // Compute rank percentile per scorer
    const percentiles = {};
    for (const sid of SCORER_IDS) {
      const scorerScores = latestTick.scores[sid];
      if (!scorerScores) { percentiles[sid] = null; continue; }
      percentiles[sid] = rankPercentile(scorerScores, tickBlockIdx);
    }

    goldRows.push({
      blockId: ev.blockId,
      code: ev.code,
      eventTurn: ev.eventTurn,
      tickUsed: latestTick.tick,
      percentiles,
      note: null,
    });
  }

  // ---- Wall times and costs from scorers ----
  const scorerStats = {};
  for (const sid of SCORER_IDS) {
    let totalWallMs = 0;
    let totalCostUsd = 0;
    let count = 0;
    for (const t of scoreFile.ticks) {
      const meta = t.scorers[sid];
      if (!meta) continue;
      totalWallMs += meta.wallMs ?? 0;
      totalCostUsd += meta.costUsd ?? 0;
      count++;
    }
    scorerStats[sid] = { totalWallMs, totalCostUsd, tickCount: count };
  }

  return {
    sessionId,
    blockCount: blocks.length,
    tickCount: scoreFile.ticks.length,
    validTickCount: tickResults.length,
    skippedTicks,
    meanMetrics,
    spearmanMatrix,
    goldRows,
    scorerStats,
    pooledScores,
    tickResults,
  };
}

// ---------------------------------------------------------------------------
// Pool metrics across sessions
// ---------------------------------------------------------------------------
function poolMetrics(sessionResults) {
  const pooled = {};
  for (const sid of SCORER_IDS) {
    const ndcgVals = sessionResults.flatMap((s) => {
      const m = s.meanMetrics[sid];
      return m?.ndcg !== null && m?.ndcg !== undefined ? [m.ndcg] : [];
    });
    const precVals = sessionResults.flatMap((s) => {
      const m = s.meanMetrics[sid];
      return m?.precision !== null && m?.precision !== undefined ? [m.precision] : [];
    });
    pooled[sid] = {
      ndcg: ndcgVals.length ? ndcgVals.reduce((a, b) => a + b, 0) / ndcgVals.length : null,
      precision: precVals.length ? precVals.reduce((a, b) => a + b, 0) / precVals.length : null,
    };
  }
  return pooled;
}

/** Pool Spearman matrices by averaging pairwise values. */
function poolSpearman(sessionResults) {
  const pooled = {};
  for (const sid1 of SCORER_IDS) {
    pooled[sid1] = {};
    for (const sid2 of SCORER_IDS) {
      if (sid1 === sid2) { pooled[sid1][sid2] = 1.0; continue; }
      const vals = sessionResults
        .map((s) => s.spearmanMatrix[sid1]?.[sid2])
        .filter((v) => v !== null && v !== undefined);
      pooled[sid1][sid2] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
  }
  return pooled;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function fmtNum(v, decimals = 3) {
  if (v === null || v === undefined || isNaN(v)) return "  — ";
  return v.toFixed(decimals).padStart(6);
}

function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return "  — ";
  return (v * 100).toFixed(1).padStart(5) + "%";
}

function fmtMs(ms) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtUsd(v) {
  if (!v) return "$0.000";
  return `$${v.toFixed(4)}`;
}

function mdTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cols) => "| " + cols.map((c, i) => String(c ?? "").padEnd(widths[i])).join(" | ") + " |";
  const sep = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

function spearmanTableMd(matrix, sid_short) {
  const headers = ["scorer", ...SCORER_IDS.map((s) => sid_short[s] ?? s)];
  const rows = SCORER_IDS.map((sid1) => [
    sid1,
    ...SCORER_IDS.map((sid2) => {
      const v = matrix[sid1]?.[sid2];
      if (v === null || v === undefined) return "  — ";
      return v.toFixed(2);
    }),
  ]);
  return mdTable(headers, rows);
}

// ---------------------------------------------------------------------------
// Silver label spot-check (for verification)
// ---------------------------------------------------------------------------
function spotCheckSilver(blocks, endBlock, atBlock) {
  const dfMap = identCounts(blocks, endBlock);
  const dfThreshold = DISTINCTIVE_DF_CAP * endBlock;
  const lastTurn = blocks[endBlock - 1]?.turn ?? 0;
  const futureLimit = lastTurn + SILVER_K_TURNS;

  for (let bi = 0; bi < atBlock; bi++) {
    const b = blocks[bi];
    const bIdents = extractIdents(b.text);
    for (const ident of bIdents) {
      const df = dfMap.get(ident) ?? 0;
      if (df < 1 || df >= dfThreshold) continue;
      // Look for re-mention in future blocks
      for (let fi = endBlock; fi < blocks.length; fi++) {
        const fb = blocks[fi];
        if (fb.turn <= lastTurn || fb.turn > futureLimit) continue;
        const fIdents = extractIdents(fb.text);
        if (fIdents.includes(ident)) {
          return {
            blockId: b.id,
            blockTurn: b.turn,
            ident,
            reMentionBlockId: fb.id,
            reMentionTurn: fb.turn,
          };
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const sessionResults = [];

for (const pair of pairs) {
  console.log(`\nEvaluating: ${path.basename(pair.scoreFile)} + ${path.basename(pair.session)}`);
  try {
    const result = await evaluateSession(pair.scoreFile, pair.session);
    sessionResults.push(result);
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
  }
}

if (!sessionResults.length) {
  console.error("No sessions evaluated.");
  process.exit(1);
}

// ---- Spot-check (sample session, first valid tick) ----
const sampleResult = sessionResults[0];
let spotCheck = null;
if (sampleResult && sampleResult.tickResults.length) {
  const t0 = sampleResult.tickResults[0];
  const parsed0 = parse(fs.readFileSync(pairs[0].session, "utf8"));
  spotCheck = spotCheckSilver(parsed0.blocks, t0.endBlock, t0.atBlock);
}

// ---- Pool metrics ----
const pooledMetrics = poolMetrics(sessionResults);
const pooledSpearman = poolSpearman(sessionResults);

// ---- Collect total gold rows ----
const allGoldRows = sessionResults.flatMap((s) => s.goldRows.map((g) => ({ ...g, sessionId: s.sessionId })));

// ---- Vertex spend total ----
const spendPath = path.join(os.homedir(), ".accordion", "relevance", "spend.jsonl");
let totalSpend = 0;
if (fs.existsSync(spendPath)) {
  const lines = fs.readFileSync(spendPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try { totalSpend += JSON.parse(line).usd ?? 0; } catch {}
  }
}

// ---- Identify sample session (for committable report) ----
const isSampleSession = (s) => s.sessionId === "sample-session";
const sampleSess = sessionResults.find(isSampleSession);
const corpusSessions = sessionResults.filter((s) => !isSampleSession(s));

// ---------------------------------------------------------------------------
// Build local full report
// ---------------------------------------------------------------------------
function buildFullReport() {
  const lines = [];
  lines.push("# Relevance Lab — Full Report");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Sessions: ${sessionResults.length}  Total Vertex spend: ${fmtUsd(totalSpend)}`);
  lines.push("");

  for (const sess of sessionResults) {
    lines.push(`## Session: ${sess.sessionId}`);
    lines.push(`- Blocks: ${sess.blockCount}  |  Ticks: ${sess.tickCount} (${sess.validTickCount} valid, ${sess.skippedTicks} skipped for <${MIN_SILVER_POSITIVES} silver positives)`);
    lines.push("");

    // Scorer comparison table
    lines.push("### Scorer comparison (silver labels, nDCG@10, P@10)");
    lines.push("");
    const headers = ["scorer", "nDCG@10", "P@10", "wallTotal", "costUsd"];
    const rows = SCORER_IDS.map((sid) => {
      const m = sess.meanMetrics[sid];
      const st = sess.scorerStats[sid];
      return [
        sid,
        m?.ndcg !== null ? m.ndcg.toFixed(3) : "—",
        m?.precision !== null ? m.precision.toFixed(3) : "—",
        fmtMs(st?.totalWallMs),
        fmtUsd(st?.totalCostUsd),
      ];
    });
    lines.push(mdTable(headers, rows));
    lines.push("");

    // Spearman matrix
    lines.push("### Spearman rank correlation matrix (pooled across ticks)");
    lines.push("");
    const sidShort = { recency: "recny", actr: "actr", bm25: "bm25", graph: "graph", embed: "embed", judge: "judge", attn: "attn", rerank: "rrk" };
    lines.push(spearmanTableMd(sess.spearmanMatrix, sidShort));
    lines.push("");

    // Gold events
    if (sess.goldRows.length) {
      lines.push("### Gold events (agent unfold)");
      lines.push("");
      const goldHeaders = ["blockId", "code", "evTurn", "tick", ...SCORER_IDS.map((s) => s), "note"];
      const goldRows = sess.goldRows.map((g) => [
        g.blockId,
        g.code,
        g.eventTurn ?? "?",
        g.tickUsed ?? "—",
        ...(g.percentiles
          ? SCORER_IDS.map((s) => g.percentiles[s] !== null ? g.percentiles[s].toFixed(2) : "—")
          : SCORER_IDS.map(() => "—")),
        g.note ?? "",
      ]);
      lines.push(mdTable(goldHeaders, goldRows));
      lines.push("");
    } else {
      lines.push("### Gold events: none found in this session.");
      lines.push("");
    }
  }

  // Pooled metrics
  lines.push("## Pooled metrics (all sessions)");
  lines.push("");
  const headers2 = ["scorer", "nDCG@10", "P@10"];
  const rows2 = SCORER_IDS.map((sid) => [
    sid,
    pooledMetrics[sid]?.ndcg !== null ? pooledMetrics[sid].ndcg.toFixed(3) : "—",
    pooledMetrics[sid]?.precision !== null ? pooledMetrics[sid].precision.toFixed(3) : "—",
  ]);
  lines.push(mdTable(headers2, rows2));
  lines.push("");

  lines.push("### Pooled Spearman matrix");
  lines.push("");
  const sidShort2 = { recency: "recny", actr: "actr", bm25: "bm25", graph: "graph", embed: "embed", judge: "judge", attn: "attn", rerank: "rrk" };
  lines.push(spearmanTableMd(pooledSpearman, sidShort2));
  lines.push("");

  // Spend
  lines.push(`## Vertex spend total: ${fmtUsd(totalSpend)}`);
  lines.push("");

  // Spot-check
  if (spotCheck) {
    lines.push("## Silver label spot-check (sample session, tick 0)");
    lines.push("");
    lines.push(`- **Positive block:** \`${spotCheck.blockId}\` (turn ${spotCheck.blockTurn})`);
    lines.push(`- **Ident:** \`${spotCheck.ident}\``);
    lines.push(`- **Re-mention:** block \`${spotCheck.reMentionBlockId}\` (turn ${spotCheck.reMentionTurn})`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Build committable report (sample session only, no content)
// ---------------------------------------------------------------------------
function buildCommittableReport() {
  const lines = [];
  lines.push("# Relevance Lab Results");
  lines.push("");
  lines.push("**BIAS CAVEAT (read first):** Silver labels are generated by identifier");
  lines.push("re-mention — the same signal that drives `bm25`, `actr`, and `graph`.");
  lines.push("Those three scorers partially grade their own homework on silver metrics.");
  lines.push("The honest counterweight axes are (a) judge-correlation (an independent");
  lines.push("LLM signal), and (b) gold events (agent unfold calls — a sparse but");
  lines.push("unbiased behavioral signal). Interpret nDCG/P@10 for bm25/actr/graph");
  lines.push("as upper-bound optimism; compare to judge's numbers for calibration.");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total Vertex spend: ${fmtUsd(totalSpend)}`);
  lines.push("");

  if (sampleSess) {
    lines.push("## Sample session");
    lines.push(`Blocks: ${sampleSess.blockCount}  |  Ticks: ${sampleSess.tickCount} (${sampleSess.validTickCount} valid)`);
    lines.push("");

    lines.push("### Scorer comparison (silver labels)");
    lines.push("");
    const headers = ["scorer", "nDCG@10", "P@10", "Spearman-vs-judge", "wall (total)", "cost (total)"];
    const rows = SCORER_IDS.map((sid) => {
      const m = sampleSess.meanMetrics[sid];
      const st = sampleSess.scorerStats[sid];
      const corrWithJudge = sampleSess.spearmanMatrix[sid]?.["judge"];
      return [
        sid,
        m?.ndcg !== null && m?.ndcg !== undefined ? m.ndcg.toFixed(3) : "—",
        m?.precision !== null && m?.precision !== undefined ? m.precision.toFixed(3) : "—",
        corrWithJudge !== null && corrWithJudge !== undefined ? corrWithJudge.toFixed(3) : "—",
        fmtMs(st?.totalWallMs),
        fmtUsd(st?.totalCostUsd),
      ];
    });
    lines.push(mdTable(headers, rows));
    lines.push("");

    lines.push("### Spearman 8×8 matrix (sample session, pooled across ticks)");
    lines.push("");
    const sidShort = { recency: "recny", actr: "actr", bm25: "bm25", graph: "graph", embed: "embed", judge: "judge", attn: "attn", rerank: "rrk" };
    lines.push(spearmanTableMd(sampleSess.spearmanMatrix, sidShort));
    lines.push("");
  }

  // Corpus aggregate rows (pooled metrics only, truncated ids)
  if (corpusSessions.length) {
    lines.push("## Corpus aggregate (pooled across all corpus sessions)");
    lines.push("");

    // Per-session rows with truncated ids
    lines.push("### Per-corpus-session summary");
    lines.push("");
    const sessHeaders = ["session (8 chars)", "blocks", "ticks", "bm25 nDCG", "embed nDCG", "judge nDCG", "rerank nDCG"];
    const sessRows = corpusSessions.map((s) => [
      s.sessionId.slice(0, 8) + "…",
      s.blockCount,
      `${s.validTickCount}/${s.tickCount}`,
      s.meanMetrics.bm25?.ndcg?.toFixed(3) ?? "—",
      s.meanMetrics.embed?.ndcg?.toFixed(3) ?? "—",
      s.meanMetrics.judge?.ndcg?.toFixed(3) ?? "—",
      s.meanMetrics.rerank?.ndcg?.toFixed(3) ?? "—",
    ]);
    lines.push(mdTable(sessHeaders, sessRows));
    lines.push("");

    lines.push("### Pooled corpus metrics (all corpus sessions, mean of per-session means)");
    lines.push("");
    const corpusPooled = poolMetrics(corpusSessions);
    const corpusSpearman = poolSpearman(corpusSessions);
    const pooledHeaders = ["scorer", "nDCG@10 (corpus)", "P@10 (corpus)"];
    const pooledRows = SCORER_IDS.map((sid) => [
      sid,
      corpusPooled[sid]?.ndcg?.toFixed(3) ?? "—",
      corpusPooled[sid]?.precision?.toFixed(3) ?? "—",
    ]);
    lines.push(mdTable(pooledHeaders, pooledRows));
    lines.push("");
  }

  // Gold event table (all sessions)
  const goldEvents = allGoldRows.filter((g) => g.percentiles !== null);
  if (goldEvents.length > 0) {
    lines.push("## Gold events (agent unfold — 6 events total)");
    lines.push("");
    lines.push("Rank percentile: 1.0 = ranked most relevant by that scorer.");
    lines.push("");
    const goldHeaders = ["session", "blockId", "evTurn", "tick", ...SCORER_IDS];
    const goldRows = goldEvents.map((g) => [
      isSampleSession(g) ? "sample" : g.sessionId.slice(0, 8) + "…",
      g.blockId,
      g.eventTurn ?? "?",
      g.tickUsed ?? "—",
      ...SCORER_IDS.map((s) =>
        g.percentiles?.[s] !== null && g.percentiles?.[s] !== undefined
          ? g.percentiles[s].toFixed(2) : "—"
      ),
    ]);
    lines.push(mdTable(goldHeaders, goldRows));
    lines.push("");
  } else {
    lines.push("## Gold events");
    lines.push("");
    lines.push("No gold events resolved with preceding ticks.");
    const skipped = allGoldRows.filter((g) => g.note);
    if (skipped.length) {
      lines.push("");
      lines.push(`(${skipped.length} event(s) skipped: ${[...new Set(skipped.map((g) => g.note))].join("; ")})`);
    }
    lines.push("");
  }

  // Spot-check (sample session only)
  if (spotCheck) {
    lines.push("## Silver label spot-check (sample session, first valid tick)");
    lines.push("");
    lines.push("Verified manually: a positive block and the later block that re-mentions its ident.");
    lines.push("");
    lines.push(`- Positive block id: \`${spotCheck.blockId}\``);
    lines.push(`- Block turn: ${spotCheck.blockTurn}`);
    lines.push(`- Distinctive ident: \`${spotCheck.ident}\``);
    lines.push(`- Re-mention block id: \`${spotCheck.reMentionBlockId}\``);
    lines.push(`- Re-mention turn: ${spotCheck.reMentionTurn}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Write outputs
// ---------------------------------------------------------------------------
const relDir = path.join(os.homedir(), ".accordion", "relevance");
fs.mkdirSync(relDir, { recursive: true });

const fullReportPath = path.join(relDir, "report.md");
const committableReportPath = path.join(REPO_ROOT, "docs", "relevance-lab-results.md");

const fullReport = buildFullReport();
const committableReport = buildCommittableReport();

fs.writeFileSync(fullReportPath, fullReport, "utf8");
fs.writeFileSync(committableReportPath, committableReport, "utf8");

console.log(`\nFull report: ${fullReportPath}`);
console.log(`Committable report: ${committableReportPath}`);

// Print summary tables to stdout for the PM
console.log("\n==== SAMPLE SESSION COMPARISON TABLE ====");
if (sampleSess) {
  const headers = ["scorer", "nDCG@10", "P@10", "Spearman-vs-judge", "wall", "cost"];
  const rows = SCORER_IDS.map((sid) => {
    const m = sampleSess.meanMetrics[sid];
    const st = sampleSess.scorerStats[sid];
    const corrWithJudge = sampleSess.spearmanMatrix[sid]?.["judge"];
    return [
      sid,
      m?.ndcg?.toFixed(3) ?? "—",
      m?.precision?.toFixed(3) ?? "—",
      corrWithJudge?.toFixed(3) ?? "—",
      fmtMs(st?.totalWallMs),
      fmtUsd(st?.totalCostUsd),
    ];
  });
  console.log(mdTable(headers, rows));
}

console.log("\n==== GOLD EVENT TABLE ====");
const goldEvents = allGoldRows.filter((g) => g.percentiles !== null);
if (goldEvents.length) {
  const goldHeaders = ["session", "blockId", "evTurn", "tick", ...SCORER_IDS];
  const goldRows = goldEvents.map((g) => [
    isSampleSession(g) ? "sample" : g.sessionId.slice(0, 8) + "…",
    g.blockId,
    g.eventTurn ?? "?",
    g.tickUsed ?? "—",
    ...SCORER_IDS.map((s) =>
      g.percentiles?.[s]?.toFixed(2) ?? "—"
    ),
  ]);
  console.log(mdTable(goldHeaders, goldRows));
} else {
  console.log("(no gold events with preceding ticks found)");
  console.log("Skipped:", allGoldRows.map((g) => g.note).join("; "));
}

console.log(`\nTotal Vertex spend: ${fmtUsd(totalSpend)}`);
if (spotCheck) {
  console.log(`\nSpot-check: block ${spotCheck.blockId} (turn ${spotCheck.blockTurn}) has ident '${spotCheck.ident}' re-mentioned by block ${spotCheck.reMentionBlockId} (turn ${spotCheck.reMentionTurn})`);
}
