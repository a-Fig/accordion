/*
 * vertex.mjs — shared Vertex AI client for the Relevance Lab.
 *
 * Exports:
 *   getAccessToken()   — gcloud-backed, cached ~45 min
 *   vertexFetch(model, method, body)  — POST with retry
 *   assertBudget(projectedUsd)        — throws BudgetExceededError if over $25
 *   spentTotal()                       — sum of all ledger entries
 *   PRICES                             — cost constants
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const PROJECT = "runner-frontier-74255";
export const REGION = "us-central1";
export const BASE_URL = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models`;

// Prices pinned 2026-06, conservative
export const PRICES = {
  "gemini-2.5-flash-lite": { inputPerM: 0.10, outputPerM: 0.40 },
  "text-embedding-005":    { inputPerM: 0.025, outputPerM: 0 },
};

// ---------------------------------------------------------------------------
// Spend ledger
// ---------------------------------------------------------------------------
const LEDGER_DIR = path.join(os.homedir(), ".accordion", "relevance");
const LEDGER_PATH = path.join(LEDGER_DIR, "spend.jsonl");
const BUDGET_LIMIT_USD = 25.00;

function ensureLedgerDir() {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
}

export function spentTotal() {
  ensureLedgerDir();
  if (!fs.existsSync(LEDGER_PATH)) return 0;
  let total = 0;
  const lines = fs.readFileSync(LEDGER_PATH, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      total += entry.usd ?? 0;
    } catch { /* ignore malformed lines */ }
  }
  return total;
}

function appendLedger(entry) {
  ensureLedgerDir();
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + "\n", "utf8");
}

export class BudgetExceededError extends Error {
  constructor(spent, projected) {
    super(
      `Budget exceeded: spent $${spent.toFixed(4)} + projected $${projected.toFixed(4)} > $${BUDGET_LIMIT_USD.toFixed(2)} limit`,
    );
    this.name = "BudgetExceededError";
  }
}

export function assertBudget(projectedUsd) {
  const spent = spentTotal();
  if (spent + projectedUsd > BUDGET_LIMIT_USD) {
    throw new BudgetExceededError(spent, projectedUsd);
  }
}

// ---------------------------------------------------------------------------
// Access token cache
// ---------------------------------------------------------------------------
let _cachedToken = null;
let _tokenExpiry = 0; // epoch ms

export function getAccessToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiry) return _cachedToken;

  const result = spawnSync("gcloud", ["auth", "print-access-token"], {
    shell: true,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`gcloud auth print-access-token failed: ${result.stderr}`);
  }
  _cachedToken = result.stdout.trim();
  _tokenExpiry = now + 45 * 60 * 1000; // 45 min
  return _cachedToken;
}

// ---------------------------------------------------------------------------
// vertexFetch — POST with retry
// ---------------------------------------------------------------------------
export async function vertexFetch(model, method, body) {
  const url = `${BASE_URL}/${model}:${method}`;
  const maxRetries = 3;
  let lastErr;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.pow(2, attempt) * 1000;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const token = getAccessToken();
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err;
      continue;
    }

    if (resp.ok) {
      return resp;
    }

    const text = await resp.text();
    if (resp.status === 429 || resp.status >= 500) {
      lastErr = new Error(`Vertex ${resp.status}: ${text}`);
      // If 401/403, refresh token on next attempt
      if (resp.status === 401 || resp.status === 403) {
        _cachedToken = null;
      }
      continue;
    }
    // Non-retryable error
    throw new Error(`Vertex ${resp.status}: ${text}`);
  }
  throw lastErr ?? new Error("vertexFetch: unknown failure after retries");
}

// ---------------------------------------------------------------------------
// recordSpend — helper for scorers
// ---------------------------------------------------------------------------
export function recordSpend({ model, inTokens, outTokens }) {
  const prices = PRICES[model] ?? { inputPerM: 0, outputPerM: 0 };
  const usd = (inTokens / 1e6) * prices.inputPerM + (outTokens / 1e6) * prices.outputPerM;
  appendLedger({
    ts: new Date().toISOString(),
    model,
    inTokens,
    outTokens,
    usd,
  });
  return usd;
}

// ---------------------------------------------------------------------------
// sha256 helper
// ---------------------------------------------------------------------------
export function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}
