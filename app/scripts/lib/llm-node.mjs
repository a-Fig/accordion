/**
 * llm-node.mjs — Node.js twin of app/src/lib/llm/gateway.ts.
 *
 * Same logical behavior as the webview gateway, but runs in plain Node (no
 * Tauri). Used by offline scripts and evals.
 *
 * Auth strategy:
 *   1. Try AI Studio (GEMINI_API_KEY from env or Windows registry HKCU\Environment).
 *   2. On 429 with "prepay"/"RESOURCE_EXHAUSTED" → mark aistudio dead for this process
 *      and fall back to Vertex AI (gcloud auth print-access-token, cached 45 min).
 *   3. On Vertex 401 → re-mint token once and retry.
 */

import { spawnSync, execFileSync } from "node:child_process";
import https from "node:https";

// ── Constants (mirror types.ts) ───────────────────────────────────────────────

const PROVIDER_MODELS = {
  aistudio: { summary: "gemini-flash-lite-latest", tick: "gemini-flash-latest" },
  vertex:   { summary: "gemini-2.5-flash-lite",    tick: "gemini-2.5-flash-lite" },
};

const VERTEX_PROJECT  = "runner-frontier-74255";
const VERTEX_LOCATION = "us-central1";

// ── Global state ──────────────────────────────────────────────────────────────

/** Simple usage counters exported for callers to print. */
export const usage = { calls: 0, inTokens: 0, outTokens: 0 };

/** When non-null, AI Studio prepay credits are depleted until this ms-epoch timestamp. */
let _aistudioDeadUntil = /** @type {number | null} */ (null);
/** 10-minute expiry for the "aistudio dead" flag so transient billing blips self-heal. */
const AISTUDIO_DEAD_TTL_MS = 10 * 60 * 1000;

/** Vertex OAuth token cache: { token, expiresAt (ms epoch) }. */
let _vertexToken = /** @type {{ token: string; expiresAt: number } | null} */ (null);
const VERTEX_TOKEN_TTL_MS = 45 * 60 * 1000; // 45 minutes

// ── Key resolution ────────────────────────────────────────────────────────────

function resolveGeminiKey() {
  // 1. Inherited env.
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  // 2. Windows registry (child shells don't inherit HKCU\Environment by default).
  try {
    const result = spawnSync(
      "reg",
      ["query", "HKCU\\Environment", "/v", "GEMINI_API_KEY"],
      { encoding: "utf8", timeout: 5000 }
    );
    if (result.status === 0 && result.stdout) {
      const m = result.stdout.match(/GEMINI_API_KEY\s+REG_\w+\s+(\S+)/);
      if (m) return m[1].trim();
    }
  } catch {
    // Not on Windows or reg not available — ignore.
  }
  return null;
}

// ── Vertex token ──────────────────────────────────────────────────────────────

function mintVertexToken() {
  // On Windows, gcloud is gcloud.cmd — use cmd /c to invoke it.
  const isWindows = process.platform === "win32";
  let result;
  if (isWindows) {
    result = spawnSync("cmd", ["/c", "gcloud", "auth", "print-access-token"], {
      encoding: "utf8",
      timeout: 30_000,
    });
  } else {
    result = spawnSync("gcloud", ["auth", "print-access-token"], {
      encoding: "utf8",
      timeout: 30_000,
    });
  }
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(
      `gcloud auth print-access-token failed: ${result.stderr || "(no output)"}`
    );
  }
  return result.stdout.trim();
}

function getVertexToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _vertexToken && _vertexToken.expiresAt > now + 60_000) {
    return _vertexToken.token;
  }
  const token = mintVertexToken();
  _vertexToken = { token, expiresAt: now + VERTEX_TOKEN_TTL_MS };
  return token;
}

// ── Low-level HTTP fetch ──────────────────────────────────────────────────────

/**
 * @param {string} url
 * @param {Record<string,string>} headers
 * @param {unknown} body
 * @returns {Promise<{ status: number; body: string }>}
 */
function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          ...headers,
        },
        timeout: 60_000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("HTTP request timed out")); });
    req.write(bodyStr);
    req.end();
  });
}

// ── Request body builder ──────────────────────────────────────────────────────

/**
 * Build the Gemini API request body.
 * @param {{ role: string; system?: string; user: string; jsonSchema?: unknown; maxOutputTokens?: number }} req
 */
function buildBody(req) {
  /** @type {Record<string, unknown>} */
  const body = {
    contents: [{ role: "user", parts: [{ text: req.user }] }],
  };
  if (req.system) {
    body.systemInstruction = { parts: [{ text: req.system }] };
  }
  /** @type {Record<string, unknown>} */
  const genConfig = {};
  if (req.maxOutputTokens) genConfig.maxOutputTokens = req.maxOutputTokens;
  if (req.jsonSchema) {
    genConfig.responseMimeType = "application/json";
    genConfig.responseSchema = req.jsonSchema;
  }
  if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig;
  return body;
}

// ── Parse provider response ───────────────────────────────────────────────────

/**
 * @param {string} rawBody
 * @param {string} model
 * @param {"aistudio"|"vertex"} provider
 */
function parseResponse(rawBody, model, provider) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw Object.assign(new Error("parse: invalid JSON from provider"), { kind: "parse" });
  }
  const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw Object.assign(
      new Error(`parse: unexpected response shape — ${rawBody.slice(0, 200)}`),
      { kind: "parse" }
    );
  }
  const inTokens  = parsed?.usageMetadata?.promptTokenCount    ?? 0;
  const outTokens = parsed?.usageMetadata?.candidatesTokenCount ?? 0;
  return { text, inTokens, outTokens, model, provider };
}

// ── AI Studio call ────────────────────────────────────────────────────────────

/**
 * @param {string} apiKey
 * @param {string} model
 * @param {unknown} body
 * @returns {Promise<{ status: number; body: string }>}
 */
function callAiStudio(apiKey, model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  return httpPost(url, {}, body);
}

// ── Vertex AI call ────────────────────────────────────────────────────────────

/**
 * @param {string} token
 * @param {string} model
 * @param {unknown} body
 */
function callVertex(token, model, body) {
  const url =
    `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}` +
    `/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
  return httpPost(url, { Authorization: `Bearer ${token}` }, body);
}

// ── Prepay / quota error detection ───────────────────────────────────────────

/**
 * Returns true only when a 429 is caused by depleted prepay/billing credits.
 * A plain RESOURCE_EXHAUSTED / rate-limit is NOT a prepay signal — it's a
 * transient quota hit that should throw a quota error without killing the provider.
 * @param {number} status
 * @param {string} body
 */
function isPrepayError(status, body) {
  if (status !== 429) return false;
  const lower = body.toLowerCase();
  return lower.includes("prepay") || lower.includes("billing") || lower.includes("credits");
}

// ── Main generate function ────────────────────────────────────────────────────

/**
 * Generate text via the best available LLM backend.
 *
 * @param {{ role: "summary"|"tick"; system?: string; user: string; jsonSchema?: unknown; maxOutputTokens?: number }} req
 * @returns {Promise<{ text: string; inTokens: number; outTokens: number; model: string; provider: "aistudio"|"vertex" }>}
 */
export async function llmGenerate(req) {
  const body = buildBody(req);

  // ── Try AI Studio ──
  const aistudioAlive = _aistudioDeadUntil === null || Date.now() >= _aistudioDeadUntil;
  if (aistudioAlive) {
    const apiKey = resolveGeminiKey();
    if (apiKey) {
      const model = PROVIDER_MODELS.aistudio[req.role];
      const resp  = await callAiStudio(apiKey, model, body);

      if (resp.status === 200) {
        const result = parseResponse(resp.body, model, "aistudio");
        usage.calls++;
        usage.inTokens  += result.inTokens;
        usage.outTokens += result.outTokens;
        return result;
      }

      if (isPrepayError(resp.status, resp.body)) {
        // Prepay credits depleted — mark dead for 10 minutes and fall through to Vertex.
        _aistudioDeadUntil = Date.now() + AISTUDIO_DEAD_TTL_MS;
        console.warn("[llm-node] AI Studio prepay credits depleted; switching to Vertex AI for 10 min");
      } else if (resp.status === 429) {
        // Plain rate-limit (RESOURCE_EXHAUSTED, not billing) — throw quota without
        // killing the provider so the next call can still try AI Studio.
        throw Object.assign(
          new Error(`AI Studio HTTP ${resp.status}: ${resp.body.slice(0, 300)}`),
          { kind: "quota", statusCode: resp.status }
        );
      } else {
        // Other AI Studio error — surface it immediately.
        throw Object.assign(
          new Error(`AI Studio HTTP ${resp.status}: ${resp.body.slice(0, 300)}`),
          { kind: "http", statusCode: resp.status }
        );
      }
    }
  }

  // ── Try Vertex AI ──
  const model = PROVIDER_MODELS.vertex[req.role];
  let token = getVertexToken();

  let resp = await callVertex(token, model, body);

  // On 401, refresh token once and retry.
  if (resp.status === 401) {
    token = getVertexToken(/* forceRefresh */ true);
    resp  = await callVertex(token, model, body);
  }

  if (resp.status !== 200) {
    const kind = resp.status === 429 ? "quota" : "http";
    throw Object.assign(
      new Error(`Vertex AI HTTP ${resp.status}: ${resp.body.slice(0, 300)}`),
      { kind, statusCode: resp.status }
    );
  }

  const result = parseResponse(resp.body, model, "vertex");
  usage.calls++;
  usage.inTokens  += result.inTokens;
  usage.outTokens += result.outTokens;
  return result;
}
